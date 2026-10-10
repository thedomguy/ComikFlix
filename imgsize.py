"""Page sizes for sources that don't print them (mgeko): read each image's header with a
ranged request instead of downloading it. The reader lays pages out by these ratios before
the images load, and saved reading positions are fractions of that layout, so a chapter
without them shifts under the reader (resume lands in the wrong place, the 5% "you've
started this" mark comes early or late).
"""
from __future__ import annotations

import struct
from concurrent.futures import ThreadPoolExecutor

import http_util

FIRST = 64 * 1024  # enough for almost every header
MOST = 512 * 1024  # JPEGs with large EXIF/ICC blocks put the size further in


def size_from_bytes(d: bytes) -> tuple[int, int] | None:
    """(width, height) from the start of a JPEG, PNG, GIF or WebP file; None if not there yet."""
    if d[:8] == b"\x89PNG\r\n\x1a\n" and len(d) >= 24:
        return struct.unpack(">II", d[16:24])
    if d[:6] in (b"GIF87a", b"GIF89a") and len(d) >= 10:
        return struct.unpack("<HH", d[6:10])
    if d[:4] == b"RIFF" and d[8:12] == b"WEBP" and len(d) >= 30:
        kind = d[12:16]
        if kind == b"VP8 ":
            w, h = struct.unpack("<HH", d[26:30])
            return w & 0x3FFF, h & 0x3FFF
        if kind == b"VP8L":
            b = int.from_bytes(d[21:25], "little")
            return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
        if kind == b"VP8X":
            return int.from_bytes(d[24:27], "little") + 1, int.from_bytes(d[27:30], "little") + 1
        return None
    if d[:2] == b"\xff\xd8":
        i = 2
        while i + 9 <= len(d):
            if d[i] != 0xFF:
                return None
            marker = d[i + 1]
            if marker == 0xFF:  # fill byte
                i += 1
                continue
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # no length field
                i += 2
                continue
            length = struct.unpack(">H", d[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", d[i + 5:i + 9])
                return w, h
            i += 2 + length
    return None


def probe(url: str, timeout: float = 15.0) -> tuple[int, int] | None:
    """An image's size from its first bytes; None when it can't be read."""
    for want in (FIRST, MOST):
        try:
            with http_util.open_url(url, headers={"Range": f"bytes=0-{want - 1}"}, timeout=timeout) as resp:
                data = resp.read(want)
        except Exception:
            return None
        size = size_from_bytes(data)
        if size and size[0] > 0 and size[1] > 0:
            return size
        if len(data) < want:  # that was the whole file
            return None
    return None


def fill_aspects(pages: list[dict], workers: int = 6) -> None:
    """Set aspect_ratio ("w/h") on pages that have none, in place. Best effort: a page
    that can't be read keeps None and the reader falls back to guessing."""
    missing = [p for p in pages if not p.get("aspect_ratio") and p.get("src")]
    if not missing:
        return
    with ThreadPoolExecutor(max_workers=min(workers, len(missing))) as pool:
        for p, size in zip(missing, pool.map(lambda p: probe(p["src"]), missing)):
            if size:
                p["aspect_ratio"] = f"{size[0]}/{size[1]}"
