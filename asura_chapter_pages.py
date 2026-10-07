#!/usr/bin/env python3
"""Extract AsuraScans chapter reader page image URLs into JSON.

Usage:
  python3 asura_chapter_pages.py
  python3 asura_chapter_pages.py "https://asurascans.com/comics/.../chapter/1"
  python3 asura_chapter_pages.py --out pages.json
  python3 asura_chapter_pages.py --help

Fetches the chapter HTML (SSR), finds reader imgs under
div.select-none > div[max-w…] > div[data-page] > img[data-page-index]
with src on cdn.asurascans.com (*.webp), and prints JSON.
Does not download image binaries.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import http_util

DEFAULT_URL = (
    "https://asurascans.com/comics/"
    "childhood-friend-of-the-zenith-bd5bdaf8/chapter/1"
)

CDN_HOST = "cdn.asurascans.com"
USER_AGENT = http_util.USER_AGENT

# Matching ignores ?v=; full src is kept in output.
CDN_WEBP_RE = re.compile(
    r"^https?://cdn\.asurascans\.com/.+\.webp(?:\?.*)?$",
    re.IGNORECASE,
)


def fetch_html(url: str, timeout: float = 30.0) -> str:
    with http_util.open_url(
        url,
        headers={"Accept": "text/html,application/xhtml+xml"},
        timeout=timeout,
    ) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def _parse_aspect_ratio(style: str | None) -> str | None:
    if not style:
        return None
    m = re.search(r"aspect-ratio\s*:\s*([^;]+)", style, re.IGNORECASE)
    if not m:
        return None
    return m.group(1).strip()


def _has_class(attrs: dict[str, str | None], name: str) -> bool:
    classes = (attrs.get("class") or "").split()
    return name in classes


def _has_max_w_class(attrs: dict[str, str | None]) -> bool:
    classes = (attrs.get("class") or "").split()
    return any(c == "max-w-full" or c.startswith("max-w-[") or c.startswith("md:max-w-") for c in classes)


class ReaderPageParser(HTMLParser):
    """Walk DOM looking for the select-none reader container and its pages."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pages: list[dict[str, Any]] = []
        self._in_select_none = 0
        self._in_max_w = 0
        self._page_div: dict[str, Any] | None = None
        self._depth_select_none: list[int] = []
        self._depth_max_w: list[int] = []
        self._depth_page: list[int] = []
        self._stack_depth = 0

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = dict(attrs_list)
        self._stack_depth += 1

        if tag == "div" and _has_class(attrs, "select-none"):
            self._in_select_none += 1
            self._depth_select_none.append(self._stack_depth)

        if self._in_select_none and tag == "div" and _has_max_w_class(attrs):
            self._in_max_w += 1
            self._depth_max_w.append(self._stack_depth)

        if self._in_max_w and tag == "div" and attrs.get("data-page") is not None:
            self._page_div = {
                "data_page": attrs.get("data-page"),
                "aspect_ratio": _parse_aspect_ratio(attrs.get("style")),
            }
            self._depth_page.append(self._stack_depth)

        if (
            self._page_div is not None
            and tag == "img"
            and attrs.get("data-page-index") is not None
        ):
            src = attrs.get("src") or ""
            if CDN_WEBP_RE.match(src):
                try:
                    page_index = int(attrs["data-page-index"])  # type: ignore[arg-type]
                except (TypeError, ValueError):
                    page_index = attrs.get("data-page-index")
                try:
                    data_page = int(self._page_div["data_page"])
                except (TypeError, ValueError):
                    data_page = self._page_div["data_page"]

                self.pages.append(
                    {
                        "page_index": page_index,
                        "data_page": data_page,
                        "src": src,
                        "alt": attrs.get("alt") or None,
                        "aspect_ratio": self._page_div.get("aspect_ratio"),
                    }
                )

        # HTMLParser: void elements still get endtag callbacks inconsistently;
        # track void tags so depth stays accurate for nesting checks.
        if tag in {"img", "br", "hr", "meta", "link", "input", "source", "area", "base", "col", "embed", "wbr"}:
            self._stack_depth -= 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"img", "br", "hr", "meta", "link", "input", "source", "area", "base", "col", "embed", "wbr"}:
            return

        if self._depth_page and self._depth_page[-1] == self._stack_depth:
            self._depth_page.pop()
            self._page_div = None

        if self._depth_max_w and self._depth_max_w[-1] == self._stack_depth:
            self._depth_max_w.pop()
            self._in_max_w = max(0, self._in_max_w - 1)

        if self._depth_select_none and self._depth_select_none[-1] == self._stack_depth:
            self._depth_select_none.pop()
            self._in_select_none = max(0, self._in_select_none - 1)

        self._stack_depth = max(0, self._stack_depth - 1)


def extract_pages(html: str) -> list[dict[str, Any]]:
    parser = ReaderPageParser()
    parser.feed(html)
    pages = sorted(
        parser.pages,
        key=lambda p: (
            p["page_index"] if isinstance(p["page_index"], int) else 10**9,
            str(p["page_index"]),
        ),
    )
    # Dedupe by page_index keeping first (full src including ?v=)
    seen: set[Any] = set()
    unique: list[dict[str, Any]] = []
    for p in pages:
        key = p["page_index"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def build_result(url: str, pages: list[dict[str, Any]]) -> dict[str, Any]:
    path = urlparse(url).path.rstrip("/")
    parts = path.split("/")
    series_slug = None
    chapter = None
    if "comics" in parts:
        i = parts.index("comics")
        if i + 1 < len(parts):
            series_slug = parts[i + 1]
        if i + 3 < len(parts) and parts[i + 2] == "chapter":
            chapter = parts[i + 3]

    return {
        "source_url": url,
        "series_slug": series_slug,
        "chapter": chapter,
        "page_count": len(pages),
        "pages": pages,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract AsuraScans chapter reader image URLs (JSON only; "
            "does not download webp binaries)."
        )
    )
    parser.add_argument(
        "url",
        nargs="?",
        default=DEFAULT_URL,
        help=f"Chapter URL (default: example ch.1)",
    )
    parser.add_argument(
        "-o",
        "--out",
        metavar="FILE",
        help="Also write JSON to this file",
    )
    parser.add_argument(
        "--html-file",
        metavar="FILE",
        help="Parse local HTML instead of fetching (offline / dry-run)",
    )
    args = parser.parse_args(argv)

    try:
        if args.html_file:
            with open(args.html_file, encoding="utf-8", errors="replace") as f:
                html = f.read()
            source = args.url
        else:
            html = fetch_html(args.url)
            source = args.url
    except urllib.error.HTTPError as e:
        print(f"HTTP error fetching {args.url}: {e.code} {e.reason}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"Network error fetching {args.url}: {e.reason}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"Error reading input: {e}", file=sys.stderr)
        return 1

    pages = extract_pages(html)
    if not pages:
        print(
            "No reader pages found (expected div[data-page] > "
            f"img[data-page-index] with src on {CDN_HOST}).",
            file=sys.stderr,
        )
        return 2

    result = build_result(source, pages)
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    sys.stdout.write(text)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
