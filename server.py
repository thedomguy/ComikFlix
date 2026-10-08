#!/usr/bin/env python3
"""Local comic reader: a Netflix-style library over SQLite metadata.

Usage:
    ./server.py [-p PORT] [--host HOST] [--no-open]

Library metadata lives in SQLite (see db.py). Optional env COMIKFLIX_DB overrides the
DB path (default: data/comikflix.db). Page images currently render from Asura CDN URLs;
R2 ingest + /media remain available for a later cutover.

The "Add Comic" / "Update" buttons run ingest.py in the background.
"""
import argparse
import json
import mimetypes
import re
import threading
import webbrowser
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import db
import ingest
import r2

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"
WEB = HERE / "web"
INGEST = ingest.IngestManager()

# PWA / static MIME fixes
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def title_from_slug(slug: str) -> str:
    slug = re.sub(r"-[0-9a-f]{8}$", "", slug)
    return slug.replace("-", " ").title()


def _asura_cdn_slug(series_slug: str) -> str:
    """Asura CDN folder is usually the slug without the trailing 8-hex id."""
    return re.sub(r"-[0-9a-f]{8}$", "", series_slug)


def _synthesize_asura_cdn(series_slug: str, chapter_id: str, page_index: int) -> str:
    """Best-effort Asura image URL when manifests omitted the original src."""
    page_num = int(page_index) + 1
    return (
        f"https://cdn.asurascans.com/asura-images/chapters/"
        f"{_asura_cdn_slug(series_slug)}/{chapter_id}/{page_num:03d}.webp"
    )


def _page_src(
    series_slug: str,
    chapter_id: str,
    page_index: int,
    cdn_url: str | None = None,
) -> str | None:
    """Always render Asura CDN for now (ignore R2/local binaries)."""
    if cdn_url and str(cdn_url).startswith("http"):
        return cdn_url
    return _synthesize_asura_cdn(series_slug, chapter_id, page_index)


def _cover_urls(row) -> tuple[str | None, str | None]:
    """Poster: remote http cover only; otherwise fall back to first page in scan_library."""
    cover_url = row["cover_url"]
    if cover_url and str(cover_url).startswith("http"):
        return cover_url, None
    return None, None


def scan_library() -> list[dict]:
    """Build the library JSON from SQLite (not filesystem series.json)."""
    db.init_schema()
    series_list = []
    for row in db.list_series_rows():
        slug = row["slug"]
        chapters_out = []
        for ch in db.list_chapters(slug):
            chapter_id = ch["chapter_id"]
            pages_out = []
            for pg in db.list_pages(slug, chapter_id):
                keys = pg.keys()
                cdn = pg["cdn_url"] if "cdn_url" in keys else None
                src = _page_src(slug, chapter_id, pg["page_index"], cdn)
                if not src:
                    continue
                aspect = pg["aspect_ratio"]
                pages_out.append({
                    "src": src,
                    "aspect": aspect.replace(" ", "") if aspect else None,
                })
            # Skip chapters with no readable pages
            if not pages_out:
                continue
            chapters_out.append({
                "id": chapter_id,
                "pages": pages_out,
                "size": 0,  # binaries not served locally/R2 while on CDN-only mode
                "source_url": ch["source_url"],
                "date": ch["published_at"],
                "status": ch["status"],
            })
        if not chapters_out:
            continue

        first = chapters_out[0]
        title = row["title"] or title_from_slug(slug)
        poster, _ = _cover_urls(row)
        backdrop = first["pages"][0]["src"]
        if not poster:
            poster = backdrop

        def _j(text, default=None):
            if not text:
                return default
            try:
                return json.loads(text)
            except (TypeError, ValueError):
                return default

        remote = _j(row["remote_chapters_json"])
        release = _j(row["release_json"])
        genres = _j(row["genres_json"], []) or []
        alt_titles = _j(row["alt_titles_json"], []) or []

        series_list.append({
            "slug": slug,
            "title": title,
            "description": row["description"],
            "genres": genres,
            "status": row["status"],
            "author": row["author"],
            "artist": row["artist"],
            "type": row["type"],
            "rating": row["rating"],
            "alt_titles": alt_titles,
            "next_release": release,
            "release_date": row["release_date"],
            "remote_total": len(remote) if isinstance(remote, list) else None,
            "source_url": row["source_url"] or first.get("source_url"),
            "poster": poster,
            "backdrop": backdrop,
            "size": sum(c["size"] for c in chapters_out),
            "chapters": chapters_out,
        })
    return series_list


def _read_json_body(handler: SimpleHTTPRequestHandler, max_bytes: int = 65536) -> tuple[dict | None, str | None]:
    try:
        length = int(handler.headers.get("Content-Length") or 0)
        raw = handler.rfile.read(min(length, max_bytes)) or b"{}"
        return json.loads(raw), None
    except ValueError:
        return None, "invalid JSON"


class Handler(SimpleHTTPRequestHandler):
    """Serves web/ at /, downloads/ at /media/, and JSON APIs under /api/."""

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

    def _require_json_mutation(self) -> dict | None:
        if not self.same_origin() or "application/json" not in (self.headers.get("Content-Type") or ""):
            self.send_json({"error": "forbidden"}, HTTPStatus.FORBIDDEN)
            return None
        data, err = _read_json_body(self)
        if err:
            self.send_json({"error": err}, HTTPStatus.BAD_REQUEST)
            return None
        return data

    def _send_r2_object(self, key: str) -> None:
        """Proxy a private R2 object so the browser never needs the API token."""
        if not key or ".." in key.split("/"):
            return self.send_error(HTTPStatus.BAD_REQUEST, "bad key")
        try:
            client = r2.get_client()
            data = client.read(key)
        except r2.R2ConfigError as e:
            return self.send_json({"error": str(e)}, HTTPStatus.SERVICE_UNAVAILABLE)
        except FileNotFoundError:
            return self.send_error(HTTPStatus.NOT_FOUND, "not found")
        except Exception as e:
            return self.send_json({"error": str(e)}, HTTPStatus.BAD_GATEWAY)
        ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/library":
            return self.send_json(scan_library())
        if path == "/api/settings":
            return self.send_json(db.get_settings())
        if path == "/api/progress":
            return self.send_json(db.get_progress())
        if path == "/api/ingest":
            return self.send_json(INGEST.list())
        if path.startswith("/api/ingest/"):
            job = INGEST.snapshot(path.rsplit("/", 1)[-1])
            return self.send_json(job or {"error": "unknown job"}, HTTPStatus.OK if job else HTTPStatus.NOT_FOUND)
        if path.startswith(r2.PROXY_PREFIX):
            key = unquote(path[len(r2.PROXY_PREFIX):])
            return self._send_r2_object(key)
        super().do_GET()

    def do_PUT(self):
        path = self.path.split("?", 1)[0]
        data = self._require_json_mutation()
        if data is None:
            return
        if path == "/api/settings":
            return self.send_json(db.put_settings(data))
        if path == "/api/progress":
            return self.send_json(db.put_progress_all(data))
        parts = path.split("/")
        if len(parts) == 4 and parts[:3] == ["", "api", "progress"]:
            slug = unquote(parts[3])
            return self.send_json(db.put_progress_slug(slug, data))
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_PATCH(self):
        path = self.path.split("?", 1)[0]
        data = self._require_json_mutation()
        if data is None:
            return
        parts = path.split("/")
        if len(parts) == 4 and parts[:3] == ["", "api", "series"]:
            slug = unquote(parts[3])
            updated = db.patch_series(slug, data)
            if not updated:
                return self.send_json({"error": "unknown series"}, HTTPStatus.NOT_FOUND)
            return self.send_json(updated)
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        data = self._require_json_mutation()
        if data is None:
            return
        if path == "/api/ingest":
            latest = data.get("latest")
            try:
                latest = int(latest) if latest not in (None, "") else None
            except (TypeError, ValueError):
                return self.send_json({"error": "Latest chapter must be a whole number"}, HTTPStatus.BAD_REQUEST)
            start_chapter = data.get("start_chapter")
            if start_chapter in (None, ""):
                return self.send_json({"error": "start_chapter is required"}, HTTPStatus.BAD_REQUEST)
            try:
                job = INGEST.start(str(data.get("series", "")), latest=latest, start_chapter=start_chapter)
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
        if path.startswith("/media/") or path.startswith(r2.PROXY_PREFIX):
            # /api/r2/ sets Cache-Control in _send_r2_object; /media/ uses day cache.
            if path.startswith("/media/"):
                self.send_header("Cache-Control", "public, max-age=86400")
        elif path.endswith((".js", ".css", ".webmanifest", "/sw.js")) or path == "/sw.js":
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "no-cache")
        # Omit Service-Worker-Allowed: / so a subpath deploy (e.g. /readers/)
        # cannot claim the whole host via the service worker.
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/media/", "/api/ingest", r2.PROXY_PREFIX)):
            super().log_message(fmt, *args)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-p", "--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="don't open a browser tab")
    args = ap.parse_args()

    db.init_schema()
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(HERE)))
    url = f"http://{args.host}:{args.port}/"
    print(f"Serving library from {db.db_path()}  media={DOWNLOADS}  at {url}  (Ctrl+C to stop)")
    if not args.no_open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
