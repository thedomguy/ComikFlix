#!/usr/bin/env python3
"""Refresh series metadata in SQLite (and optionally ingest missing chapters to R2).

Usage:
    ./sync_library.py [--force] [--download] [--start N] [--series SLUG ...] [-w WORKERS]

Fetches series info from the source and upserts SQLite (+ cover to R2). With --download,
ingests chapters that are not yet status=ready, from --start (default 1) through latest.
Requires R2 env configured (see comikflix.env.example).
"""
import argparse
import sys
import time

import db
import ingest
import r2

DELAY = 1.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="overwrite descriptive series fields")
    ap.add_argument("--download", action="store_true", help="upload missing chapters to R2")
    ap.add_argument("--start", type=float, default=1, help="first chapter when --download (default 1)")
    ap.add_argument("--series", nargs="+", default=[], metavar="SLUG")
    ap.add_argument("-w", "--workers", type=int, default=8)
    args = ap.parse_args()

    db.init_schema()
    if args.series:
        slugs = [ingest.parse_slug(s) for s in args.series]
    else:
        slugs = [row["slug"] for row in db.list_series_rows()]
    if not slugs:
        print("nothing to sync (no series in DB; pass --series SLUG)")
        return 0

    client = None
    try:
        client = r2.get_client()
    except r2.R2ConfigError as e:
        if args.download:
            print(str(e), file=sys.stderr)
            return 1
        print(f"warning: {e} (series rows will update without new cover upload)", file=sys.stderr)

    failed, new_total = [], 0
    for n, slug in enumerate(slugs, 1):
        print(f"[{n}/{len(slugs)}] {slug}")
        try:
            info = ingest.fetch_series_info(slug)
            if client:
                ingest.save_series_info(info, overwrite=args.force, client=client)
            else:
                # DB-only metadata without cover upload
                import db_ingest
                release = ingest.estimate_release(info["chapters"], info.get("status"))
                db_ingest.upsert_series(info, release=release, overwrite=args.force)
        except Exception as e:
            print(f"    FAILED: {ingest._error_text(e)}")
            failed.append(slug)
            continue

        available = [c["number"] for c in info["chapters"] if not c["locked"]]
        locked = [c["number"] for c in info["chapters"] if c["locked"]]
        pending = [
            c for c in available
            if float(c) >= args.start and not ingest.chapter_complete(slug, c)
        ]
        new_total += len(pending)
        print(f"    {info['title']}: {len(available)} available, {len(pending)} not ready"
              + (f", {len(locked)} locked" if locked else ""))

        if args.download and pending and client:
            for number in pending:
                try:
                    pub = None
                    for c in info["chapters"]:
                        if c["number"] == number:
                            pub = c.get("published_at")
                            break
                    pages = ingest.ingest_chapter(
                        slug, number, args.workers, client, published_at=pub,
                    )
                    print(f"    chapter {number}: {pages} pages → R2")
                except Exception as e:
                    print(f"    chapter {number}: FAILED ({ingest._error_text(e)})")
                    failed.append(f"{slug}#{number}")
                time.sleep(ingest.FETCH_DELAY)
        time.sleep(DELAY)

    print(f"\nsynced {len(slugs) - len([f for f in failed if '#' not in f])}/{len(slugs)} series; "
          f"{new_total} chapters not ready"
          + ("" if args.download or not new_total else " (re-run with --download)"))
    if failed:
        print(f"failures: {', '.join(failed)}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
