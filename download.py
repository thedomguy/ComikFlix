#!/usr/bin/env python3
"""Concurrently download every page image listed in a pages.json manifest.

Usage:
    ./download.py [pages.json] [-o OUT_DIR] [-w WORKERS] [-r RETRIES]

Files are saved to OUT_DIR/<series_slug>/chapter-<chapter>/<NNN>.<ext>.
Existing non-empty files are skipped, so re-running resumes a partial download.
"""
import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

import http_util

HERE = Path(__file__).resolve().parent


def build_jobs(manifest: dict, out_root: Path) -> list[tuple[str, Path]]:
    dest_dir = out_root / manifest["series_slug"] / f"chapter-{manifest['chapter']}"
    width = max(3, len(str(manifest["page_count"])))
    jobs = []
    for page in manifest["pages"]:
        ext = Path(urlparse(page["src"]).path).suffix or ".bin"
        name = f"{page['page_index'] + 1:0{width}d}{ext}"
        jobs.append((page["src"], dest_dir / name))
    return jobs


def download(url: str, dest: Path, referer: str, retries: int) -> str:
    if dest.exists() and dest.stat().st_size > 0:
        return "skipped"
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    headers = {"Referer": referer, "Accept": "image/webp,image/*,*/*"}
    for attempt in range(1, retries + 1):
        try:
            with http_util.open_url(url, headers=headers, timeout=30) as resp, open(tmp, "wb") as f:
                while chunk := resp.read(1 << 16):
                    f.write(chunk)
            tmp.replace(dest)
            return "ok"
        except Exception:
            tmp.unlink(missing_ok=True)
            if attempt == retries:
                raise
            time.sleep(2 ** (attempt - 1))
    return "failed"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", nargs="?", default=str(HERE / "pages.json"))
    ap.add_argument("-o", "--out", default=str(HERE / "downloads"))
    ap.add_argument("-w", "--workers", type=int, default=8)
    ap.add_argument("-r", "--retries", type=int, default=3)
    args = ap.parse_args()

    manifest = json.loads(Path(args.manifest).read_text())
    jobs = build_jobs(manifest, Path(args.out))
    referer = manifest.get("source_url", "")
    print(f"{len(jobs)} pages -> {jobs[0][1].parent} ({args.workers} workers)")

    jobs[0][1].parent.mkdir(parents=True, exist_ok=True)
    (jobs[0][1].parent / "manifest.json").write_text(json.dumps(manifest, indent=2))

    failed = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download, u, d, referer, args.retries): (u, d) for u, d in jobs}
        for done, fut in enumerate(as_completed(futures), 1):
            url, dest = futures[fut]
            try:
                status = fut.result()
            except Exception as e:
                failed.append(url)
                status = f"FAILED ({e})"
            print(f"[{done}/{len(jobs)}] {dest.name}: {status}")

    if failed:
        print(f"\n{len(failed)} failed:", *failed, sep="\n  ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
