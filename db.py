"""Thin SQLite persistence for ComikFlix metadata, settings, and progress.

Uses stdlib sqlite3 only. Swap call sites to Postgres later by replacing this module;
SQL is kept simple (no SQLite-only features beyond AUTOINCREMENT-free PKs).
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

HERE = Path(__file__).resolve().parent
DEFAULT_DB = HERE / "data" / "comikflix.db"

SETTINGS_KEYS = ("readerWidth", "sortNewest", "trayOpen", "dismissedJobs")
DEFAULT_SETTINGS = {
    "readerWidth": 800,
    "sortNewest": True,
    "trayOpen": True,
    "dismissedJobs": [],
}

_local = threading.local()
_db_path: Path | None = None
_init_lock = threading.Lock()


def db_path() -> Path:
    global _db_path
    if _db_path is not None:
        return _db_path
    env = os.environ.get("COMIKFLIX_DB", "").strip()
    return Path(env) if env else DEFAULT_DB


def set_db_path(path: Path | str | None) -> None:
    """Override DB path (tests / CLI). Pass None to reset to env/default."""
    global _db_path
    _db_path = Path(path) if path else None
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect(path: Path | None = None) -> sqlite3.Connection:
    p = Path(path) if path else db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        with _init_lock:
            conn = getattr(_local, "conn", None)
            if conn is None:
                conn = _connect()
                init_schema(conn)
                _local.conn = conn
    return conn


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS series (
    slug TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    genres_json TEXT,
    author TEXT,
    artist TEXT,
    type TEXT,
    status TEXT,
    rating REAL,
    bookmarks INTEGER,
    alt_titles_json TEXT,
    cover_key TEXT,
    cover_url TEXT,
    source_url TEXT,
    remote_chapters_json TEXT,
    locked_chapters_json TEXT,
    release_json TEXT,
    release_date TEXT,
    info_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    series_slug TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    source_url TEXT,
    published_at TEXT,
    page_count INTEGER,
    status TEXT NOT NULL DEFAULT 'missing',
    size_bytes INTEGER,
    PRIMARY KEY (series_slug, chapter_id),
    UNIQUE (series_slug, chapter_id),
    FOREIGN KEY (series_slug) REFERENCES series(slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pages (
    series_slug TEXT NOT NULL,
    chapter_id TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    r2_key TEXT,
    public_url TEXT,
    cdn_url TEXT,
    aspect_ratio TEXT,
    alt TEXT,
    PRIMARY KEY (series_slug, chapter_id, page_index),
    UNIQUE (series_slug, chapter_id, page_index),
    FOREIGN KEY (series_slug, chapter_id)
        REFERENCES chapters(series_slug, chapter_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS progress (
    series_slug TEXT PRIMARY KEY,
    chapter TEXT,
    frac REAL,
    read_json TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_series ON chapters(series_slug);
CREATE INDEX IF NOT EXISTS idx_pages_chapter ON pages(series_slug, chapter_id);
"""


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """Additive migrations for existing DBs (CREATE IF NOT EXISTS won't alter)."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(pages)")}
    if "cdn_url" not in cols:
        conn.execute("ALTER TABLE pages ADD COLUMN cdn_url TEXT")


def init_schema(conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    c.executescript(SCHEMA_SQL)
    _ensure_columns(c)
    c.commit()


def _dumps(obj: Any) -> str | None:
    if obj is None:
        return None
    return json.dumps(obj, ensure_ascii=False)


def _loads(text: str | None, default: Any = None) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


# ---- settings ----

def get_settings() -> dict:
    rows = get_conn().execute("SELECT key, value_json FROM settings").fetchall()
    out = dict(DEFAULT_SETTINGS)
    for row in rows:
        if row["key"] in SETTINGS_KEYS:
            out[row["key"]] = _loads(row["value_json"], out[row["key"]])
    return out


def put_settings(data: dict) -> dict:
    blob = dict(DEFAULT_SETTINGS)
    if "readerWidth" in data:
        try:
            w = float(data["readerWidth"])
            blob["readerWidth"] = int(max(400, min(1400, w)))
        except (TypeError, ValueError):
            pass
    if "sortNewest" in data:
        blob["sortNewest"] = bool(data["sortNewest"])
    if "trayOpen" in data:
        blob["trayOpen"] = bool(data["trayOpen"])
    if "dismissedJobs" in data:
        jobs = data["dismissedJobs"]
        if isinstance(jobs, list):
            blob["dismissedJobs"] = [str(x) for x in jobs][-200:]
    with transaction() as conn:
        for key in SETTINGS_KEYS:
            conn.execute(
                "INSERT INTO settings(key, value_json) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                (key, _dumps(blob[key])),
            )
    return get_settings()


# ---- progress ----

def get_progress() -> dict[str, dict]:
    rows = get_conn().execute(
        "SELECT series_slug, chapter, frac, read_json, updated_at FROM progress"
    ).fetchall()
    out: dict[str, dict] = {}
    for row in rows:
        # Frontend expects `at` (ms epoch-ish); store updated_at as ISO and also expose at.
        at = None
        try:
            at = int(datetime.fromisoformat(row["updated_at"]).timestamp() * 1000)
        except (TypeError, ValueError):
            at = None
        out[row["series_slug"]] = {
            "chapter": row["chapter"],
            "frac": row["frac"] if row["frac"] is not None else 0,
            "read": _loads(row["read_json"], []),
            "at": at,
        }
    return out


def put_progress_slug(slug: str, data: dict) -> dict:
    slug = str(slug)
    chapter = data.get("chapter")
    frac = data.get("frac", 0)
    try:
        frac = float(frac) if frac is not None else 0.0
    except (TypeError, ValueError):
        frac = 0.0
    read = data.get("read") or []
    if not isinstance(read, list):
        read = []
    at = data.get("at")
    if at is not None:
        try:
            updated = datetime.fromtimestamp(float(at) / 1000.0, timezone.utc).isoformat()
        except (TypeError, ValueError, OSError):
            updated = _now()
    else:
        updated = _now()
    with transaction() as conn:
        conn.execute(
            "INSERT INTO progress(series_slug, chapter, frac, read_json, updated_at) "
            "VALUES(?, ?, ?, ?, ?) "
            "ON CONFLICT(series_slug) DO UPDATE SET "
            "chapter = excluded.chapter, frac = excluded.frac, "
            "read_json = excluded.read_json, updated_at = excluded.updated_at",
            (slug, None if chapter is None else str(chapter), frac, _dumps(read), updated),
        )
    return get_progress().get(slug) or {
        "chapter": chapter,
        "frac": frac,
        "read": read,
        "at": at,
    }


def put_progress_all(data: dict) -> dict[str, dict]:
    """Replace/merge a full slug→entry map (PUT /api/progress)."""
    src = data.get("progress") if isinstance(data.get("progress"), dict) else data
    if not isinstance(src, dict):
        return get_progress()
    for slug, entry in src.items():
        if isinstance(entry, dict):
            put_progress_slug(str(slug), entry)
    return get_progress()


# ---- series / library ----

def upsert_series(row: dict) -> None:
    now = _now()
    slug = row["slug"]
    with transaction() as conn:
        existing = conn.execute("SELECT created_at FROM series WHERE slug = ?", (slug,)).fetchone()
        created = existing["created_at"] if existing else row.get("created_at") or now
        conn.execute(
            """
            INSERT INTO series (
                slug, title, description, genres_json, author, artist, type, status,
                rating, bookmarks, alt_titles_json, cover_key, cover_url, source_url,
                remote_chapters_json, locked_chapters_json, release_json, release_date,
                info_updated_at, created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?
            )
            ON CONFLICT(slug) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                genres_json = excluded.genres_json,
                author = excluded.author,
                artist = excluded.artist,
                type = excluded.type,
                status = excluded.status,
                rating = excluded.rating,
                bookmarks = excluded.bookmarks,
                alt_titles_json = excluded.alt_titles_json,
                cover_key = excluded.cover_key,
                cover_url = COALESCE(excluded.cover_url, series.cover_url),
                source_url = excluded.source_url,
                remote_chapters_json = excluded.remote_chapters_json,
                locked_chapters_json = excluded.locked_chapters_json,
                release_json = excluded.release_json,
                release_date = COALESCE(excluded.release_date, series.release_date),
                info_updated_at = excluded.info_updated_at,
                updated_at = excluded.updated_at
            """,
            (
                slug,
                row.get("title"),
                row.get("description"),
                _dumps(row.get("genres")),
                row.get("author"),
                row.get("artist"),
                row.get("type"),
                row.get("status"),
                row.get("rating"),
                row.get("bookmarks"),
                _dumps(row.get("alt_titles")),
                row.get("cover_key"),
                row.get("cover_url"),
                row.get("source_url"),
                _dumps(row.get("remote_chapters")),
                _dumps(row.get("locked_chapters")),
                _dumps(row.get("release")),
                row.get("release_date"),
                row.get("info_updated_at"),
                created,
                row.get("updated_at") or now,
            ),
        )


def upsert_chapter(row: dict) -> None:
    with transaction() as conn:
        conn.execute(
            """
            INSERT INTO chapters (
                series_slug, chapter_id, source_url, published_at, page_count, status, size_bytes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(series_slug, chapter_id) DO UPDATE SET
                source_url = excluded.source_url,
                published_at = excluded.published_at,
                page_count = excluded.page_count,
                status = excluded.status,
                size_bytes = excluded.size_bytes
            """,
            (
                row["series_slug"],
                str(row["chapter_id"]),
                row.get("source_url"),
                row.get("published_at"),
                row.get("page_count"),
                row.get("status") or "missing",
                row.get("size_bytes"),
            ),
        )


def replace_pages(series_slug: str, chapter_id: str, pages: list[dict]) -> None:
    chapter_id = str(chapter_id)
    with transaction() as conn:
        conn.execute(
            "DELETE FROM pages WHERE series_slug = ? AND chapter_id = ?",
            (series_slug, chapter_id),
        )
        conn.executemany(
            """
            INSERT INTO pages (
                series_slug, chapter_id, page_index, r2_key, public_url, cdn_url,
                aspect_ratio, alt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    series_slug,
                    chapter_id,
                    int(p["page_index"]),
                    p.get("r2_key"),
                    p.get("public_url"),
                    p.get("cdn_url"),
                    p.get("aspect_ratio"),
                    p.get("alt"),
                )
                for p in pages
            ],
        )


def set_page_cdn_url(series_slug: str, chapter_id: str, page_index: int, cdn_url: str | None) -> None:
    with transaction() as conn:
        conn.execute(
            """
            UPDATE pages SET cdn_url = ?
            WHERE series_slug = ? AND chapter_id = ? AND page_index = ?
            """,
            (cdn_url, series_slug, str(chapter_id), int(page_index)),
        )


def patch_series(slug: str, fields: dict) -> dict | None:
    """Update editable series fields. Currently: release_date."""
    allowed = {}
    if "release_date" in fields:
        val = fields["release_date"]
        if val is None or val == "":
            allowed["release_date"] = None
        else:
            allowed["release_date"] = str(val)
    if not allowed:
        row = get_conn().execute("SELECT slug FROM series WHERE slug = ?", (slug,)).fetchone()
        return {"slug": slug} if row else None
    allowed["updated_at"] = _now()
    sets = ", ".join(f"{k} = ?" for k in allowed)
    with transaction() as conn:
        cur = conn.execute(
            f"UPDATE series SET {sets} WHERE slug = ?",
            (*allowed.values(), slug),
        )
        if cur.rowcount == 0:
            return None
    return {"slug": slug, **{k: allowed[k] for k in allowed if k != "updated_at"}}


def list_series_rows() -> list[sqlite3.Row]:
    return get_conn().execute(
        "SELECT * FROM series ORDER BY title COLLATE NOCASE, slug"
    ).fetchall()


def list_chapters(series_slug: str) -> list[sqlite3.Row]:
    return get_conn().execute(
        "SELECT * FROM chapters WHERE series_slug = ? ORDER BY CAST(chapter_id AS REAL), chapter_id",
        (series_slug,),
    ).fetchall()


def list_pages(series_slug: str, chapter_id: str) -> list[sqlite3.Row]:
    return get_conn().execute(
        "SELECT * FROM pages WHERE series_slug = ? AND chapter_id = ? ORDER BY page_index",
        (series_slug, str(chapter_id)),
    ).fetchall()


def series_count() -> int:
    row = get_conn().execute("SELECT COUNT(*) AS n FROM series").fetchone()
    return int(row["n"]) if row else 0
