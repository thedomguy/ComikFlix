#!/usr/bin/env python3
"""Stitch downloaded page images into one continuous strip and write it as a PDF.

Usage:
    .venv/bin/python make_pdf.py [IMAGE_DIR] [-o OUT.pdf] [-w WIDTH] [-H PAGE_HEIGHT] [-q QUALITY]

IMAGE_DIR defaults to the chapter directory implied by pages.json
(downloads/<series_slug>/chapter-<n>). Images are sorted by filename, scaled to a
common width, joined top to bottom, then cut into PDF pages of PAGE_HEIGHT pixels
(the cuts ignore image boundaries, so nothing is split at a seam). Use
--page-height 0 for a single page, though many viewers cap page size at ~14400pt.
"""
import argparse
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent

try:
    from PIL import Image
except ModuleNotFoundError:
    # Not running under the venv that has Pillow: re-exec with it.
    venv_python = HERE / ".venv" / "bin" / "python"
    if venv_python.exists() and Path(sys.executable) != venv_python:
        os.execv(venv_python, [str(venv_python), *sys.argv])
    sys.exit("Pillow is required: python3 -m venv .venv && .venv/bin/pip install Pillow")

EXTS = {".webp", ".png", ".jpg", ".jpeg"}
Image.MAX_IMAGE_PIXELS = None


def default_dir() -> Path:
    m = json.loads((HERE / "pages.json").read_text())
    return HERE / "downloads" / m["series_slug"] / f"chapter-{m['chapter']}"


def load_rgb(path: Path, width: int) -> Image.Image:
    img = Image.open(path).convert("RGB")
    if img.width != width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    return img


def slice_pages(files: list[Path], width: int, page_h: int, tmp: Path, quality: int) -> list[Path]:
    """Stream images into fixed-height page slices, saving each as JPEG."""
    out: list[Path] = []
    canvas = Image.new("RGB", (width, page_h), "white") if page_h else None
    filled = 0

    def flush(img: Image.Image) -> None:
        p = tmp / f"page_{len(out):04d}.jpg"
        img.save(p, "JPEG", quality=quality)
        out.append(p)

    if page_h:
        for f in files:
            img = load_rgb(f, width)
            y = 0
            while y < img.height:
                take = min(page_h - filled, img.height - y)
                canvas.paste(img.crop((0, y, width, y + take)), (0, filled))
                filled += take
                y += take
                if filled == page_h:
                    flush(canvas)
                    canvas = Image.new("RGB", (width, page_h), "white")
                    filled = 0
        if filled:
            flush(canvas.crop((0, 0, width, filled)))
    else:
        imgs = [load_rgb(f, width) for f in files]
        full = Image.new("RGB", (width, sum(i.height for i in imgs)), "white")
        y = 0
        for i in imgs:
            full.paste(i, (0, y))
            y += i.height
        flush(full)
    return out


def build_pdf(image_dir: Path, out: Path | None, args) -> int:
    files = sorted(p for p in image_dir.iterdir() if p.suffix.lower() in EXTS)
    if not files:
        print(f"no images in {image_dir}", file=sys.stderr)
        return 1
    out = out or image_dir.parent / f"{image_dir.parent.name}-{image_dir.name}.pdf"

    width = args.width
    if not width:
        widths = [Image.open(f).width for f in files]
        width = Counter(widths).most_common(1)[0][0]
    print(f"{len(files)} images, width {width}px, page height {args.page_height or 'unbounded'}")

    with tempfile.TemporaryDirectory() as t:
        pages = slice_pages(files, width, args.page_height, Path(t), args.quality)
        first, *rest = (Image.open(p) for p in pages)
        first.save(out, "PDF", save_all=True, append_images=rest, resolution=100.0)
    print(f"wrote {out} ({len(pages)} pages, {out.stat().st_size / 1e6:.1f} MB)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image_dir", nargs="?", type=Path)
    ap.add_argument("-o", "--out", type=Path)
    ap.add_argument("-w", "--width", type=int, help="common width in px (default: most common source width)")
    ap.add_argument("-H", "--page-height", type=int, default=2400, help="PDF page height in px, 0 = one page")
    ap.add_argument("-q", "--quality", type=int, default=90, help="JPEG quality")
    args = ap.parse_args()

    root = args.image_dir or default_dir()
    # A directory of chapters (e.g. downloads/) yields one PDF per chapter folder.
    if any(p.suffix.lower() in EXTS for p in root.iterdir()):
        return build_pdf(root, args.out, args)
    chapters = sorted({p.parent for p in root.rglob("*") if p.suffix.lower() in EXTS})
    if not chapters:
        print(f"no images under {root}", file=sys.stderr)
        return 1
    return max(build_pdf(c, None, args) for c in chapters)


if __name__ == "__main__":
    sys.exit(main())
