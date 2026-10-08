#!/usr/bin/env python3
"""Delete local downloads/ and any R2 objects; reset DB binary pointers.

Keeps series/chapter/page metadata (including cdn_url) and reading progress.
Safe to re-run.

Usage:
    .venv/bin/python cleanup_binaries.py [--keep-downloads]
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import db
import r2

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"


def reset_db_binaries() -> dict:
    db.init_schema()
    with db.transaction() as conn:
        pages = conn.execute(
            """
            UPDATE pages
            SET r2_key = NULL,
                public_url = NULL
            WHERE r2_key IS NOT NULL
               OR public_url IS NOT NULL
            """
        ).rowcount
        chapters = conn.execute(
            """
            UPDATE chapters
            SET status = 'missing', size_bytes = 0
            WHERE status != 'missing' OR IFNULL(size_bytes, 0) != 0
            """
        ).rowcount
        # Drop local/R2 cover pointers; reader falls back to first-page CDN.
        covers = conn.execute(
            """
            UPDATE series
            SET cover_url = NULL,
                cover_key = NULL,
                updated_at = ?
            WHERE cover_url IS NOT NULL
               OR cover_key IS NOT NULL
            """,
            (db._now(),),
        ).rowcount
    return {"pages_cleared": pages, "chapters_reset": chapters, "covers_cleared": covers}


def delete_r2_all() -> int:
    if not r2.is_configured():
        print("R2 not configured — skipping remote delete", file=sys.stderr)
        return 0
    client = r2.get_client()
    keys = client.list_keys()
    for key in keys:
        client.delete(key)
        print(f"r2 delete {key}")
    return len(keys)


def delete_downloads() -> bool:
    if not DOWNLOADS.is_dir():
        return False
    shutil.rmtree(DOWNLOADS)
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--keep-downloads", action="store_true", help="do not wipe downloads/")
    ap.add_argument("--skip-r2", action="store_true", help="do not delete R2 objects")
    args = ap.parse_args()

    stats = reset_db_binaries()
    print("db", stats)

    if not args.skip_r2:
        n = delete_r2_all()
        print(f"r2 deleted {n} objects")

    if not args.keep_downloads:
        wiped = delete_downloads()
        print("downloads wiped" if wiped else "downloads already empty")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
