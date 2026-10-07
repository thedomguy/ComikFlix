#!/usr/bin/env python3
"""Local comic reader: a Netflix-style library over everything in downloads/.

Usage:
    ./server.py [-p PORT] [--host HOST] [--no-open]

The "Add Comic" / "Update" buttons in the UI run ingest.py in the background: give it a series
slug (or URL) and it scrapes the series info and downloads every available chapter.

Library layout (as produced by download.py):
    downloads/<series_slug>/chapter-<n>/001.webp ...  (+ manifest.json)
    downloads/<series_slug>/series.json               (optional)

series.json is written by ingest.py (and can be hand-edited): title, description, genres,
status, author, artist, type, rating, alt_titles, cover (path relative to the series folder),
chapter_dates {chapter: ISO date}, remote_chapters, locked_chapters.
"""
import argparse
import json
import mimetypes
import re
import threading
import webbrowser
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import ingest

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"
WEB = HERE / "web"
IMG_EXTS = {".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif"}
INGEST = ingest.IngestManager(DOWNLOADS)

# PWA / static MIME fixes
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def natural_chapter_key(name: str) -> float:
    m = re.search(r"chapter-(.+)$", name)
    try:
        return float(m.group(1)) if m else float("inf")
    except ValueError:
        return float("inf")


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def title_from_slug(slug: str) -> str:
    slug = re.sub(r"-[0-9a-f]{8}$", "", slug)
    return slug.replace("-", " ").title()


def scan_chapter(series_dir: Path, chap_dir: Path, dates: dict) -> dict | None:
    images = sorted(p for p in chap_dir.iterdir() if p.suffix.lower() in IMG_EXTS)
    if not images:
        return None
    manifest = read_json(chap_dir / "manifest.json")
    by_name = {}
    for page in manifest.get("pages", []):
        # download.py names files by page_index + 1, zero padded
        by_name[page["page_index"] + 1] = page.get("aspect_ratio")
    pages = []
    size = 0
    for i, img in enumerate(images, 1):
        aspect = by_name.get(i)
        try:
            nbytes = img.stat().st_size
        except OSError:
            nbytes = 0
        size += nbytes
        pages.append({
            "src": f"/media/{series_dir.name}/{chap_dir.name}/{img.name}",
            "aspect": aspect.replace(" ", "") if aspect else None,
        })
    chapter_id = chap_dir.name.removeprefix("chapter-")
    date = dates.get(chapter_id)
    if not date:  # no published date known: fall back to when it was downloaded
        try:
            date = datetime.fromtimestamp((chap_dir / "manifest.json").stat().st_mtime, timezone.utc).isoformat()
        except OSError:
            date = None
    return {
        "id": chapter_id,
        "pages": pages,
        "size": size,
        "source_url": manifest.get("source_url"),
        "date": date,
    }


def scan_library() -> list[dict]:
    series_list = []
    if not DOWNLOADS.is_dir():
        return series_list
    for series_dir in sorted(p for p in DOWNLOADS.iterdir() if p.is_dir()):
        meta = read_json(series_dir / "series.json")
        dates = meta.get("chapter_dates") or {}
        chapters = []
        for chap_dir in sorted((p for p in series_dir.iterdir() if p.is_dir() and p.name.startswith("chapter-")),
                               key=lambda p: natural_chapter_key(p.name)):
            chapter = scan_chapter(series_dir, chap_dir, dates)
            if chapter:
                chapters.append(chapter)
        if not chapters:
            continue
        first = chapters[0]
        # Title from series.json, else from a manifest alt ("Page 1 - Chapter 1 - <Title>"), else the slug.
        title = meta.get("title")
        if not title:
            alt = next((pg.get("alt") for pg in read_json(series_dir / f"chapter-{first['id']}" / "manifest.json").get("pages", [])), "")
            title = alt.rsplit(" - ", 1)[-1] if alt and " - " in alt else title_from_slug(series_dir.name)
        backdrop = first["pages"][0]["src"]
        poster = f"/media/{series_dir.name}/{meta['cover']}" if meta.get("cover") else backdrop
        series_list.append({
            "slug": series_dir.name,
            "title": title,
            "description": meta.get("description"),
            "genres": meta.get("genres", []),
            "status": meta.get("status"),
            "author": meta.get("author"),
            "artist": meta.get("artist"),
            "type": meta.get("type"),
            "rating": meta.get("rating"),
            "alt_titles": meta.get("alt_titles", []),
            "next_release": meta.get("release"),
            "remote_total": len(meta["remote_chapters"]) if meta.get("remote_chapters") else None,
            "source_url": meta.get("source_url") or first.get("source_url"),
            "poster": poster,
            "backdrop": backdrop,
            "size": sum(c["size"] for c in chapters),
            "chapters": chapters,
        })
    return series_list


class Handler(SimpleHTTPRequestHandler):
    """Serves web/ at /, downloads/ at /media/, and the library index at /api/library."""

    def translate_path(self, path: str) -> str:
        path = unquote(path.split("?", 1)[0].split("#", 1)[0])
        if path.startswith("/media/"):
            root, rel = DOWNLOADS, path[len("/media/"):]
        else:
            root, rel = WEB, path.lstrip("/") or "index.html"
        target = (root / rel).resolve()
        if root.resolve() not in target.parents and target != root.resolve():
            return str(WEB / "__forbidden__")  # path traversal attempt -> 404
        return str(target)

    def send_json(self, obj, status=HTTPStatus.OK) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def same_origin(self) -> bool:
        """Reject cross-site requests: state-changing calls must come from this page."""
        origin = self.headers.get("Origin")
        return origin is None or urlparse(origin).netloc == self.headers.get("Host")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/library":
            return self.send_json(scan_library())
        if path == "/api/ingest":
            return self.send_json(INGEST.list())
        if path.startswith("/api/ingest/"):
            job = INGEST.snapshot(path.rsplit("/", 1)[-1])
            return self.send_json(job or {"error": "unknown job"}, HTTPStatus.OK if job else HTTPStatus.NOT_FOUND)
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if not self.same_origin() or "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send_json({"error": "forbidden"}, HTTPStatus.FORBIDDEN)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(min(length, 65536)) or b"{}")
        except ValueError:
            return self.send_json({"error": "invalid JSON"}, HTTPStatus.BAD_REQUEST)
        if path == "/api/ingest":
            latest = data.get("latest")
            try:
                latest = int(latest) if latest not in (None, "") else None  # optional upper limit
            except (TypeError, ValueError):
                return self.send_json({"error": "Latest chapter must be a whole number"}, HTTPStatus.BAD_REQUEST)
            try:
                job = INGEST.start(str(data.get("series", "")), latest)
            except ValueError as e:
                return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
            return self.send_json(job, HTTPStatus.ACCEPTED)
        parts = path.split("/")  # ['', 'api', 'ingest', <id>, <action>]
        if len(parts) == 5 and parts[:3] == ["", "api", "ingest"] and parts[4] == "cancel":
            ok = INGEST.cancel(parts[3])
            return self.send_json({"ok": ok}, HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND)
        if len(parts) == 5 and parts[:3] == ["", "api", "ingest"] and parts[4] == "retry":
            try:
                chapter = data.get("chapter")
                return self.send_json(INGEST.retry(parts[3], str(chapter) if chapter is not None else None), HTTPStatus.ACCEPTED)
            except KeyError:
                return self.send_json({"error": "unknown job"}, HTTPStatus.NOT_FOUND)
            except ValueError as e:
                return self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/media/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        elif path.endswith((".js", ".css", ".webmanifest", "/sw.js")) or path == "/sw.js":
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-cache")
        # Service worker needs a valid scope
        if path.endswith("/sw.js") or path == "/sw.js":
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/media/", "/api/ingest")):
            super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-p", "--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    args = ap.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(HERE)))
    url = f"http://{args.host}:{args.port}/"
    print(f"Serving {DOWNLOADS} at {url}  (Ctrl+C to stop)")
    if not args.no_open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
