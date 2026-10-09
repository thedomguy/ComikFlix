#!/usr/bin/env python3
"""Local comic reader: a Netflix-style library over SQLite metadata.

Usage:
    ./server.py [-p PORT] [--host HOST] [--no-open]
    ./server.py --set-pin          # turn on the PIN login (or change it; signs out all devices)

Library metadata lives in SQLite (see db.py). Optional env COMIKFLIX_DB overrides the
DB path (default: data/comikflix.db). Page images and default ingest currently use Asura
CDN URLs only; R2 upload (sync_library --download) + /media remain for a later cutover.

The "Add Comic" / "Update" buttons run ingest.py in the background.
"""
import argparse
import getpass
import gzip
import hashlib
import json
import mimetypes
import os
import queue
import re
import threading
import webbrowser
from functools import partial
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import auth
import db
import ingest
import r2
import remote

HERE = Path(__file__).resolve().parent
DOWNLOADS = HERE / "downloads"
# The React app (frontend/, `npm run build`) builds into web-dist/; until that exists, or
# with COMIKFLIX_WEB=web, the original vanilla app in web/ is served.
WEB = HERE / (os.environ.get("COMIKFLIX_WEB") or ("web-dist" if (HERE / "web-dist" / "index.html").exists() else "web"))
INGEST = ingest.IngestManager()

# PWA / static MIME fixes
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")


def title_from_slug(slug: str) -> str:
    slug = re.sub(r"-[0-9a-f]{8}$", "", slug)
    return slug.replace("-", " ").title()


def _page_src(cdn_url: str | None) -> str | None:
    """Scraped Asura CDN url only (R2/local binaries ignored for now; nothing is guessed)."""
    if cdn_url and str(cdn_url).startswith("http"):
        return cdn_url
    return None


def _cover_urls(row) -> tuple[str | None, str | None]:
    """Poster: remote http cover only; otherwise fall back to first page in scan_library."""
    cover_url = row["cover_url"]
    if cover_url and str(cover_url).startswith("http"):
        return cover_url, None
    return None, None


def _json_field(text, default=None):
    if not text:
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


def _pages_payload(slug: str, chapter_id: str) -> list[dict]:
    """Build reader page objects for one chapter."""
    pages_out = []
    for pg in db.list_pages(slug, chapter_id):
        keys = pg.keys()
        cdn = pg["cdn_url"] if "cdn_url" in keys else None
        src = _page_src(cdn)
        if not src:
            continue
        aspect = pg["aspect_ratio"]
        pages_out.append({
            "src": src,
            "aspect": aspect.replace(" ", "") if aspect else None,
        })
    return pages_out


def _chapter_page_count(slug: str, ch) -> int:
    """Prefer chapters.page_count; fall back to counting page rows."""
    try:
        n = int(ch["page_count"] or 0)
    except (TypeError, ValueError):
        n = 0
    if n > 0:
        return n
    row = db.get_conn().execute(
        "SELECT COUNT(*) AS n FROM pages WHERE series_slug = ? AND chapter_id = ?",
        (slug, ch["chapter_id"]),
    ).fetchone()
    return int(row["n"]) if row else 0


def _first_page_src(slug: str, chapter_id: str) -> str | None:
    pg = db.first_page(slug, chapter_id)
    return _page_src(pg["cdn_url"]) if pg else None


def scan_library() -> list[dict]:
    """Thin library index: series + chapter metadata, no page URL arrays.

    Chapter entries carry only what the clients use (id, page_count, date); the reader
    gets everything else per chapter from /api/series/<slug>/chapters/<id>."""
    series_list = []
    for row in db.list_series_rows():
        slug = row["slug"]
        chapters_out = []
        first_source_url = None
        for ch in db.list_chapters(slug):
            page_count = _chapter_page_count(slug, ch)
            if page_count <= 0:
                continue
            if not chapters_out:
                first_source_url = ch["source_url"]
            chapters_out.append({
                "id": ch["chapter_id"],
                "page_count": page_count,
                "date": ch["published_at"],
            })
        if not chapters_out:
            continue

        first = chapters_out[0]
        title = row["title"] or title_from_slug(slug)
        poster, _ = _cover_urls(row)
        backdrop = _first_page_src(slug, first["id"])
        if not poster:
            poster = backdrop
        backdrop = backdrop or poster

        remote = _json_field(row["remote_chapters_json"])
        release = _json_field(row["release_json"])
        genres = _json_field(row["genres_json"], []) or []
        alt_titles = _json_field(row["alt_titles_json"], []) or []

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
            "source_url": row["source_url"] or first_source_url,
            "poster": poster,
            "backdrop": backdrop,
            "size": 0,
            "page_total": sum(c["page_count"] for c in chapters_out),
            "chapters": chapters_out,
        })
    return series_list


# /api/library is built once per DB state and served from memory (raw + gzip + ETag).
_library_lock = threading.Lock()
_library_cache: dict = {}


def _library_fingerprint() -> tuple:
    """Cheap state key: in-process write counter plus aggregates that also move when another
    process (sync_library.py, ingest.py CLI) writes to the DB."""
    conn = db.get_conn()
    version = db.write_version()  # read before the aggregates: a later write forces a rebuild
    s = conn.execute("SELECT MAX(updated_at), COUNT(*) FROM series").fetchone()
    c = conn.execute("SELECT COUNT(*), TOTAL(page_count), MAX(published_at) FROM chapters").fetchone()
    return (version, s[0], s[1], c[0], c[1], c[2])


def library_response() -> dict:
    """{"body": bytes, "gzip": bytes, "etag": str} for the current library."""
    with _library_lock:
        key = _library_fingerprint()
        if _library_cache.get("key") != key:
            body = json.dumps(scan_library(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            _library_cache.update(
                key=key,
                body=body,
                gzip=gzip.compress(body, compresslevel=6, mtime=0),
                etag='W/"%s"' % hashlib.sha1(body).hexdigest()[:20],
            )
        return dict(_library_cache)


def _etag_matches(header: str | None, etag: str) -> bool:
    """If-None-Match uses weak comparison."""
    if not header:
        return False
    want = etag[2:] if etag.startswith("W/") else etag
    for tag in header.split(","):
        tag = tag.strip()
        if tag == "*":
            return True
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == want:
            return True
    return False


def _accepts_gzip(header: str | None) -> bool:
    for part in (header or "").split(","):
        name, _, params = part.partition(";")
        if name.strip().lower() != "gzip":
            continue
        for param in params.split(";"):
            k, _, v = param.partition("=")
            if k.strip().lower() == "q":
                try:
                    return float(v) > 0
                except ValueError:
                    return False
        return True
    return False


_scrape_locks: dict[tuple[str, str], threading.Lock] = {}
_scrape_locks_guard = threading.Lock()


def _ensure_scraped(slug: str, chapter_id: str) -> None:
    """Chapters outside an ingest's range (or whose ingest failed / was cancelled) have no
    page URLs yet: capture them from the chapter's reader page the first time it's opened."""
    with _scrape_locks_guard:
        lock = _scrape_locks.setdefault((slug, chapter_id), threading.Lock())
    with lock:
        row = db.get_conn().execute(
            "SELECT status FROM chapters WHERE series_slug = ? AND chapter_id = ?",
            (slug, chapter_id),
        ).fetchone()
        if not row or row["status"] == "ready":
            return
        try:
            ingest.ingest_chapter_metadata(slug, chapter_id, timeout=10)
        except Exception as e:
            print(f"[reader] could not scrape {slug} ch{chapter_id}: {e}")


def get_chapter(slug: str, chapter_id: str) -> dict | None:
    """Full chapter payload including page srcs (loaded when opening the reader)."""
    ch = db.get_conn().execute(
        "SELECT * FROM chapters WHERE series_slug = ? AND chapter_id = ?",
        (slug, str(chapter_id)),
    ).fetchone()
    if not ch:
        return None
    if ch["status"] != "ready":
        _ensure_scraped(slug, str(chapter_id))
        ch = db.get_conn().execute(
            "SELECT * FROM chapters WHERE series_slug = ? AND chapter_id = ?",
            (slug, str(chapter_id)),
        ).fetchone()
    pages = _pages_payload(slug, str(chapter_id))
    if not pages:
        return None
    return {
        "id": str(chapter_id),
        "pages": pages,
        "page_count": len(pages),
        "size": 0,
        "source_url": ch["source_url"],
        "date": ch["published_at"],
        "status": ch["status"],
    }


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

    def send_library(self) -> None:
        """GET /api/library from the in-memory cache: 304 on a matching ETag, else the
        pre-gzipped (or raw) body. no-cache (not no-store) so the browser revalidates."""
        lib = library_response()
        etag = lib["etag"]
        if _etag_matches(self.headers.get("If-None-Match"), etag):
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "private, no-cache")
            self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return
        use_gzip = _accepts_gzip(self.headers.get("Accept-Encoding"))
        body = lib["gzip"] if use_gzip else lib["body"]
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, no-cache")
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

    # ---- auth ----

    def client_ip(self) -> str:
        # Bound to 127.0.0.1 behind nginx, which passes the real client in X-Real-IP.
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def session_token(self) -> str | None:
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie") or "")
        except Exception:
            return None
        m = jar.get(auth.COOKIE)
        return m.value if m else None

    def authed(self) -> bool:
        return (
            not auth.enabled()
            or auth.valid_api_token(self.headers.get("Authorization"))
            or auth.valid_session(self.session_token())
        )

    def blocked(self, path: str) -> bool:
        """Gate data APIs and media behind a session; the static shell stays public."""
        if path in ("/api/me", "/api/login", "/api/logout"):
            return False
        if not (path.startswith("/api/") or path.startswith("/media/")):
            return False
        if self.authed():
            return False
        self.send_json({"error": "login required"}, HTTPStatus.UNAUTHORIZED)
        return True

    def set_session_cookie(self, token: str, base: str, max_age: int) -> None:
        # The app may live under a subpath (/readers); scope the cookie to it.
        base = base if re.fullmatch(r"(/[A-Za-z0-9._-]+)*", base or "") else ""
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self.send_header(
            "Set-Cookie",
            f"{auth.COOKIE}={token}; Path={base or '/'}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}",
        )

    def login(self, data: dict) -> None:
        ip = self.client_ip()
        if not auth.enabled():
            return self.send_json({"ok": True})
        blocked = auth.locked_out(ip)
        if blocked:
            return self.send_json({"error": blocked}, HTTPStatus.TOO_MANY_REQUESTS)
        if not auth.check_pin(str(data.get("pin") or "")):
            auth.record_failure(ip)
            return self.send_json({"error": "Wrong PIN"}, HTTPStatus.UNAUTHORIZED)
        auth.clear_failures(ip)
        token = auth.create_session(self.headers.get("User-Agent", ""))
        body = json.dumps({"ok": True}).encode()
        self.send_response(HTTPStatus.OK)
        self.set_session_cookie(token, str(data.get("base") or ""), auth.SESSION_DAYS * 86400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def logout(self, data: dict) -> None:
        auth.delete_session(self.session_token())
        body = b'{"ok": true}'
        self.send_response(HTTPStatus.OK)
        self.set_session_cookie("", str(data.get("base") or ""), 0)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def ingest_source(self, data: dict) -> tuple[str, list[str]]:
        """Who started a download, for the history: the app, or e.g. Jarvis on behalf of ChatGPT.
        Callers identify themselves with `X-ComikFlix-Source: jarvis:chatgpt`; extra `tags` may
        come in the body. Tags are normalised to short lowercase labels."""
        clean = lambda v: re.sub(r"[^a-z0-9:._-]+", "-", str(v).strip().lower())[:60].strip("-")  # noqa: E731
        source = clean(self.headers.get("X-ComikFlix-Source") or "") or "app"
        via, _, client = source.partition(":")
        tags = [f"via:{via}"] + ([f"client:{client}"] if client else [])
        extra = data.get("tags")
        if isinstance(extra, list):
            tags += [t for t in (clean(x) for x in extra[:10]) if t]
        return source, list(dict.fromkeys(tags))

    def downloads(self) -> list[dict]:
        """Every download attempt ever, newest first; running ones use the live in-memory state."""
        rows = db.list_ingest_jobs()
        for r in rows:
            if r["state"] == "running":
                live = INGEST.snapshot(r["id"])
                if live:
                    counts: dict[str, int] = {}
                    for c in live["chapters"].values():
                        counts[c["state"]] = counts.get(c["state"], 0) + 1
                    r.update(
                        title=live["title"] or r["title"], stage=live["stage"], counts=counts,
                        state=live["state"], log=live["log"][-30:],
                        failed=[n for n, c in live["chapters"].items() if c["state"] == "failed"],
                    )
        return rows

    # ---- remote control (server-sent events) ----

    def sse_start(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Accel-Buffering", "no")  # nginx: stream, don't buffer
        self.end_headers()
        self.wfile.write(b"retry: 2000\n\n")
        self.wfile.flush()

    def sse_send(self, event: str, data) -> None:
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()

    def sse_ping(self) -> None:
        self.wfile.write(b": ping\n\n")
        self.wfile.flush()

    def serve_screen(self, sid: str, name: str) -> None:
        """A tab that can be driven: streams commands until it disconnects."""
        screen, conn = remote.connect_screen(sid, name)
        try:
            self.sse_start()
            self.sse_send("hello", {"id": sid})
            while screen.conn is conn:
                try:
                    cmd = screen.commands.get(timeout=remote.HEARTBEAT)
                except queue.Empty:
                    self.sse_ping()
                    continue
                if screen.conn is not conn:  # superseded by a reconnect: hand it over
                    remote.send_command(sid, cmd)
                    break
                self.sse_send("cmd", cmd)
        except OSError:
            pass  # client went away
        finally:
            remote.disconnect_screen(screen, conn)

    def serve_watch(self, sid: str) -> None:
        """A remote following one screen's state."""
        q, current = remote.watch(sid)
        try:
            self.sse_start()
            self.sse_send("state", current) if current else self.sse_send("gone", {})
            while True:
                try:
                    event, data = q.get(timeout=remote.HEARTBEAT)
                except queue.Empty:
                    self.sse_ping()
                    continue
                self.sse_send(event, data)
        except OSError:
            pass
        finally:
            remote.unwatch(sid, q)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if self.blocked(path):
            return
        if path == "/api/me":
            return self.send_json({"auth": auth.enabled(), "authed": self.authed(), "pin": auth.pin_length()})
        if path.startswith("/api/remote/"):
            qs = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            sid = qs.get("id", "")[:64]
            if path == "/api/remote/screens":
                return self.send_json(remote.list_screens())
            if not sid:
                return self.send_json({"error": "id is required"}, HTTPStatus.BAD_REQUEST)
            if path == "/api/remote/screen":
                return self.serve_screen(sid, qs.get("name", "")[:80])
            if path == "/api/remote/watch":
                return self.serve_watch(sid)
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        if path == "/api/downloads":
            return self.send_json(self.downloads())
        if path == "/api/catalog":
            q = parse_qs(urlparse(self.path).query).get("q", [""])[0][:100]
            try:
                return self.send_json(ingest.catalog_search(q))
            except Exception as e:
                return self.send_json({"error": f"Could not read the Asura catalogue: {e}"}, HTTPStatus.BAD_GATEWAY)
        if path == "/api/library":
            return self.send_library()
        if path == "/api/settings":
            return self.send_json(db.get_settings())
        if path == "/api/progress":
            return self.send_json(db.get_progress())
        if path == "/api/ingest":
            return self.send_json(INGEST.list())
        if path.startswith("/api/ingest/"):
            job = INGEST.snapshot(path.rsplit("/", 1)[-1])
            return self.send_json(job or {"error": "unknown job"}, HTTPStatus.OK if job else HTTPStatus.NOT_FOUND)
        parts = path.split("/")
        # GET /api/series/<slug>/chapters/<id>
        if (
            len(parts) == 6
            and parts[1:3] == ["api", "series"]
            and parts[4] == "chapters"
        ):
            slug, chapter_id = unquote(parts[3]), unquote(parts[5])
            chap = get_chapter(slug, chapter_id)
            if not chap:
                return self.send_json({"error": "unknown chapter"}, HTTPStatus.NOT_FOUND)
            return self.send_json(chap)
        if path.startswith(r2.PROXY_PREFIX):
            key = unquote(path[len(r2.PROXY_PREFIX):])
            return self._send_r2_object(key)
        super().do_GET()

    def do_PUT(self):
        path = self.path.split("?", 1)[0]
        if self.blocked(path):
            return
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
            # The API token means another program (Jarvis) is importing progress, not the
            # user reading: it must not reorder "Continue Reading".
            reading = not auth.valid_api_token(self.headers.get("Authorization"))
            return self.send_json(db.put_progress_slug(slug, data, reading=reading))
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def do_PATCH(self):
        path = self.path.split("?", 1)[0]
        if self.blocked(path):
            return
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
        if self.blocked(path):
            return
        data = self._require_json_mutation()
        if data is None:
            return
        if path == "/api/login":
            return self.login(data)
        if path == "/api/logout":
            return self.logout(data)
        if path == "/api/remote/signal":
            # {screen, remote, toScreen: bool, data}: WebRTC offer/answer between the two
            sid, rid = str(data.get("screen") or "")[:64], str(data.get("remote") or "")[:64]
            payload = data.get("data") if isinstance(data.get("data"), dict) else {}
            if not sid or not rid:
                return self.send_json({"error": "screen and remote are required"}, HTTPStatus.BAD_REQUEST)
            if data.get("toScreen"):
                ok = remote.send_command(sid, {"type": "signal", "from": rid, "data": payload})
            else:
                remote.signal_remotes(sid, {"to": rid, "data": payload})
                ok = True
            return self.send_json({"ok": ok}, HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND)
        if path in ("/api/remote/state", "/api/remote/cmd"):
            sid = str(data.get("id") or "")[:64]
            if path == "/api/remote/state":
                ok = remote.set_state(sid, data.get("state") if isinstance(data.get("state"), dict) else {})
            else:
                ok = isinstance(data.get("cmd"), dict) and remote.send_command(sid, data["cmd"])
            return self.send_json({"ok": ok}, HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND)
        if path == "/api/ingest":
            latest = data.get("latest")
            try:
                latest = int(latest) if latest not in (None, "") else None
            except (TypeError, ValueError):
                return self.send_json({"error": "Latest chapter must be a whole number"}, HTTPStatus.BAD_REQUEST)
            start_chapter = data.get("start_chapter")
            if start_chapter in (None, ""):
                start_chapter = 1  # only set when earlier chapters were already read elsewhere
            source, tags = self.ingest_source(data)
            try:
                job = INGEST.start(
                    str(data.get("series", "")), latest=latest, start_chapter=start_chapter, source=source, tags=tags
                )
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

    def finish(self):
        try:
            super().finish()
        finally:
            db.close_thread_conn()

    def do_HEAD(self):
        if self.blocked(self.path.split("?", 1)[0]):
            return
        super().do_HEAD()

    # Track per response whether the handler already set Cache-Control, so end_headers only
    # adds a default instead of stacking a second, conflicting one.
    _cache_control_sent = False
    _response_code = 0

    def send_response_only(self, code, message=None):
        self._cache_control_sent = False
        self._response_code = int(code)
        super().send_response_only(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control":
            self._cache_control_sent = True
        super().send_header(keyword, value)

    def _default_cache_control(self, path: str) -> str | None:
        if path.startswith(r2.PROXY_PREFIX):
            return None  # _send_r2_object sets its own; errors stay as before
        if self._response_code not in (HTTPStatus.OK, HTTPStatus.PARTIAL_CONTENT, HTTPStatus.NOT_MODIFIED):
            return "no-cache"  # never let a 404/redirect be cached long-term
        if path.startswith("/media/"):
            return "public, max-age=86400"
        if path.startswith("/assets/") and WEB.name == "web-dist":
            return "public, max-age=31536000, immutable"  # Vite content-hashed file names
        if path.startswith("/icons/"):
            return "public, max-age=604800"
        return "no-cache"  # index.html, sw.js, manifest, API responses without their own

    def end_headers(self):
        if not self._cache_control_sent:
            path = (getattr(self, "path", "") or "").split("?", 1)[0]
            value = self._default_cache_control(path)
            if value:
                self.send_header("Cache-Control", value)
        self._cache_control_sent = False
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
    ap.add_argument("--set-pin", action="store_true", help="set the login PIN (6-8 digits) and exit")
    args = ap.parse_args()

    db.init_schema()
    if args.set_pin:
        pin = getpass.getpass("New PIN (6-8 digits): ")
        if not auth.valid_pin_format(pin) or pin != getpass.getpass("Repeat: "):
            raise SystemExit("PINs must match and be 6 to 8 digits.")
        auth.set_pin(pin)
        print("PIN set. All devices were signed out; sign in again with the PIN.")
        return
    db.mark_interrupted_ingest_jobs()  # their worker threads died with the previous process
    if not auth.enabled():
        print("WARNING: no PIN set; the library is open to anyone. Run: server.py --set-pin")
    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, directory=str(HERE)))
    url = f"http://{args.host}:{args.port}/"
    print(f"Serving library from {db.db_path()}  media={DOWNLOADS}  at {url}  (Ctrl+C to stop)")

    def warm_catalog() -> None:
        # Fill ingest's 6h Asura catalogue cache so the first "Add Comic" search is instant.
        try:
            ingest.catalog_search("a")
        except Exception as e:
            print(f"Asura catalogue warm-up failed: {e}")

    threading.Thread(target=warm_catalog, name="catalog-warm", daemon=True).start()
    if not args.no_open:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
