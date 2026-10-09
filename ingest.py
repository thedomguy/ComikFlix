#!/usr/bin/env python3
"""Centralised ingestion: series slug -> SQLite metadata + Asura CDN page URLs.

Usage:
    ./ingest.py SERIES_SLUG_OR_URL --start N [--latest M] [-w WORKERS]

1. Fetches https://asurascans.com/comics/<slug> and extracts series info + chapter list.
   Metadata is written to SQLite (via db_ingest / sibling db.py).
2. For each unlocked chapter from --start through --latest (or remote latest): fetch
   chapter HTML, record page CDN URLs + aspect ratios in SQLite. No image download
   and no R2 upload (reader serves Asura CDN directly for now).

R2 upload remains available via sync_library.py --download for a later cutover.

Re-running skips chapters already marked ready in the DB. Jobs stay in-memory
(IngestManager); they are not persisted.
"""
import argparse
import copy
import html as htmllib
import json
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from difflib import SequenceMatcher
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import asura_chapter_pages as asura
import db
import db_ingest
import download
import optimize_images
import r2

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"  # legacy; no longer the library of record
BASE = "https://asurascans.com"
SERIES_URL = BASE + "/comics/{slug}"
CHAPTER_URL = BASE + "/comics/{slug}/chapter/{chapter}"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
MAX_CHAPTERS = 5000
FETCH_DELAY = 0.5  # seconds after a chapter HTML/download attempt
MAX_LOG = 300
MAX_JOBS = 20
PERSIST_EVERY = 2.0  # seconds between download-history saves while a job runs
CHAPTER_CONCURRENCY = 2  # polite parallel chapter downloads
OPT_WORKERS = min(4, max(1, (os.cpu_count() or 4)))
IMG_EXTS = {".webp", ".png", ".jpg", ".jpeg", ".gif"}

# --------------------------------------------------------------------------- series info

ISLAND_RE = re.compile(r'<astro-island\b[^>]*?\sprops="([^"]*)"')
CHAPTER_LINK_RE = re.compile(r'href="/comics/[^"/]+/chapter/([0-9]+(?:\.[0-9]+)?)"')


def parse_slug(value: str) -> str:
    """Accept a bare slug or any asurascans.com/comics/<slug>[/...] URL."""
    value = value.strip()
    if "/" in value:
        parts = urlparse(value if "//" in value else "//" + value).path.strip("/").split("/")
        if "comics" in parts and parts.index("comics") + 1 < len(parts):
            value = parts[parts.index("comics") + 1]
    value = value.lower()
    if not SLUG_RE.match(value):
        raise ValueError("Invalid series slug (expected e.g. childhood-friend-of-the-zenith-bd5bdaf8)")
    return value


def _unwrap(v):
    """Astro serialises island props as [0, scalar] and [1, [items]]."""
    if isinstance(v, list) and len(v) == 2 and v[0] in (0, 1):
        return [_unwrap(x) for x in v[1]] if v[0] == 1 else _unwrap(v[1])
    if isinstance(v, dict):
        return {k: _unwrap(x) for k, x in v.items()}
    return v


def _islands(page: str):
    for m in ISLAND_RE.finditer(page):
        try:
            props = _unwrap(json.loads(htmllib.unescape(m.group(1))))
        except ValueError:
            continue
        if isinstance(props, dict):
            yield props


def _text(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    fragment = fragment.replace("</p>", "\n\n")
    text = htmllib.unescape(re.sub(r"<[^>]+>", "", fragment))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _parse_iso(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def _label(number) -> str:
    return str(int(number)) if float(number).is_integer() else str(number)


def fetch_series_info(slug: str) -> dict:
    """Scrape the series page. Raises if the series can't be found."""
    url = SERIES_URL.format(slug=slug)
    page = asura.fetch_html(url)

    series = chapters = None
    for props in _islands(page):
        if series is None and "bookmarkCount" in props and "title" in props:
            series = props
        raw = props.get("chapters")
        if chapters is None and isinstance(raw, list) and raw and isinstance(raw[0], dict) and "number" in raw[0]:
            chapters = raw

    if chapters is None:  # fall back to plain chapter links (no dates)
        chapters = [{"number": float(n)} for n in sorted(set(CHAPTER_LINK_RE.findall(page)), key=float)]
    if series is None and not chapters:
        raise RuntimeError("series not found (page has no series data)")
    series = series or {}

    title = series.get("title")
    if not title:
        m = re.search(r"<title>([^<|]*)", page)
        title = htmllib.unescape(m.group(1)).strip() if m else None

    now = datetime.now(timezone.utc)
    chapter_list = []
    for c in chapters:
        if c.get("number") is None:
            continue
        until = _parse_iso(c.get("early_access_until"))
        chapter_list.append({
            "number": _label(c["number"]),
            "published_at": c.get("published_at"),
            "page_count": c.get("page_count"),
            "locked": bool(c.get("is_premium")) or bool(until and until > now),
        })
    chapter_list.sort(key=lambda c: float(c["number"]))

    return {
        "slug": slug,
        "source_url": url,
        "title": title,
        "description": _text(series.get("description") or ""),
        "alt_titles": [t.strip() for t in (series.get("alternativeTitles") or "").split("•") if t.strip()],
        "cover_url": series.get("coverUrl"),
        "rating": series.get("rating"),
        "bookmarks": series.get("bookmarkCount"),
        "status": series.get("status"),
        "type": series.get("type"),
        "author": series.get("author"),
        "artist": series.get("artist"),
        "genres": [g["name"] for g in series.get("genres") or [] if isinstance(g, dict) and g.get("name")],
        "chapters": chapter_list,
    }


def estimate_release(chapters: list[dict], status: str | None) -> dict | None:
    """Forecast the next chapter of an ongoing series from its recent release cadence.

    Takes the last 10 chapters, collapses same-day batches, and uses the median gap between
    release days as the interval (median, so one long hiatus doesn't skew it). Used later to
    schedule automatic syncs. Returns None for finished/hiatus series or too little history.
    """
    if (status or "").lower() != "ongoing":
        return None
    stamps = sorted(d for d in (_parse_iso(c.get("published_at")) for c in chapters) if d)
    if len(stamps) < 3:
        return None
    recent = stamps[-10:]
    days = sorted({d.date() for d in recent})
    gaps = sorted((b - a).days for a, b in zip(days, days[1:]))
    if not gaps:
        return None
    mid = len(gaps) // 2
    interval = gaps[mid] if len(gaps) % 2 else (gaps[mid - 1] + gaps[mid]) / 2
    interval = min(max(interval, 1), 30)
    last = stamps[-1]
    return {
        "interval_days": round(interval, 1),
        "last_published": last.isoformat(),
        "next_expected": (last + timedelta(days=interval)).isoformat(),
        "based_on": len(recent),
    }


def _upload_cover(client: r2.R2Client, slug: str, cover_url: str) -> tuple[str, str] | None:
    """Download cover to a temp file, upload to R2, return (key, public_url)."""
    ext = Path(urlparse(cover_url).path).suffix or ".webp"
    key = r2.cover_key(slug, ext)
    with tempfile.TemporaryDirectory(prefix="comikflix-cover-") as tmp:
        dest = Path(tmp) / f"cover{ext}"
        download.download(cover_url, dest, BASE + "/", 3)
        # Prefer webp when optimize succeeds; otherwise upload original bytes/ext.
        try:
            summary = optimize_images.optimize_chapter(Path(tmp), workers=1)
            if summary["failed"] == 0:
                webps = sorted(Path(tmp).glob("cover*.webp"))
                if webps:
                    dest = webps[0]
                    key = r2.cover_key(slug, ".webp")
        except Exception:
            pass
        ctype = "image/webp" if dest.suffix.lower() == ".webp" else None
        url = client.upload_file(dest, key, content_type=ctype)
        return key, url


def _asura_cdn_slug(slug: str) -> str:
    return re.sub(r"-[0-9a-f]{8}$", "", slug)


def _chapter_source_url(slug: str, chapter: str) -> str:
    return CHAPTER_URL.format(slug=slug, chapter=chapter)


def _page_cdn_url(slug: str, chapter: str, page_index: int, src: str | None = None) -> str:
    if src and str(src).startswith("http"):
        return src
    return (
        f"https://cdn.asurascans.com/asura-images/chapters/"
        f"{_asura_cdn_slug(slug)}/{chapter}/{int(page_index) + 1:03d}.webp"
    )


def save_series_info(
    info: dict,
    overwrite: bool = False,
    client: r2.R2Client | None = None,
    *,
    upload_cover: bool = False,
) -> None:
    """Persist scraped series metadata + chapter/source/cover URLs to SQLite.

    Always records the Asura cover URL and per-chapter source URLs. Optionally
    uploads the cover to R2 when upload_cover=True and a client is available
    (stores r2 key in cover_key; cover_url stays the Asura source for CDN reading).

    Descriptive fields only fill when missing unless overwrite=True; volatile fields
    (status, rating, chapter lists, release forecast) always refresh.
    """
    cover_src = info.get("cover_url")  # Asura/original cover
    cover_key = None
    if upload_cover and cover_src:
        try:
            cli = client or r2.get_client()
            uploaded = _upload_cover(cli, info["slug"], cover_src)
            if uploaded:
                cover_key, _r2_url = uploaded
        except Exception:
            pass  # cover upload is cosmetic

    release = estimate_release(info["chapters"], info.get("status"))
    db_ingest.upsert_series(
        info,
        cover_key=cover_key,
        cover_url=cover_src,  # always the remote Asura/source cover URL
        release=release,
        overwrite=overwrite,
    )
    _sync_chapter_metadata(info, overwrite=overwrite)


def _sync_chapter_metadata(info: dict, *, overwrite: bool = False) -> None:
    """Upsert chapter rows (source_url, dates, page stubs with CDN urls)."""
    slug = info["slug"]
    for c in info.get("chapters") or []:
        number = c.get("number")
        if number is None or c.get("locked"):
            continue
        chapter_id = str(number)
        source_url = _chapter_source_url(slug, chapter_id)
        published = c.get("published_at")
        page_count = c.get("page_count")
        try:
            page_count = int(page_count) if page_count not in (None, "") else None
        except (TypeError, ValueError):
            page_count = None

        existing = db.get_conn().execute(
            "SELECT status, page_count FROM chapters WHERE series_slug=? AND chapter_id=?",
            (slug, chapter_id),
        ).fetchone()
        status = existing["status"] if existing else "missing"
        if page_count is None and existing and existing["page_count"]:
            page_count = existing["page_count"]

        db_ingest.upsert_chapter_row(
            slug,
            chapter_id,
            source_url=source_url,
            published_at=published,
            page_count=page_count,
            status=status,
        )

        # Ensure unprocessed chapters have CDN page rows so the reader can render.
        existing_pages = db.list_pages(slug, chapter_id)
        if existing_pages:
            # Backfill missing cdn_url / keep existing r2 fields untouched.
            pages = []
            changed = False
            for pg in existing_pages:
                cdn = pg["cdn_url"] if "cdn_url" in pg.keys() else None
                if not cdn:
                    cdn = _page_cdn_url(slug, chapter_id, pg["page_index"])
                    changed = True
                pages.append({
                    "page_index": pg["page_index"],
                    "r2_key": pg["r2_key"],
                    "public_url": pg["public_url"],
                    "cdn_url": cdn,
                    "aspect_ratio": pg["aspect_ratio"],
                    "alt": pg["alt"],
                })
            if changed:
                db_ingest.replace_pages(slug, chapter_id, pages)
        elif page_count and page_count > 0:
            db_ingest.replace_pages(
                slug,
                chapter_id,
                [
                    {
                        "page_index": i,
                        "r2_key": None,
                        "public_url": None,
                        "cdn_url": _page_cdn_url(slug, chapter_id, i),
                        "aspect_ratio": None,
                        "alt": None,
                    }
                    for i in range(page_count)
                ],
            )


# --------------------------------------------------------------------------- chapters

def chapter_complete(slug: str, chapter: str) -> bool:
    """True when SQLite has this chapter with status='ready' (CDN metadata recorded)."""
    return db_ingest.chapter_is_ready(slug, chapter)


def _page_files(chap_dir: Path) -> list[Path]:
    files = [
        p for p in chap_dir.iterdir()
        if p.is_file() and p.suffix.lower() in IMG_EXTS and p.stat().st_size > 0
        and not p.name.startswith(".")
    ]
    files.sort(key=lambda p: p.name)
    return files


def ingest_chapter_metadata(
    slug: str,
    chapter: str,
    progress=None,
    published_at: str | None = None,
    timeout: float = 30.0,
) -> int:
    """Fetch chapter HTML and record Asura CDN page URLs in SQLite (no download/R2).

    Returns page count. Raises on failure.
    """
    url = CHAPTER_URL.format(slug=slug, chapter=chapter)
    pages_meta = asura.extract_pages(asura.fetch_html(url, timeout=timeout))
    if not pages_meta:
        raise RuntimeError("no reader pages found on chapter page")

    pages = []
    for p in pages_meta:
        page_index = int(p["page_index"])
        aspect = (p.get("aspect_ratio") or "").replace(" ", "") or None
        pages.append({
            "page_index": page_index,
            "r2_key": None,
            "public_url": None,
            "cdn_url": _page_cdn_url(slug, str(chapter), page_index, p.get("src")),
            "aspect_ratio": aspect,
            "alt": p.get("alt"),
        })
    pages.sort(key=lambda row: row["page_index"])
    if progress:
        progress(len(pages), len(pages))

    db_ingest.mark_chapter_ready(
        slug, str(chapter),
        page_count=len(pages),
        size_bytes=0,
        source_url=url,
        published_at=published_at,
        pages=pages,
    )
    return len(pages)


def ingest_chapter(
    slug: str,
    chapter: str,
    workers: int,
    client: r2.R2Client,
    progress=None,
    retries: int = 3,
    published_at: str | None = None,
) -> int:
    """Fetch one chapter into a temp dir, optimize, upload to R2, write DB rows.

    Opt-in path (e.g. sync_library.py --download). Default ingest uses
    ingest_chapter_metadata instead. Returns page count. Raises on failure.
    Temp files are always deleted.
    """
    url = CHAPTER_URL.format(slug=slug, chapter=chapter)
    pages_meta = asura.extract_pages(asura.fetch_html(url))
    if not pages_meta:
        raise RuntimeError("no reader pages found on chapter page")
    manifest = asura.build_result(url, pages_meta)
    manifest["series_slug"], manifest["chapter"] = slug, str(chapter)

    aspect_by_index = {
        int(p["page_index"]): (p.get("aspect_ratio") or "").replace(" ", "") or None
        for p in manifest.get("pages") or []
    }
    alt_by_index = {
        int(p["page_index"]): p.get("alt")
        for p in manifest.get("pages") or []
    }
    cdn_by_index = {
        int(p["page_index"]): p.get("src")
        for p in manifest.get("pages") or []
        if p.get("src")
    }

    tmp_root = Path(tempfile.mkdtemp(prefix=f"comikflix-{slug}-ch{chapter}-"))
    try:
        jobs = download.build_jobs(manifest, tmp_root)
        chap_dir = jobs[0][1].parent
        chap_dir.mkdir(parents=True, exist_ok=True)
        total, done, failed = len(jobs), 0, []
        if progress:
            progress(0, total)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(download.download, u, d, url, retries): u for u, d in jobs}
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as e:
                    failed.append(f"{futures[fut]}: {e}")
                done += 1
                if progress:
                    progress(done, total)
        if failed:
            raise RuntimeError(f"{len(failed)}/{total} images failed ({failed[0]})")

        try:
            optimize_images.optimize_chapter(chap_dir, workers=OPT_WORKERS)
        except Exception:
            pass  # upload originals if optimize unavailable

        page_files = _page_files(chap_dir)
        if not page_files:
            raise RuntimeError("no page images after download")

        uploaded_pages = []
        size_bytes = 0
        for i, path in enumerate(page_files):
            page_num = i + 1  # 1-based for R2 key
            page_index = page_num - 1  # 0-based in DB
            # Prefer numeric stem if download used padded names
            stem = path.stem
            if stem.isdigit():
                page_num = int(stem)
                page_index = page_num - 1
            key = r2.page_key(slug, str(chapter), page_num)
            pub = client.upload_file(
                path, key,
                content_type="image/webp" if path.suffix.lower() == ".webp" else None,
            )
            size_bytes += path.stat().st_size
            uploaded_pages.append({
                "page_index": page_index,
                "r2_key": key,
                "public_url": pub,
                "cdn_url": cdn_by_index.get(page_index),
                "aspect_ratio": aspect_by_index.get(page_index),
                "alt": alt_by_index.get(page_index),
            })

        db_ingest.mark_chapter_ready(
            slug, str(chapter),
            page_count=len(uploaded_pages),
            size_bytes=size_bytes,
            source_url=url,
            published_at=published_at,
            pages=uploaded_pages,
        )
        return len(uploaded_pages)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _error_text(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return "not available (404)" if e.code == 404 else f"HTTP {e.code}"
    return str(e) or e.__class__.__name__


# --------------------------------------------------------------------------- catalog

CATALOG_TTL = 6 * 3600
_catalog: dict = {"at": 0.0, "slugs": []}
_catalog_lock = threading.Lock()


def _words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", ""))


def catalog_search(query: str, limit: int = 8) -> list[dict]:
    """Find Asura series by title. The /comics page lists the whole catalogue (its search
    parameter is ignored), so match the query against slug words locally; cached 6h."""
    with _catalog_lock:
        if time.time() - _catalog["at"] > CATALOG_TTL or not _catalog["slugs"]:
            page = asura.fetch_html(f"{BASE}/comics")
            _catalog["slugs"] = sorted(set(re.findall(r"/comics/([a-z0-9-]+-[0-9a-f]{8})", page)))
            _catalog["at"] = time.time()
        slugs = list(_catalog["slugs"])
    q = _words(query)
    if not q:
        return []
    out = []
    for slug in slugs:
        name = re.sub(r"-[0-9a-f]{8}$", "", slug)
        words = name.split("-")
        overlap = sum(1 for w in q if w in words) / len(q)
        ratio = SequenceMatcher(None, " ".join(q), " ".join(words)).ratio()
        score = round(0.6 * overlap + 0.4 * ratio, 3)
        if score >= 0.35:
            out.append({
                "slug": slug,
                "title": " ".join(words).title(),
                "url": f"{BASE}/comics/{slug}",
                "score": score,
            })
    return sorted(out, key=lambda r: -r["score"])[:limit]


# --------------------------------------------------------------------------- jobs

class IngestManager:
    """Runs ingestion jobs on background threads and exposes their state as JSON-able dicts.

    Job states: running, done, partial (some chapters failed), cancelled, error (couldn't
    even read the series). retry() re-runs failed/unprocessed chapters of a finished job.

    For now each chapter only records Asura CDN page URLs (no binary download / R2).
    Completion is tracked via SQLite chapter status='ready'.
    """

    def __init__(self, workers: int = 8):
        self.workers = workers
        self._jobs: dict[str, dict] = {}
        self._cancels: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    # -- public API

    def start(
        self,
        slug: str,
        start_chapter: int | float | str,
        latest: int | None = None,
        source: str = "app",
        tags: list[str] | None = None,
    ) -> dict:
        """source: who asked ("app", "jarvis:chatgpt", ...); tags are kept with the job's history."""
        slug = parse_slug(slug)
        try:
            start = float(start_chapter)
        except (TypeError, ValueError) as e:
            raise ValueError("start_chapter must be a number") from e
        if start < 0 or start > MAX_CHAPTERS:
            raise ValueError(f"start_chapter must be between 0 and {MAX_CHAPTERS}")
        if latest is not None and not 1 <= latest <= MAX_CHAPTERS:
            raise ValueError(f"Latest chapter must be between 1 and {MAX_CHAPTERS}")
        if latest is not None and float(latest) < start:
            raise ValueError("latest must be >= start_chapter")
        with self._lock:
            if any(j["slug"] == slug and j["state"] == "running" for j in self._jobs.values()):
                raise ValueError("An ingestion for this series is already running")
            job = {
                "id": uuid.uuid4().hex[:8],
                "slug": slug,
                "title": None,
                "start_chapter": _label(start),
                "start": start,
                "latest": latest,
                "state": "running",
                "stage": "Fetching series info",
                "started": time.time(),
                "finished": None,
                "error": None,
                "chapters": {},
                "log": [],
                "source": source,
                "tags": tags or [],
            }
            self._jobs[job["id"]] = job
            self._cancels[job["id"]] = threading.Event()
            for old in sorted(self._jobs.values(), key=lambda j: j["started"])[:-MAX_JOBS]:
                if old["state"] != "running":
                    self._jobs.pop(old["id"], None)
                    self._cancels.pop(old["id"], None)
        self._spawn(job, self._run)
        return self.snapshot(job["id"])

    def retry(self, job_id: str, chapter: str | None = None) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                raise KeyError(job_id)
            if job["state"] == "running":
                raise ValueError("Job is still running")
            if any(j["slug"] == job["slug"] and j["state"] == "running" for j in self._jobs.values()):
                raise ValueError("An ingestion for this series is already running")
            if job["chapters"]:
                numbers = [chapter] if chapter else [n for n, c in job["chapters"].items() if c["state"] in ("failed", "queued")]
                numbers = [n for n in numbers if n in job["chapters"] and job["chapters"][n]["state"] in ("failed", "queued")]
                if not numbers:
                    raise ValueError("Nothing to retry")
                target = lambda j, nums=numbers: self._process(j, nums)  # noqa: E731
            else:
                target = self._run  # failed before the chapter list was known
            job.update(state="running", finished=None, error=None, stage="Retrying")
            self._cancels[job_id] = threading.Event()
        self._log(job, "info", "Retrying" + (f" chapter {chapter}" if chapter else " failed/unprocessed chapters"))
        self._spawn(job, target)
        return self.snapshot(job_id)

    def cancel(self, job_id: str) -> bool:
        ev = self._cancels.get(job_id)
        if ev:
            ev.set()
        return ev is not None

    def snapshot(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return copy.deepcopy(job) if job else None

    def list(self, log_lines: int = 80) -> list[dict]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: -j["started"])
            out = []
            for j in jobs:
                snap = copy.deepcopy(j)
                snap["log"] = snap["log"][-log_lines:]
                out.append(snap)
            return out

    # -- internals

    def _spawn(self, job: dict, target) -> None:
        done = threading.Event()

        def runner():
            try:
                target(job)
            except Exception as e:  # keep the job inspectable instead of dying silently
                self._log(job, "error", f"Unexpected error: {_error_text(e)}")
                with self._lock:
                    job.update(state="error", error=_error_text(e), finished=time.time())
            finally:
                done.set()
                db.close_thread_conn()

        def persister():
            # The download history (db.ingest_jobs) is written from this one thread only:
            # on start, every couple of seconds while running, and once more at the end.
            try:
                while True:
                    finished = done.wait(PERSIST_EVERY)
                    with self._lock:
                        snap = copy.deepcopy(job)
                    try:
                        db.save_ingest_job(snap)
                    except Exception:
                        pass  # history is best-effort; never break a download over it
                    if finished:
                        return
            finally:
                db.close_thread_conn()

        try:
            with self._lock:
                snap = copy.deepcopy(job)
            db.save_ingest_job(snap)
        except Exception:
            pass
        threading.Thread(target=runner, daemon=True).start()
        threading.Thread(target=persister, daemon=True).start()

    def _log(self, job: dict, level: str, msg: str) -> None:
        with self._lock:
            job["log"].append({"t": time.time(), "level": level, "msg": msg})
            del job["log"][:-MAX_LOG]

    def _set(self, job: dict, number: str, **fields) -> None:
        with self._lock:
            job["chapters"][number].update(fields)

    def _run(self, job: dict) -> None:
        slug = job["slug"]

        self._log(job, "info", f"Fetching series info for {slug}")
        try:
            info = fetch_series_info(slug)
            save_series_info(info)  # metadata + CDN stubs; no R2
        except Exception as e:
            self._log(job, "error", f"Could not read series: {_error_text(e)}")
            with self._lock:
                job.update(state="error", error=_error_text(e), finished=time.time(), stage="Failed")
            return

        chapters = info["chapters"]
        start = float(job["start"])
        chapters = [c for c in chapters if float(c["number"]) >= start]
        if job["latest"] is not None:
            chapters = [c for c in chapters if float(c["number"]) <= job["latest"]]
        locked = [c for c in chapters if c["locked"]]
        with self._lock:
            job["title"] = info["title"]
            job["chapters"] = {
                c["number"]: {
                    "state": "locked" if c["locked"] else "queued",
                    "done": 0, "total": 0, "pages": None, "error": None,
                    "started": None, "finished": None, "date": c.get("published_at"),
                }
                for c in chapters
            }

        self._log(job, "info", f"{info['title']}: {len(chapters)} chapters from {job['start_chapter']}"
                  + (f" to {job['latest']}" if job["latest"] is not None else " to latest")
                  + (f", {len(locked)} locked (premium/early access, skipped)" if locked else ""))
        self._process(job, [c["number"] for c in chapters if not c["locked"]])

    def _one_chapter(self, job: dict, number: str, cancel: threading.Event) -> None:
        slug = job["slug"]
        if cancel.is_set():
            return
        with self._lock:
            job["stage"] = f"Chapter {number}"
        if chapter_complete(slug, number):
            self._set(job, number, state="cached")
            self._log(job, "info", f"Chapter {number}: already ready (CDN)")
            return

        t0 = time.time()
        published = None
        with self._lock:
            published = (job["chapters"].get(number) or {}).get("date")
        self._set(job, number, state="running", started=t0, finished=None, error=None, done=0, total=0)
        self._log(job, "info", f"Chapter {number}: fetching CDN pages")

        def progress(done, total, n=number):
            self._set(job, n, done=done, total=total)

        try:
            pages = ingest_chapter_metadata(
                slug, number, progress, published_at=published,
            )
            self._set(job, number, state="done", pages=pages, done=pages, total=pages, finished=time.time())
            self._log(job, "info", f"Chapter {number}: {pages} CDN pages in {time.time() - t0:.1f}s")
        except Exception as e:
            try:
                db_ingest.mark_chapter_failed(slug, number, published_at=published)
            except Exception:
                pass
            self._set(job, number, state="failed", error=_error_text(e), finished=time.time())
            self._log(job, "error", f"Chapter {number}: {_error_text(e)}")
        finally:
            db.close_thread_conn()  # pool threads would otherwise each keep a connection open
        if not cancel.is_set():
            time.sleep(FETCH_DELAY)

    def _process(self, job: dict, numbers: list[str]) -> None:
        cancel = self._cancels[job["id"]]
        pending = []
        for number in numbers:
            if cancel.is_set():
                break
            if chapter_complete(job["slug"], number):
                self._set(job, number, state="cached")
                self._log(job, "info", f"Chapter {number}: already ready (CDN)")
            else:
                pending.append(number)

        if pending and not cancel.is_set():
            with ThreadPoolExecutor(max_workers=CHAPTER_CONCURRENCY) as pool:
                futs = [pool.submit(self._one_chapter, job, n, cancel) for n in pending]
                for fut in as_completed(futs):
                    fut.result()

        with self._lock:
            states = [c["state"] for c in job["chapters"].values()]
            if cancel.is_set():
                state = "cancelled"
            elif "failed" in states:
                state = "partial"
            else:
                state = "done"
            job.update(state=state, finished=time.time(), stage={
                "done": "Complete", "partial": "Finished with failures", "cancelled": "Cancelled",
            }[state])
        ok = states.count("done")
        self._log(job, "info", f"Finished: {ok} indexed, {states.count('cached')} already ready, "
                  f"{states.count('failed')} failed" + (", cancelled" if cancel.is_set() else ""))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("series", help="series slug or asurascans.com comic URL")
    ap.add_argument("--start", "--start-chapter", dest="start_chapter", required=True,
                    help="first chapter to ingest (inclusive)")
    ap.add_argument("--latest", type=int, help="only chapters up to and including this number")
    ap.add_argument("-w", "--workers", type=int, default=8)
    args = ap.parse_args()

    mgr = IngestManager(args.workers)
    job = mgr.start(args.series, start_chapter=args.start_chapter, latest=args.latest)
    seen = 0
    while True:
        snap = mgr.snapshot(job["id"])
        for line in snap["log"][seen:]:
            print(f"[{time.strftime('%H:%M:%S', time.localtime(line['t']))}] {line['msg']}")
        seen = len(snap["log"])
        if snap["state"] != "running":
            return 0 if snap["state"] == "done" else 1
        time.sleep(0.5)


if __name__ == "__main__":
    raise SystemExit(main())
