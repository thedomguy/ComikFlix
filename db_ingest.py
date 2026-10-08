"""Ingest-facing DB helpers. Delegates to sibling `db.py` (SQLite/API owner).

Shared schema: series / chapters (status missing|ready|failed) / pages (r2_key, public_url).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import db


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_schema() -> None:
    db.init_schema()


def chapter_is_ready(slug: str, chapter_id: str) -> bool:
    """True when the chapter row exists with status='ready' (R2 upload done)."""
    ensure_schema()
    row = db.get_conn().execute(
        "SELECT status FROM chapters WHERE series_slug=? AND chapter_id=?",
        (slug, str(chapter_id)),
    ).fetchone()
    return bool(row and row["status"] == "ready")


def upsert_series(
    info: dict,
    *,
    cover_key: str | None = None,
    cover_url: str | None = None,
    release: dict | None = None,
    overwrite: bool = False,
) -> None:
    """Merge scraped series info into SQLite via db.upsert_series."""
    ensure_schema()
    slug = info["slug"]
    existing = db.get_conn().execute("SELECT * FROM series WHERE slug=?", (slug,)).fetchone()
    remote = [c["number"] for c in info.get("chapters") or [] if not c.get("locked")]
    locked = [c["number"] for c in info.get("chapters") or [] if c.get("locked")]

    if existing is None:
        row = {
            "slug": slug,
            "title": info.get("title"),
            "description": info.get("description"),
            "genres": info.get("genres") or [],
            "author": info.get("author"),
            "artist": info.get("artist"),
            "type": info.get("type"),
            "status": info.get("status"),
            "rating": info.get("rating"),
            "bookmarks": info.get("bookmarks"),
            "alt_titles": info.get("alt_titles") or [],
            "cover_key": cover_key,
            "cover_url": cover_url,
            "source_url": info.get("source_url"),
            "remote_chapters": remote,
            "locked_chapters": locked,
            "release": release,
            "release_date": None,
            "info_updated_at": _now(),
        }
    else:
        # Preserve hand-filled descriptive fields unless overwrite
        def keep(col: str, new_val: Any) -> Any:
            if overwrite or existing[col] in (None, ""):
                return new_val if new_val is not None else existing[col]
            return existing[col]

        genres = info.get("genres") or []
        alts = info.get("alt_titles") or []
        if not overwrite and existing["genres_json"]:
            genres = db._loads(existing["genres_json"], genres)
        if not overwrite and existing["alt_titles_json"]:
            alts = db._loads(existing["alt_titles_json"], alts)

        row = {
            "slug": slug,
            "title": keep("title", info.get("title")),
            "description": keep("description", info.get("description")),
            "genres": genres,
            "author": keep("author", info.get("author")),
            "artist": keep("artist", info.get("artist")),
            "type": keep("type", info.get("type")),
            "status": info.get("status") if info.get("status") is not None else existing["status"],
            "rating": info.get("rating") if info.get("rating") is not None else existing["rating"],
            "bookmarks": info.get("bookmarks") if info.get("bookmarks") is not None else existing["bookmarks"],
            "alt_titles": alts,
            "cover_key": cover_key if cover_key else existing["cover_key"],
            "cover_url": cover_url if cover_url else existing["cover_url"],
            "source_url": keep("source_url", info.get("source_url")),
            "remote_chapters": remote,
            "locked_chapters": locked,
            "release": release if release is not None else db._loads(existing["release_json"]),
            # Never clobber user-editable release_date from scrape
            "release_date": existing["release_date"],
            "info_updated_at": _now(),
        }
    db.upsert_series(row)


def upsert_chapter_row(
    slug: str,
    chapter_id: str,
    *,
    source_url: str | None = None,
    published_at: str | None = None,
    page_count: int | None = None,
    status: str = "missing",
    size_bytes: int | None = None,
) -> None:
    ensure_schema()
    existing = db.get_conn().execute(
        "SELECT * FROM chapters WHERE series_slug=? AND chapter_id=?",
        (slug, str(chapter_id)),
    ).fetchone()
    db.upsert_chapter({
        "series_slug": slug,
        "chapter_id": str(chapter_id),
        "source_url": source_url if source_url is not None else (existing["source_url"] if existing else None),
        "published_at": published_at if published_at is not None else (existing["published_at"] if existing else None),
        "page_count": page_count if page_count is not None else (existing["page_count"] if existing else None),
        "status": status,
        "size_bytes": size_bytes if size_bytes is not None else (existing["size_bytes"] if existing else None),
    })


def replace_pages(slug: str, chapter_id: str, pages: list[dict]) -> None:
    ensure_schema()
    db.replace_pages(slug, str(chapter_id), pages)


def mark_chapter_ready(
    slug: str,
    chapter_id: str,
    *,
    page_count: int,
    size_bytes: int,
    source_url: str | None = None,
    published_at: str | None = None,
    pages: list[dict] | None = None,
) -> None:
    upsert_chapter_row(
        slug, chapter_id,
        source_url=source_url, published_at=published_at,
        page_count=page_count, status="ready", size_bytes=size_bytes,
    )
    if pages is not None:
        replace_pages(slug, chapter_id, pages)


def mark_chapter_failed(
    slug: str,
    chapter_id: str,
    *,
    source_url: str | None = None,
    published_at: str | None = None,
) -> None:
    upsert_chapter_row(
        slug, chapter_id,
        source_url=source_url, published_at=published_at, status="failed",
    )
