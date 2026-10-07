#!/usr/bin/env python3
"""One-time sync: bring every series already in downloads/ up to date with the source.

Usage:
    ./sync_library.py [--force] [--download] [--series SLUG ...] [-o OUT_DIR] [-w WORKERS]

For each series folder in downloads/ it fetches the series info and rewrites series.json
(title, synopsis, genres, author, artist, status, rating, cover, chapter publish dates and
the list of chapters available at the source). Chapter images already on disk are untouched.

  --force      overwrite fields that are already set in series.json (default: only fill gaps,
               so hand edits survive; status/rating/chapter dates always refresh)
  --download   also download chapters that exist at the source but not locally
  --series     limit to these slugs (default: every series with downloaded chapters)

Safe to re-run; it is idempotent.
"""
import argparse
import sys
import time
from pathlib import Path

import ingest

DELAY = 1.0  # seconds between series, to go easy on the source


def local_chapters(series_dir: Path) -> list[str]:
    return sorted((p.name.removeprefix("chapter-") for p in series_dir.glob("chapter-*") if p.is_dir()), key=float)


def find_series(out_root: Path, only: list[str]) -> list[Path]:
    dirs = sorted(p for p in out_root.iterdir() if p.is_dir() and any(p.glob("chapter-*")))
    if only:
        wanted = {ingest.parse_slug(s) for s in only}
        missing = wanted - {p.name for p in dirs}
        if missing:
            print(f"not in library: {', '.join(sorted(missing))}", file=sys.stderr)
        dirs = [p for p in dirs if p.name in wanted]
    return dirs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--series", nargs="+", default=[], metavar="SLUG")
    ap.add_argument("-o", "--out", type=Path, default=ingest.DOWNLOADS)
    ap.add_argument("-w", "--workers", type=int, default=8)
    args = ap.parse_args()

    if not args.out.is_dir():
        print(f"no library at {args.out}", file=sys.stderr)
        return 1
    series = find_series(args.out, args.series)
    if not series:
        print("nothing to sync")
        return 0

    failed, new_total = [], 0
    for n, series_dir in enumerate(series, 1):
        slug = series_dir.name
        print(f"[{n}/{len(series)}] {slug}")
        try:
            info = ingest.fetch_series_info(slug)
            ingest.save_series_info(info, args.out, overwrite=args.force)
        except Exception as e:
            print(f"    FAILED: {ingest._error_text(e)}")
            failed.append(slug)
            continue

        have = set(local_chapters(series_dir))
        available = [c["number"] for c in info["chapters"] if not c["locked"]]
        locked = [c["number"] for c in info["chapters"] if c["locked"]]
        new = [c for c in available if c not in have]
        new_total += len(new)
        print(f"    {info['title']}: {len(have)} local, {len(available)} available"
              + (f", {len(new)} new" if new else ", up to date")
              + (f", {len(locked)} locked" if locked else ""))

        if args.download and new:
            for number in new:
                try:
                    pages = ingest.ingest_chapter(slug, number, args.out, args.workers)
                    print(f"    chapter {number}: {pages} pages")
                except Exception as e:
                    print(f"    chapter {number}: FAILED ({ingest._error_text(e)})")
                    failed.append(f"{slug}#{number}")
                time.sleep(ingest.FETCH_DELAY)
        time.sleep(DELAY)

    print(f"\nsynced {len(series) - len([f for f in failed if '#' not in f])}/{len(series)} series; "
          f"{new_total} chapters available but not downloaded"
          + ("" if args.download or not new_total else " (re-run with --download, or use Update in the app)"))
    if failed:
        print(f"failures: {', '.join(failed)}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
