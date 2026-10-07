#!/usr/bin/env python3
"""Optimize downloaded page images for web delivery as lossy WebP (in place).

Preserves full composition (no crop/redraw), aspect ratio, and visual fidelity for
comic reading. Downscales only when wider than --max-width (never upscales).
Chooses WebP quality from {80, 82, 85} using encoder PSNR: start at 82, bump to
85 if artifacts are likely, prefer 80 when visually indistinguishable.

Usage:
    ./optimize_images.py [PATH] [-w WORKERS] [--max-width 1400] [--limit N]
    ./optimize_images.py downloads/<series>/chapter-12
    ./optimize_images.py -o /tmp/mirror   # optional parallel tree (rare)

Default is atomic in-place replace under downloads/. A chapter-level
``.optimized`` marker records fingerprints so re-runs skip unchanged files.

Requires cwebp (libwebp) on PATH. Pillow is used only to read dimensions / skip
corrupt files. Also imported by ingest.py after each successful chapter download.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"
IMG_EXTS = {".webp", ".png", ".jpg", ".jpeg", ".gif"}
MARKER_NAME = ".optimized"

# Quality ladder (lossy WebP). Highest encoder effort.
Q_START = 82
Q_HIGH = 85
Q_LOW = 80
METHOD = 6

# PSNR thresholds vs the (possibly resized) source pixels.
PSNR_ARTIFACT = 39.5
PSNR_INDISTINGUISHABLE = 42.0
PSNR_PROBE_LOW = 41.0

SHORT_RE = re.compile(r"(\d+)\s+([0-9.]+)")


@dataclass
class Result:
    src: Path
    dest: Path | None
    status: str  # optimized | kept | skipped | failed
    original_bytes: int
    optimized_bytes: int
    width: int
    height: int
    quality: int | None
    psnr: float | None
    message: str = ""

    @property
    def saved_pct(self) -> float | None:
        if self.original_bytes <= 0:
            return None
        return (1.0 - self.optimized_bytes / self.original_bytes) * 100.0


def find_cwebp() -> str:
    path = shutil.which("cwebp")
    if not path:
        raise RuntimeError("cwebp not found on PATH (install libwebp, e.g. brew install webp)")
    return path


def collect_images(root: Path) -> list[Path]:
    if root.is_file():
        return [root] if root.suffix.lower() in IMG_EXTS else []
    return [
        p
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.suffix.lower() in IMG_EXTS and p.name != ".DS_Store"
    ]


def image_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    with Image.open(path) as im:
        return im.size


def _fingerprint(path: Path) -> dict:
    st = path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _load_marker(chap_dir: Path) -> dict:
    path = chap_dir / MARKER_NAME
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_marker(chap_dir: Path, files: dict, max_width: int) -> None:
    payload = {"max_width": max_width, "files": files}
    (chap_dir / MARKER_NAME).write_text(json.dumps(payload, indent=2))


def encode_webp(
    cwebp: str,
    src: Path,
    dest: Path,
    quality: int,
    max_width: int,
) -> tuple[int, float, int, int]:
    """Encode with cwebp. Returns (bytes, psnr, width, height)."""
    cmd = [
        cwebp,
        "-q", str(quality),
        "-m", str(METHOD),
        "-mt",
        "-metadata", "none",
        "-sharp_yuv",
        "-resize", str(max_width), "0",
        "-resize_mode", "down_only",
        "-print_psnr", "-short",
        str(src), "-o", str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "cwebp failed").strip()
        raise RuntimeError(err)
    blob = (proc.stderr or "") + "\n" + (proc.stdout or "")
    m = SHORT_RE.search(blob)
    if not m:
        size = dest.stat().st_size
        w, h = image_size(dest)
        return size, float("nan"), w, h
    size = int(m.group(1))
    psnr = float(m.group(2))
    w, h = image_size(dest)
    return size, psnr, w, h


def pick_quality(
    cwebp: str, src: Path, work: Path, max_width: int
) -> tuple[int, Path, float, int, int]:
    """Return (quality, path, psnr, width, height) for the chosen encode."""
    q82_path = work / "q82.webp"
    size82, psnr82, w, h = encode_webp(cwebp, src, q82_path, Q_START, max_width)

    if psnr82 < PSNR_ARTIFACT:
        q85_path = work / "q85.webp"
        _, psnr85, w, h = encode_webp(cwebp, src, q85_path, Q_HIGH, max_width)
        return Q_HIGH, q85_path, psnr85, w, h

    if psnr82 >= PSNR_PROBE_LOW:
        q80_path = work / "q80.webp"
        size80, psnr80, w80, h80 = encode_webp(cwebp, src, q80_path, Q_LOW, max_width)
        if psnr80 >= PSNR_INDISTINGUISHABLE:
            return Q_LOW, q80_path, psnr80, w80, h80
        if psnr80 + 0.75 >= psnr82 and size80 < size82:
            return Q_LOW, q80_path, psnr80, w80, h80

    return Q_START, q82_path, psnr82, w, h


def dest_for(src: Path, root: Path, out_root: Path | None, inplace: bool) -> Path:
    if inplace:
        return src.with_suffix(".webp")
    assert out_root is not None
    try:
        rel = src.relative_to(root)
    except ValueError:
        rel = Path(src.name)
    return (out_root / rel).with_suffix(".webp")


def optimize_one(
    cwebp: str,
    src: Path,
    root: Path,
    out_root: Path | None,
    inplace: bool,
    max_width: int,
    marker_files: dict | None = None,
) -> Result:
    original_bytes = src.stat().st_size
    dest = dest_for(src, root, out_root, inplace)

    # Skip if fingerprint matches chapter marker (inplace re-runs).
    if inplace and marker_files is not None:
        prev = marker_files.get(src.name)
        if prev and prev.get("size") == original_bytes:
            try:
                if prev.get("mtime_ns") == src.stat().st_mtime_ns and src.suffix.lower() == ".webp":
                    w, h = image_size(src)
                    if w <= max_width:
                        return Result(
                            src, src, "skipped", original_bytes, original_bytes, w, h, None, None, "already optimized"
                        )
            except Exception:
                pass

    try:
        src_w, src_h = image_size(src)
    except Exception as e:
        return Result(src, None, "failed", original_bytes, original_bytes, 0, 0, None, None, str(e))

    needs_resize = src_w > max_width

    with tempfile.TemporaryDirectory(prefix="opt_webp_") as tmp:
        work = Path(tmp)
        try:
            quality, cand, psnr, w, h = pick_quality(cwebp, src, work, max_width)
        except Exception as e:
            return Result(
                src, None, "failed", original_bytes, original_bytes, src_w, src_h, None, None, str(e)
            )

        opt_bytes = cand.stat().st_size
        keep_original = (
            not needs_resize
            and opt_bytes >= original_bytes
            and src.suffix.lower() == ".webp"
            and dest.resolve() == src.resolve()
        )
        if keep_original and inplace:
            return Result(
                src, src, "kept", original_bytes, original_bytes, src_w, src_h, None, psnr, "re-encode not smaller"
            )

        dest.parent.mkdir(parents=True, exist_ok=True)
        if inplace and dest.resolve() == src.resolve():
            tmp_out = dest.with_suffix(dest.suffix + ".tmp")
            shutil.copy2(cand, tmp_out)
            os.replace(tmp_out, dest)
        else:
            shutil.copy2(cand, dest)
            if inplace and src.suffix.lower() != ".webp" and src.resolve() != dest.resolve():
                src.unlink(missing_ok=True)

        return Result(src, dest, "optimized", original_bytes, opt_bytes, w, h, quality, psnr)


def fmt_bytes(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.2f} MB"
    return f"{n / 1024:.1f} KB"


def print_result(r: Result) -> None:
    rel = r.src
    try:
        rel = r.src.relative_to(HERE)
    except ValueError:
        pass
    if r.status == "failed":
        print(f"FAILED  {rel}: {r.message}")
        return
    if r.status in ("kept", "skipped"):
        print(f"{r.status.upper():7} {rel}  {fmt_bytes(r.original_bytes)}  {r.width}x{r.height}  ({r.message})")
        return
    pct = r.saved_pct if r.saved_pct is not None else 0.0
    psnr_s = f"{r.psnr:.2f} dB" if r.psnr is not None and r.psnr == r.psnr else "n/a"
    print(
        f"OK      {rel}\n"
        f"        original: {fmt_bytes(r.original_bytes)}  optimized: {fmt_bytes(r.optimized_bytes)}  "
        f"saved: {pct:.1f}%\n"
        f"        dims: {r.width}x{r.height}  quality: {r.quality}  psnr: {psnr_s}"
    )


def _ensure_pillow() -> None:
    try:
        import PIL  # noqa: F401
    except ModuleNotFoundError:
        venv_python = HERE / ".venv" / "bin" / "python"
        if venv_python.exists() and Path(sys.executable) != venv_python:
            os.execv(venv_python, [str(venv_python), *sys.argv])
        raise RuntimeError("Pillow is required: .venv/bin/pip install Pillow")


def optimize_images(
    root: Path,
    *,
    inplace: bool = True,
    out_root: Path | None = None,
    workers: int = 4,
    max_width: int = 1400,
    limit: int = 0,
    quiet: bool = False,
    cwebp: str | None = None,
) -> list[Result]:
    """Optimize images under root. Returns per-file results.

    When inplace=True (default), atomically replaces sources with WebP.
    Updates chapter ``.optimized`` markers for cheap re-runs.
    """
    _ensure_pillow()
    cwebp = cwebp or find_cwebp()
    root = root.resolve()
    images = collect_images(root)
    if limit > 0:
        images = images[:limit]
    if not images:
        return []

    scan_root = root if root.is_dir() else root.parent
    if DOWNLOADS.resolve() in scan_root.parents or scan_root == DOWNLOADS.resolve():
        scan_root = DOWNLOADS.resolve()
    if not inplace:
        out_root = (out_root or (HERE / "optimized")).resolve()

    # Group by chapter dir for marker updates
    by_chapter: dict[Path, list[Path]] = {}
    for img in images:
        chap = img.parent
        by_chapter.setdefault(chap, []).append(img)

    markers = {chap: _load_marker(chap).get("files", {}) for chap in by_chapter}

    if not quiet:
        mode = "inplace" if inplace else f"out={out_root}"
        print(f"{len(images)} image(s)  max-width={max_width}  workers={workers}  {mode}  cwebp={cwebp}")

    results: list[Result] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futs = {}
        for img in images:
            futs[pool.submit(
                optimize_one,
                cwebp,
                img,
                scan_root,
                out_root,
                inplace,
                max_width,
                markers.get(img.parent) if inplace else None,
            )] = img
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            if not quiet:
                print_result(r)
                sys.stdout.flush()

    if inplace:
        # Refresh fingerprints for successful/skipped/kept files
        for chap, imgs in by_chapter.items():
            files = dict(markers.get(chap) or {})
            for img in imgs:
                match = next((r for r in results if r.src == img), None)
                if not match or match.status == "failed":
                    continue
                target = match.dest or img
                if target.exists():
                    files[target.name] = _fingerprint(target)
                    if target.name != img.name:
                        files.pop(img.name, None)
            _save_marker(chap, files, max_width)

    results.sort(key=lambda r: str(r.src))
    if not quiet:
        ok = [r for r in results if r.status == "optimized"]
        kept = [r for r in results if r.status == "kept"]
        skipped = [r for r in results if r.status == "skipped"]
        failed = [r for r in results if r.status == "failed"]
        orig = sum(r.original_bytes for r in results)
        new = sum(
            r.optimized_bytes if r.status == "optimized" else r.original_bytes for r in results
        )
        saved = (1.0 - new / orig) * 100.0 if orig else 0.0
        print(
            f"\nSummary: {len(ok)} optimized, {len(kept)} kept, {len(skipped)} skipped, "
            f"{len(failed)} failed  |  {fmt_bytes(orig)} → {fmt_bytes(new)} ({saved:.1f}% smaller)"
        )
    return results


def optimize_chapter(chap_dir: Path, *, workers: int = 4, max_width: int = 1400) -> dict:
    """Optimize one chapter directory in place. Returns a summary dict for logging."""
    results = optimize_images(chap_dir, inplace=True, workers=workers, max_width=max_width, quiet=True)
    ok = sum(1 for r in results if r.status == "optimized")
    kept = sum(1 for r in results if r.status in ("kept", "skipped"))
    failed = sum(1 for r in results if r.status == "failed")
    orig = sum(r.original_bytes for r in results)
    new = sum(r.optimized_bytes if r.status == "optimized" else r.original_bytes for r in results)
    return {
        "images": len(results),
        "optimized": ok,
        "kept": kept,
        "failed": failed,
        "original_bytes": orig,
        "optimized_bytes": new,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", nargs="?", default=str(DOWNLOADS), help="file or directory (default: downloads/)")
    ap.add_argument("-o", "--out", default=None, help="optional mirror output root (disables inplace)")
    ap.add_argument("--inplace", action="store_true", default=True, help=argparse.SUPPRESS)
    ap.add_argument("--no-inplace", action="store_true", help="write to --out instead of replacing sources")
    ap.add_argument("-w", "--workers", type=int, default=4)
    ap.add_argument("--max-width", type=int, default=1400)
    ap.add_argument("--limit", type=int, default=0, help="process at most N images (0=all)")
    args = ap.parse_args()

    inplace = not args.no_inplace and args.out is None
    out_root = Path(args.out).resolve() if args.out else None
    if args.no_inplace and out_root is None:
        out_root = HERE / "optimized"

    try:
        results = optimize_images(
            Path(args.path),
            inplace=inplace,
            out_root=out_root,
            workers=args.workers,
            max_width=args.max_width,
            limit=args.limit,
        )
    except RuntimeError as e:
        print(e, file=sys.stderr)
        return 1
    if not results:
        print("no images found", file=sys.stderr)
        return 1
    return 1 if any(r.status == "failed" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
