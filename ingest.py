#!/usr/bin/env python3
"""Centralised ingestion: series slug -> series info + every available chapter.

Usage:
    ./ingest.py SERIES_SLUG_OR_URL [--latest N] [-o OUT_DIR] [-w WORKERS]

1. Fetches https://asurascans.com/comics/<slug> and extracts the series info (title,
   synopsis, genres, author, artist, status, rating, cover) and the full chapter list
   with publish dates. Everything is saved to downloads/<slug>/series.json.
2. Downloads every chapter that isn't already complete. Chapters that are locked
   (premium / early access) are listed but skipped. --latest N limits it to chapters <= N.

Re-running is the "update" operation: finished chapters are skipped, new ones are fetched.
Also imported by server.py, which runs jobs in the background (see IngestManager).
"""
import argparse
import copy
import html as htmllib
import json
import os
import re
import threading
import time
import urllib.error
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import asura_chapter_pages as asura
import download
import optimize_images

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"
BASE = "https://asurascans.com"
SERIES_URL = BASE + "/comics/{slug}"
CHAPTER_URL = BASE + "/comics/{slug}/chapter/{chapter}"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
MAX_CHAPTERS = 5000
FETCH_DELAY = 0.5  # seconds after a chapter HTML/download attempt
MAX_LOG = 300
MAX_JOBS = 20
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


def save_series_info(info: dict, out_root: Path, overwrite: bool = False) -> None:
    """Merge scraped info into downloads/<slug>/series.json.

    Descriptive fields (title, description, genres, ...) are only filled in when missing so
    hand edits survive; volatile fields (status, rating, chapter dates) always refresh.
    overwrite=True replaces the descriptive fields and re-downloads the cover too.
    """
    series_dir = out_root / info["slug"]
    series_dir.mkdir(parents=True, exist_ok=True)
    path = series_dir / "series.json"
    try:
        meta = json.loads(path.read_text())
    except (OSError, ValueError):
        meta = {}

    cover = info.get("cover_url")
    if cover and (overwrite or not (meta.get("cover") and (series_dir / meta["cover"]).exists())):
        dest = series_dir / f"cover{Path(urlparse(cover).path).suffix or '.webp'}"
        if overwrite:
            dest.unlink(missing_ok=True)  # download() skips files that already exist
        try:
            download.download(cover, dest, BASE + "/", 3)
            meta["cover"] = dest.name
        except Exception:
            pass  # a missing cover is cosmetic

    for key in ("title", "description", "genres", "author", "artist", "type", "alt_titles", "source_url"):
        if (overwrite or not meta.get(key)) and info.get(key):
            meta[key] = info[key]
    for key in ("status", "rating", "bookmarks"):
        if info.get(key) is not None:
            meta[key] = info[key]
    meta["chapter_dates"] = {c["number"]: c["published_at"] for c in info["chapters"] if c.get("published_at")}
    meta["remote_chapters"] = [c["number"] for c in info["chapters"] if not c["locked"]]
    meta["locked_chapters"] = [c["number"] for c in info["chapters"] if c["locked"]]
    release = estimate_release(info["chapters"], meta.get("status"))
    if release:
        meta["release"] = release
    else:
        meta.pop("release", None)  # finished, on hiatus, or not enough history
    meta["info_updated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(meta, indent=2, ensure_ascii=False))


# --------------------------------------------------------------------------- chapters

def chapter_complete(slug: str, chapter: str, out_root: Path) -> bool:
    """True when manifest exists and enough non-empty page images are on disk."""
    chap_dir = out_root / slug / f"chapter-{chapter}"
    try:
        manifest = json.loads((chap_dir / "manifest.json").read_text())
        expected = int(manifest.get("page_count") or len(manifest.get("pages") or []))
    except (OSError, ValueError, TypeError):
        return False
    if expected <= 0:
        return False
    try:
        present = sum(
            1
            for p in chap_dir.iterdir()
            if p.is_file() and p.suffix.lower() in IMG_EXTS and p.stat().st_size > 0
        )
    except OSError:
        return False
    return present >= expected


def ingest_chapter(slug: str, chapter: str, out_root: Path, workers: int, progress=None, retries: int = 3) -> int:
    """Fetch one chapter; returns its page count. Raises on failure.

    progress(done, total) is called as images finish.
    """
    url = CHAPTER_URL.format(slug=slug, chapter=chapter)
    pages = asura.extract_pages(asura.fetch_html(url))
    if not pages:
        raise RuntimeError("no reader pages found on chapter page")
    manifest = asura.build_result(url, pages)
    manifest["series_slug"], manifest["chapter"] = slug, str(chapter)

    jobs = download.build_jobs(manifest, out_root)
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
    # Written last, so a chapter with a manifest.json is known to be complete.
    (chap_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    return total


def _error_text(e: Exception) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return "not available (404)" if e.code == 404 else f"HTTP {e.code}"
    return str(e) or e.__class__.__name__


# --------------------------------------------------------------------------- jobs

class IngestManager:
    """Runs ingestion jobs on background threads and exposes their state as JSON-able dicts.

    Job states: running, done, partial (some chapters failed), cancelled, error (couldn't
    even read the series). retry() re-runs failed/unprocessed chapters of a finished job.
    """

    def __init__(self, out_root: Path = DOWNLOADS, workers: int = 8):
        self.out_root, self.workers = out_root, workers
        self._jobs: dict[str, dict] = {}
        self._cancels: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    # -- public API

    def start(self, slug: str, latest: int | None = None) -> dict:
        slug = parse_slug(slug)
        if latest is not None and not 1 <= latest <= MAX_CHAPTERS:
            raise ValueError(f"Latest chapter must be between 1 and {MAX_CHAPTERS}")
        with self._lock:
            if any(j["slug"] == slug and j["state"] == "running" for j in self._jobs.values()):
                raise ValueError("An ingestion for this series is already running")
            job = {"id": uuid.uuid4().hex[:8], "slug": slug, "title": None, "latest": latest, "state": "running",
                   "stage": "Fetching series info", "started": time.time(), "finished": None, "error": None,
                   "chapters": {}, "log": []}
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
        def runner():
            try:
                target(job)
            except Exception as e:  # keep the job inspectable instead of dying silently
                self._log(job, "error", f"Unexpected error: {_error_text(e)}")
                with self._lock:
                    job.update(state="error", error=_error_text(e), finished=time.time())
        threading.Thread(target=runner, daemon=True).start()

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
            save_series_info(info, self.out_root)
        except Exception as e:
            self._log(job, "error", f"Could not read series: {_error_text(e)}")
            with self._lock:
                job.update(state="error", error=_error_text(e), finished=time.time(), stage="Failed")
            return

        chapters = info["chapters"]
        if job["latest"] is not None:
            chapters = [c for c in chapters if float(c["number"]) <= job["latest"]]
        locked = [c for c in chapters if c["locked"]]
        with self._lock:
            job["title"] = info["title"]
            job["chapters"] = {c["number"]: {"state": "locked" if c["locked"] else "queued", "done": 0, "total": 0,
                                             "pages": None, "error": None, "started": None, "finished": None,
                                             "date": c.get("published_at")} for c in chapters}
        self._log(job, "info", f"{info['title']}: {len(chapters)} chapters"
                  + (f", {len(locked)} locked (premium/early access, skipped)" if locked else ""))
        self._process(job, [c["number"] for c in chapters if not c["locked"]])

    def _optimize_chapter(self, job: dict, number: str) -> None:
        chap_dir = self.out_root / job["slug"] / f"chapter-{number}"
        try:
            summary = optimize_images.optimize_chapter(chap_dir, workers=OPT_WORKERS)
        except Exception as e:
            self._log(job, "error", f"Chapter {number}: optimize failed ({_error_text(e)}) — keeping downloads")
            return
        if summary["failed"]:
            self._log(
                job,
                "error",
                f"Chapter {number}: optimize partial ({summary['failed']} failed, "
                f"{summary['optimized']} optimized)",
            )
            return
        saved = summary["original_bytes"] - summary["optimized_bytes"]
        self._log(
            job,
            "info",
            f"Chapter {number}: optimized {summary['optimized']}/{summary['images']} images "
            f"({optimize_images.fmt_bytes(summary['original_bytes'])} → "
            f"{optimize_images.fmt_bytes(summary['optimized_bytes'])}, "
            f"saved {optimize_images.fmt_bytes(max(0, saved))})",
        )

    def _one_chapter(self, job: dict, number: str, cancel: threading.Event) -> None:
        slug = job["slug"]
        if cancel.is_set():
            return
        with self._lock:
            job["stage"] = f"Chapter {number}"
        if chapter_complete(slug, number, self.out_root):
            self._set(job, number, state="cached")
            self._log(job, "info", f"Chapter {number}: already downloaded")
            return

        t0 = time.time()
        self._set(job, number, state="running", started=t0, finished=None, error=None, done=0, total=0)
        self._log(job, "info", f"Chapter {number}: fetching")

        def progress(done, total, n=number):
            self._set(job, n, done=done, total=total)

        try:
            pages = ingest_chapter(slug, number, self.out_root, self.workers, progress)
            self._set(job, number, state="done", pages=pages, done=pages, total=pages, finished=time.time())
            self._log(job, "info", f"Chapter {number}: {pages} pages in {time.time() - t0:.1f}s")
            self._optimize_chapter(job, number)
        except Exception as e:
            self._set(job, number, state="failed", error=_error_text(e), finished=time.time())
            self._log(job, "error", f"Chapter {number}: {_error_text(e)}")
        # Pace origin after a real network attempt (not after cache hits).
        if not cancel.is_set():
            time.sleep(FETCH_DELAY)

    def _process(self, job: dict, numbers: list[str]) -> None:
        cancel = self._cancels[job["id"]]
        pending = []
        for number in numbers:
            if cancel.is_set():
                break
            if chapter_complete(job["slug"], number, self.out_root):
                self._set(job, number, state="cached")
                self._log(job, "info", f"Chapter {number}: already downloaded")
            else:
                pending.append(number)

        if pending and not cancel.is_set():
            with ThreadPoolExecutor(max_workers=CHAPTER_CONCURRENCY) as pool:
                futs = [pool.submit(self._one_chapter, job, n, cancel) for n in pending]
                for fut in as_completed(futs):
                    fut.result()  # surface unexpected errors to _spawn

        with self._lock:
            states = [c["state"] for c in job["chapters"].values()]
            if cancel.is_set():
                state = "cancelled"
            elif "failed" in states:
                state = "partial"
            else:
                state = "done"
            job.update(state=state, finished=time.time(), stage={"done": "Complete", "partial": "Finished with failures",
                                                                  "cancelled": "Cancelled"}[state])
        ok = states.count("done")
        self._log(job, "info", f"Finished: {ok} downloaded, {states.count('cached')} already had, "
                  f"{states.count('failed')} failed" + (", cancelled" if cancel.is_set() else ""))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("series", help="series slug or asurascans.com comic URL")
    ap.add_argument("--latest", type=int, help="only chapters up to and including this number")
    ap.add_argument("-o", "--out", type=Path, default=DOWNLOADS)
    ap.add_argument("-w", "--workers", type=int, default=8)
    args = ap.parse_args()

    mgr = IngestManager(args.out, args.workers)
    job = mgr.start(args.series, args.latest)
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
