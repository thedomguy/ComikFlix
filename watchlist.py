"""Watch list: the user's own list of series they've read, are reading or want to read.

An entry is the user's record, not a library series: their status for it, a star rating and
notes, plus a copy of the series' metadata (title, cover, ongoing/completed, ...). It may point
at an Asura series (source "asura", source_id = slug), downloaded or not, or at nothing at all
(source "manual": metadata typed in, or found by Jarvis/ChatGPT/Claude on the web). Adding an
entry never downloads chapters. When the Asura series is in the library, its live data wins
over the stored copy, which the background refresh keeps current.

Ratings are stored as half-stars 1-10 and exposed as stars 0.5-5.
"""
from __future__ import annotations

import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable

import db

STATUSES = ("reading", "plan", "completed")
# Series that are still being published: an entry for one can't be Completed.
CONTINUING = ("ongoing", "hiatus")
ENDED = ("completed", "dropped")
SERIES_STATUSES = CONTINUING + ENDED
# Other sources' words for the same thing (AniList, MangaUpdates, MangaDex, plain English).
_SERIES_STATUS_ALIASES = {
    "releasing": "ongoing", "publishing": "ongoing", "airing": "ongoing",
    "not_yet_released": "ongoing", "upcoming": "ongoing",
    "finished": "completed", "complete": "completed", "ended": "completed",
    "cancelled": "dropped", "canceled": "dropped", "discontinued": "dropped",
    "on hold": "hiatus", "paused": "hiatus",
}
TYPES = ("manhwa", "manga", "manhua", "webtoon", "comic", "novel", "other")
NOTES_MAX = 2000
REFRESH_AFTER = timedelta(days=3)
REFRESH_BATCH = 10

# Metadata a manual entry can set; for Asura entries it comes from the source.
META_TEXT = ("cover_url", "source_url", "type", "author", "artist", "description")
META_LISTS = ("genres", "alt_titles")


class WatchlistError(ValueError):
    """Bad input; `status` is the HTTP status the API should answer with."""

    def __init__(self, message: str, status: int = 400, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


# The table is created in db.SCHEMA_SQL.


# --------------------------------------------------------------------------- parsing

def norm_title(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def parse_status(value) -> str:
    v = str(value or "").strip().lower().replace("-", " ").replace("_", " ")
    v = {"plan to read": "plan", "planned": "plan", "planning": "plan", "currently reading": "reading",
         "read": "completed", "done": "completed", "finished": "completed"}.get(v, v)
    if v not in STATUSES:
        raise WatchlistError("status must be reading, plan or completed")
    return v


def parse_series_status(value) -> str | None:
    if value is None or str(value).strip() == "":
        return None
    v = str(value).strip().lower().replace("-", " ")
    v = _SERIES_STATUS_ALIASES.get(v, _SERIES_STATUS_ALIASES.get(v.replace(" ", "_"), v))
    if v not in SERIES_STATUSES:
        raise WatchlistError("series_status must be ongoing, hiatus, completed or dropped (or empty if unknown)")
    return v


def parse_rating(value) -> int | None:
    """Stars 0.5-5 in half steps -> half-stars 1-10. None/0/'' clears."""
    if value is None or value == "" or value == 0:
        return None
    try:
        stars = float(value)
    except (TypeError, ValueError):
        raise WatchlistError("rating must be a number of stars from 0.5 to 5")
    half = round(stars * 2)
    if abs(stars * 2 - half) > 1e-6 or not 1 <= half <= 10:
        raise WatchlistError("rating must be 0.5 to 5 stars in half steps")
    return half


def _text(value, limit: int = 500) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s[:limit] or None


def _url(value) -> str | None:
    s = _text(value, 2000)
    if s and not re.match(r"^https?://", s):
        raise WatchlistError("URLs must start with http:// or https://")
    return s


def _str_list(value, name: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [v for v in re.split(r"[,•]", value)]
    if not isinstance(value, list):
        raise WatchlistError(f"{name} must be a list of strings")
    return [s for s in (str(v).strip()[:120] for v in value) if s][:30]


def _chapters_total(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        raise WatchlistError("chapters_total must be a whole number")
    if n < 0 or n > 100000:
        raise WatchlistError("chapters_total is out of range")
    return n or None


def manual_meta(data: dict) -> dict:
    """Metadata fields from an API body (only the keys present)."""
    out: dict = {}
    for k in META_TEXT:
        if k in data:
            out[k] = _url(data[k]) if k.endswith("_url") else _text(data[k], 5000 if k == "description" else 200)
    if "type" in out and out["type"]:
        out["type"] = out["type"].lower()
        if out["type"] not in TYPES:
            raise WatchlistError(f"type must be one of {', '.join(TYPES)}")
    for k in META_LISTS:
        if k in data:
            out[k] = _str_list(data[k], k)
    if "series_status" in data:
        out["series_status"] = parse_series_status(data["series_status"])
    if "chapters_total" in data:
        out["chapters_total"] = _chapters_total(data["chapters_total"])
    return out


def _chapter_count(chapters: list[dict]) -> int | None:
    """Latest chapter number on the source (chapters aren't always numbered from 1)."""
    best = 0.0
    for c in chapters or []:
        try:
            best = max(best, float(c.get("number") if isinstance(c, dict) else c))
        except (TypeError, ValueError):
            continue
    return int(best) or None


def meta_from_info(info: dict) -> dict:
    """ingest.fetch_series_info() -> stored metadata."""
    try:
        series_status = parse_series_status(info.get("status"))
    except WatchlistError:
        series_status = None
    return {
        "title": _text(info.get("title"), 200),
        "source_url": _text(info.get("source_url"), 2000),
        "cover_url": _text(info.get("cover_url"), 2000),
        "series_status": series_status,
        "type": _text(info.get("type"), 40),
        "author": _text(info.get("author"), 200),
        "artist": _text(info.get("artist"), 200),
        "description": _text(info.get("description"), 5000),
        "genres": [g for g in info.get("genres") or [] if g],
        "alt_titles": [t for t in info.get("alt_titles") or [] if t],
        "chapters_total": _chapter_count(info.get("chapters") or []),
    }


def meta_from_library(s: dict) -> dict:
    """A /api/library series -> stored metadata."""
    try:
        series_status = parse_series_status(s.get("status"))
    except WatchlistError:
        series_status = None
    chapters = s.get("chapters") or []
    latest = _chapter_count([{"number": c.get("id")} for c in chapters])
    return {
        "title": s.get("title"),
        "source_url": s.get("source_url"),
        "cover_url": s.get("poster"),
        "series_status": series_status,
        "type": s.get("type"),
        "author": s.get("author"),
        "artist": s.get("artist"),
        "description": s.get("description"),
        "genres": s.get("genres") or [],
        "alt_titles": s.get("alt_titles") or [],
        "chapters_total": max(latest or 0, s.get("remote_total") or 0) or None,
    }


# --------------------------------------------------------------------------- rows

def _row_meta(row) -> dict:
    return {
        "title": row["title"], "source_url": row["source_url"], "cover_url": row["cover_url"],
        "series_status": row["series_status"], "type": row["type"], "author": row["author"],
        "artist": row["artist"], "description": row["description"],
        "genres": db._loads(row["genres_json"], []) or [],
        "alt_titles": db._loads(row["alt_titles_json"], []) or [],
        "chapters_total": row["chapters_total"],
    }


def _meta_columns(meta: dict) -> dict:
    cols = {k: v for k, v in meta.items() if k not in META_LISTS}
    if "genres" in meta:
        cols["genres_json"] = db._dumps(meta["genres"] or [])
    if "alt_titles" in meta:
        cols["alt_titles_json"] = db._dumps(meta["alt_titles"] or [])
    return cols


def _get_row(conn, entry_id: str):
    return conn.execute("SELECT * FROM watchlist WHERE id = ?", (entry_id,)).fetchone()


def _require(conn, entry_id: str):
    row = _get_row(conn, str(entry_id))
    if not row:
        raise WatchlistError("no watch list entry with that id", 404)
    return row


def _duplicate(conn, titles: list[str], skip_id: str | None = None):
    """An existing entry whose title or alt titles match any of `titles`."""
    wanted = {norm_title(t) for t in titles if norm_title(t)}
    if not wanted:
        return None
    for row in conn.execute("SELECT * FROM watchlist").fetchall():
        if row["id"] == skip_id:
            continue
        names = [row["title"], *(db._loads(row["alt_titles_json"], []) or [])]
        if wanted & {norm_title(n) for n in names}:
            return row
    return None


def _check_completed(status: str, series_status: str | None, title: str) -> None:
    if status == "completed" and series_status in CONTINUING:
        raise WatchlistError(
            f"{title} is still {series_status}, so it can't be Completed yet; keep it in Reading",
            409, code="series_continuing",
        )


# --------------------------------------------------------------------------- read

def _library_index(library: list[dict]) -> dict[str, dict]:
    return {s["slug"]: s for s in library or []}


def suggestion(status: str, series_status: str | None, lib: dict | None, prog: dict | None) -> dict | None:
    """A one-tap status change worth offering; never applied automatically.

    - Plan to Read, and reading has started in the app -> Reading.
    - Not Completed, the series has ended, it's in the library and the last chapter (with
      nothing left unfetched on the source) has been read -> Completed.
    - Completed, but the series is publishing again -> Reading."""
    if status == "completed":
        if series_status in CONTINUING:
            return {"status": "reading", "reason": f"The series is {series_status} again"}
        return None
    if status == "plan" and prog and (prog.get("read_at") or prog.get("read")):
        return {"status": "reading", "reason": "You've started reading it"}
    if series_status in ENDED and lib and prog:
        chapters = lib.get("chapters") or []
        remote = lib.get("remote_total")
        caught_up = bool(chapters) and chapters[-1]["id"] in set(prog.get("read") or [])
        if caught_up and (remote is None or len(chapters) >= remote):
            return {"status": "completed", "reason": "You've read every chapter"}
    return None


def to_api(row, lib_index: dict[str, dict], progress: dict[str, dict]) -> dict:
    meta = _row_meta(row)
    slug = row["source_id"] if row["source"] == "asura" else None
    lib = lib_index.get(slug) if slug else None
    if lib:
        meta = {**meta, **{k: v for k, v in meta_from_library(lib).items() if v not in (None, [])}}
    prog = progress.get(slug) if slug else None
    return {
        "id": row["id"],
        "title": meta["title"] or row["title"],
        "status": row["status"],
        "rating": row["rating"] / 2 if row["rating"] else None,
        "notes": row["notes"],
        "source": row["source"],
        "asura_slug": slug,
        "in_library": bool(lib),
        **{k: meta[k] for k in ("source_url", "cover_url", "series_status", "type", "author", "artist",
                                "description", "genres", "alt_titles", "chapters_total")},
        "progress": {
            "chapter": prog.get("chapter"),
            "read_count": len(prog.get("read") or []),
            "read_at": prog.get("read_at"),
        } if prog else None,
        "suggestion": suggestion(row["status"], meta["series_status"], lib, prog),
        "status_at": row["status_at"],
        "metadata_at": row["metadata_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_entries(library: list[dict], progress: dict[str, dict]) -> list[dict]:
    idx = _library_index(library)
    rows = db.get_conn().execute("SELECT * FROM watchlist ORDER BY updated_at DESC").fetchall()
    return [to_api(r, idx, progress) for r in rows]


def get_entry(entry_id: str, library: list[dict], progress: dict[str, dict]) -> dict:
    return to_api(_require(db.get_conn(), entry_id), _library_index(library), progress)


# --------------------------------------------------------------------------- write

FetchInfo = Callable[[str], dict]


def _asura_meta(slug: str, library: list[dict], fetch: FetchInfo) -> tuple[str, dict]:
    """(current slug, metadata) for an Asura series: from the library when downloaded,
    else scraped from Asura without touching the library."""
    lib = _library_index(library).get(slug)
    if lib:
        return slug, meta_from_library(lib)
    try:
        info = fetch(slug)
    except Exception as e:
        raise WatchlistError(f"Could not read {slug} on Asura Scans: {e}", 502)
    return info["slug"], meta_from_info(info)


def _parse_asura(value) -> str:
    import ingest  # heavy imports (Pillow, R2); only needed for Asura entries

    try:
        return ingest.parse_slug(str(value))
    except ValueError as e:
        raise WatchlistError(str(e))


def _default_fetch(slug: str) -> dict:
    import ingest

    return ingest.fetch_series_info(slug)


def add_entry(data: dict, library: list[dict], progress: dict[str, dict], fetch: FetchInfo | None = None) -> dict:
    """POST /api/watchlist. Either `asura` (slug or URL; metadata is read from the library or
    Asura) or `title` plus optional metadata. status defaults to plan."""
    if not isinstance(data, dict):
        raise WatchlistError("expected a JSON object")
    status = parse_status(data.get("status") or "plan")
    rating = parse_rating(data.get("rating"))
    notes = _text(data.get("notes"), NOTES_MAX)
    now = db._now()

    if data.get("asura"):
        slug, meta = _asura_meta(_parse_asura(data["asura"]), library, fetch or _default_fetch)
        source, source_id = "asura", slug
        if not meta.get("title"):
            meta["title"] = re.sub(r"-[0-9a-f]{8}$", "", slug).replace("-", " ").title()
    else:
        title = _text(data.get("title"), 200)
        if not title:
            raise WatchlistError("give a title (or an Asura series)")
        meta = {**manual_meta(data), "title": title}
        source, source_id = "manual", None

    with db.transaction() as conn:
        if source_id:
            row = conn.execute("SELECT * FROM watchlist WHERE source = 'asura' AND source_id = ?", (source_id,)).fetchone()
            if row:
                raise WatchlistError(f"{row['title']} is already on your watch list", 409, id=row["id"])
        dup = _duplicate(conn, [meta["title"], *(meta.get("alt_titles") or [])])
        if dup:
            hint = " (link it to Asura instead)" if source == "asura" and dup["source"] == "manual" else ""
            raise WatchlistError(f"{dup['title']} is already on your watch list{hint}", 409, id=dup["id"])
        _check_completed(status, meta.get("series_status"), meta["title"])
        entry_id = uuid.uuid4().hex[:12]
        cols = {
            "id": entry_id, "status": status, "rating": rating, "notes": notes,
            "source": source, "source_id": source_id,
            **_meta_columns({k: meta.get(k) for k in ("title", "series_status", "chapters_total", *META_TEXT, *META_LISTS)}),
            "metadata_at": now, "status_at": now, "created_at": now, "updated_at": now,
        }
        conn.execute(
            f"INSERT INTO watchlist ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            tuple(cols.values()),
        )
    return get_entry(entry_id, library, progress)


def update_entry(entry_id: str, data: dict, library: list[dict], progress: dict[str, dict],
                 fetch: FetchInfo | None = None) -> dict:
    """PATCH /api/watchlist/<id>: status, rating, notes; `asura` links an Asura series (null
    unlinks, keeping the metadata copy); title and metadata only for manual entries."""
    if not isinstance(data, dict):
        raise WatchlistError("expected a JSON object")
    now = db._now()
    with db.transaction() as conn:
        row = _require(conn, entry_id)
        cols: dict = {}
        source = row["source"]
        if "asura" in data:
            if data["asura"]:
                slug, meta = _asura_meta(_parse_asura(data["asura"]), library, fetch or _default_fetch)
                other = conn.execute(
                    "SELECT id, title FROM watchlist WHERE source = 'asura' AND source_id = ? AND id != ?",
                    (slug, row["id"]),
                ).fetchone()
                if other:
                    raise WatchlistError(f"{other['title']} is already on your watch list", 409, id=other["id"])
                cols.update(source="asura", source_id=slug, metadata_at=now,
                            **_meta_columns({k: v for k, v in meta.items() if v not in (None, [])}))
                source = "asura"
            elif source == "asura":
                cols.update(source="manual", source_id=None)
                source = "manual"
        meta_in = manual_meta(data)
        if "title" in data:
            title = _text(data["title"], 200)
            if not title:
                raise WatchlistError("title can't be empty")
            meta_in["title"] = title
        if meta_in:
            if source != "manual":
                raise WatchlistError("this entry's details come from Asura Scans; unlink it (asura: null) to edit them")
            if "title" in meta_in or "alt_titles" in meta_in:
                dup = _duplicate(conn, [meta_in.get("title") or row["title"], *(meta_in.get("alt_titles") or [])], row["id"])
                if dup:
                    raise WatchlistError(f"{dup['title']} is already on your watch list", 409, id=dup["id"])
            cols.update(_meta_columns(meta_in), metadata_at=now)
        if "status" in data:
            status = parse_status(data["status"])
            if status != row["status"]:
                cols.update(status=status, status_at=now)
        if "rating" in data:
            cols["rating"] = parse_rating(data["rating"])
        if "notes" in data:
            cols["notes"] = _text(data["notes"], NOTES_MAX)

        merged = {**dict(row), **cols}
        slug = merged["source_id"] if merged["source"] == "asura" else None
        lib = _library_index(library).get(slug) if slug else None
        series_status = (meta_from_library(lib)["series_status"] if lib else None) or merged["series_status"]
        if "status" in cols:
            _check_completed(merged["status"], series_status, merged["title"])
        if cols:
            cols["updated_at"] = now
            conn.execute(
                f"UPDATE watchlist SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?",
                (*cols.values(), row["id"]),
            )
    return get_entry(row["id"], library, progress)


def remove_entry(entry_id: str) -> bool:
    with db.transaction() as conn:
        return conn.execute("DELETE FROM watchlist WHERE id = ?", (str(entry_id),)).rowcount > 0


def refresh_entry(entry_id: str, library: list[dict], progress: dict[str, dict], fetch: FetchInfo | None = None) -> dict:
    """Re-read an Asura entry's metadata (library first, else Asura). Manual entries have
    nothing to refresh from and are returned unchanged."""
    row = _require(db.get_conn(), entry_id)
    entry_id = row["id"]
    if row["source"] == "asura":
        slug, meta = _asura_meta(row["source_id"], library, fetch or _default_fetch)
        with db.transaction() as conn:
            if slug != row["source_id"]:
                move(conn, row["source_id"], slug)
                # move() may have merged this entry into one already filed under the new slug
                entry_id = conn.execute("SELECT id FROM watchlist WHERE source = 'asura' AND source_id = ?",
                                        (slug,)).fetchone()["id"]
            cols = {**_meta_columns({k: v for k, v in meta.items() if v not in (None, [])}), "metadata_at": db._now()}
            conn.execute(
                f"UPDATE watchlist SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?",
                (*cols.values(), entry_id),
            )
    return get_entry(entry_id, library, progress)


def move(conn, old: str, new: str) -> None:
    """Asura moved a series to a new slug (inside the caller's transaction). If both slugs
    have an entry, the new one keeps its fields and takes the old one's rating/notes where
    it has none."""
    old_row = conn.execute("SELECT * FROM watchlist WHERE source = 'asura' AND source_id = ?", (old,)).fetchone()
    if not old_row or old == new:
        return
    new_row = conn.execute("SELECT * FROM watchlist WHERE source = 'asura' AND source_id = ?", (new,)).fetchone()
    if not new_row:
        conn.execute("UPDATE watchlist SET source_id = ? WHERE id = ?", (new, old_row["id"]))
        return
    conn.execute(
        "UPDATE watchlist SET rating = COALESCE(rating, ?), notes = COALESCE(notes, ?) WHERE id = ?",
        (old_row["rating"], old_row["notes"], new_row["id"]),
    )
    conn.execute("DELETE FROM watchlist WHERE id = ?", (old_row["id"],))


# --------------------------------------------------------------------------- background refresh

_refresh_lock = threading.Lock()


def refresh_stale(library: list[dict], fetch: FetchInfo | None = None, *, background: bool = True) -> int:
    """Refresh Asura entries whose metadata copy is older than REFRESH_AFTER (oldest first,
    REFRESH_BATCH at a time), so series status changes reach entries that aren't downloaded.
    At most one refresh runs; returns how many entries were due (0 when one is running)."""
    cutoff = (datetime.now(timezone.utc) - REFRESH_AFTER).isoformat()
    due = [r["id"] for r in db.get_conn().execute(
        "SELECT id FROM watchlist WHERE source = 'asura' AND (metadata_at IS NULL OR metadata_at < ?) "
        "ORDER BY metadata_at LIMIT ?", (cutoff, REFRESH_BATCH)).fetchall()]
    if not due or not _refresh_lock.acquire(blocking=False):
        return 0

    def run():
        try:
            for i, entry_id in enumerate(due):
                try:
                    refresh_entry(entry_id, library, {}, fetch)
                except Exception:
                    # Asura unreachable or the series gone: try again next round, not every request.
                    with db.transaction() as conn:
                        conn.execute("UPDATE watchlist SET metadata_at = ? WHERE id = ?", (db._now(), entry_id))
                if background and i + 1 < len(due):
                    time.sleep(1)  # be gentle with Asura
        finally:
            if background:
                db.close_thread_conn()
            _refresh_lock.release()

    if background:
        threading.Thread(target=run, name="watchlist-refresh", daemon=True).start()
    else:
        run()
    return len(due)
