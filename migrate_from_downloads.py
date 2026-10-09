#!/usr/bin/env python3
"""One-shot import of downloads/*/series.json + chapter manifests into SQLite.

Does not delete or modify downloads/. Pages without R2 stay public_url=NULL and
chapter status='missing'; cdn_url comes from the manifest's scraped src only (pages
without one are left out; the reader captures them when the chapter is opened).

Usage:
    .venv/bin/python migrate_from_downloads.py [--db PATH] [--downloads PATH]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import db

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"
IMG_EXTS = {".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif"}


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def natural_chapter_key(name: str) -> float:
    m = re.search(r"chapter-(.+)$", name)
    try:
        return float(m.group(1)) if m else float("inf")
    except ValueError:
        return float("inf")


def import_series(series_dir: Path) -> dict:
    slug = series_dir.name
    meta = read_json(series_dir / "series.json")
    dates = meta.get("chapter_dates") or {}
    cover_key = meta.get("cover")
    cover_url = None
    if cover_key and (series_dir / cover_key).is_file():
        cover_url = f"/media/{slug}/{cover_key}"

    db.upsert_series({
        "slug": slug,
        "title": meta.get("title"),
        "description": meta.get("description"),
        "genres": meta.get("genres") or [],
        "author": meta.get("author"),
        "artist": meta.get("artist"),
        "type": meta.get("type"),
        "status": meta.get("status"),
        "rating": meta.get("rating"),
        "bookmarks": meta.get("bookmarks"),
        "alt_titles": meta.get("alt_titles") or [],
        "cover_key": cover_key,
        "cover_url": cover_url,
        "source_url": meta.get("source_url"),
        "remote_chapters": meta.get("remote_chapters"),
        "locked_chapters": meta.get("locked_chapters"),
        "release": meta.get("release"),
        "release_date": meta.get("release_date"),  # usually absent; editable later
        "info_updated_at": meta.get("info_updated_at"),
    })

    chap_dirs = sorted(
        (p for p in series_dir.iterdir() if p.is_dir() and p.name.startswith("chapter-")),
        key=lambda p: natural_chapter_key(p.name),
    )
    chapters_n = 0
    pages_n = 0
    for chap_dir in chap_dirs:
        chapter_id = chap_dir.name.removeprefix("chapter-")
        manifest = read_json(chap_dir / "manifest.json")
        images = sorted(p for p in chap_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
        size = 0
        for img in images:
            try:
                size += img.stat().st_size
            except OSError:
                pass

        # Only pages whose scraped src the manifest recorded; a partial set is dropped whole.
        man_pages = [pg for pg in manifest.get("pages") or [] if pg.get("page_index") is not None]
        pages: list[dict] = []
        if man_pages and all(pg.get("src") for pg in man_pages):
            for pg in man_pages:
                pages.append({
                    "page_index": int(pg["page_index"]),
                    "r2_key": None,
                    "public_url": None,
                    "cdn_url": pg["src"],
                    "aspect_ratio": pg.get("aspect_ratio"),
                    "alt": pg.get("alt"),
                })

        page_count = manifest.get("page_count") or len(pages) or len(images) or None
        published = dates.get(chapter_id) or dates.get(str(chapter_id))
        db.upsert_chapter({
            "series_slug": slug,
            "chapter_id": chapter_id,
            "source_url": manifest.get("source_url"),
            "published_at": published,
            "page_count": page_count,
            "status": "missing",  # no R2 yet
            "size_bytes": size or None,
        })
        if pages:
            db.replace_pages(slug, chapter_id, pages)
            pages_n += len(pages)
        chapters_n += 1

    return {"slug": slug, "chapters": chapters_n, "pages": pages_n, "title": meta.get("title")}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=None, help="SQLite path (default: COMIKFLIX_DB or data/comikflix.db)")
    ap.add_argument("--downloads", type=Path, default=DOWNLOADS)
    args = ap.parse_args()
    if args.db:
        db.set_db_path(args.db)
    db.init_schema()

    root = args.downloads
    if not root.is_dir():
        print(f"No downloads dir at {root}", file=sys.stderr)
        return 1

    series_dirs = sorted(p for p in root.iterdir() if p.is_dir())
    if not series_dirs:
        print(f"No series folders under {root}")
        return 0

    total_ch = total_pg = 0
    for series_dir in series_dirs:
        # Skip folders with neither series.json nor chapter-* dirs
        has_meta = (series_dir / "series.json").is_file()
        has_ch = any(p.is_dir() and p.name.startswith("chapter-") for p in series_dir.iterdir())
        if not has_meta and not has_ch:
            continue
        stats = import_series(series_dir)
        total_ch += stats["chapters"]
        total_pg += stats["pages"]
        print(f"  {stats['slug']}: {stats['chapters']} chapters, {stats['pages']} pages"
              + (f" ({stats['title']})" if stats.get("title") else ""))

    print(f"Done. {len(series_dirs)} series folder(s) scanned → "
          f"{db.series_count()} in DB, {total_ch} chapters, {total_pg} pages.")
    print(f"Database: {db.db_path()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
