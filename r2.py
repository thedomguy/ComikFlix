"""Cloudflare R2 via the bearer-token REST API (same approach as jarvis-mcp).

https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects/{key}

Required environment variables (e.g. in /etc/comikflix.env):

    CLOUDFLARE_API_TOKEN     # Account API token with R2 Object Read & Write
    CLOUDFLARE_ACCOUNT_ID

Optional:

    R2_BUCKET               # default: comikflix-media
    R2_PUBLIC_BASE_URL      # CDN/public URL (no trailing slash). If unset, uploads
                            # get relative /api/r2/<key> URLs that the app proxies.

Object key layout:

    {slug}/chapter-{id}/{page:03d}.webp
    {slug}/cover.{ext}
"""
from __future__ import annotations

import json
import mimetypes
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REQUIRED_ENV = (
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
)

DEFAULT_BUCKET = "comikflix-media"
PROXY_PREFIX = "/api/r2/"


class R2ConfigError(RuntimeError):
    """Raised when R2 env is incomplete or the client cannot be built."""


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def missing_env() -> list[str]:
    return [k for k in REQUIRED_ENV if not _env(k)]


def is_configured() -> bool:
    return not missing_env()


def bucket_name() -> str:
    return _env("R2_BUCKET") or _env("R2_BUCKET_NAME") or DEFAULT_BUCKET


def page_key(slug: str, chapter_id: str, page_num: int) -> str:
    """R2 object key for a chapter page (1-based page_num)."""
    return f"{slug}/chapter-{chapter_id}/{page_num:03d}.webp"


def cover_key(slug: str, ext: str) -> str:
    ext = (ext or ".webp").lower()
    if not ext.startswith("."):
        ext = "." + ext
    return f"{slug}/cover{ext}"


def proxy_url_for(key: str) -> str:
    """App-relative URL served by server.py (Bearer token stays on the server)."""
    return PROXY_PREFIX + urllib.parse.quote(key.lstrip("/"), safe="/")


def public_url_for(key: str) -> str:
    """CDN URL if R2_PUBLIC_BASE_URL is set, otherwise the local proxy path."""
    base = _env("R2_PUBLIC_BASE_URL").rstrip("/")
    if base:
        return f"{base}/{key.lstrip('/')}"
    return proxy_url_for(key)


class R2Client:
    """Thin R2 uploader/downloader using Cloudflare's REST API (no S3 keys)."""

    def __init__(self, *, account_id: str, api_token: str, bucket: str,
                 public_base: str = "", timeout: int = 120):
        self.account_id = account_id
        self.api_token = api_token
        self.bucket = bucket
        self.public_base = (public_base or "").rstrip("/")
        self.timeout = timeout
        self.base_url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/r2/buckets/{bucket}/objects"
        )

    @classmethod
    def from_env(cls) -> "R2Client":
        missing = missing_env()
        if missing:
            raise R2ConfigError(
                "R2 is not configured. Set these in /etc/comikflix.env (same as "
                f"jarvis-mcp): {', '.join(missing)}"
            )
        return cls(
            account_id=_env("CLOUDFLARE_ACCOUNT_ID"),
            api_token=_env("CLOUDFLARE_API_TOKEN"),
            bucket=bucket_name(),
            public_base=_env("R2_PUBLIC_BASE_URL"),
        )

    def _url(self, key: str) -> str:
        return f"{self.base_url}/{urllib.parse.quote(key.lstrip('/'), safe='/')}"

    def _headers(self, content_type: str | None = None) -> dict:
        h = {"Authorization": f"Bearer {self.api_token}"}
        if content_type:
            h["Content-Type"] = content_type
        return h

    def public_url(self, key: str) -> str:
        if self.public_base:
            return f"{self.public_base}/{key.lstrip('/')}"
        return proxy_url_for(key)

    def upload_file(self, path: Path, key: str, content_type: str | None = None) -> str:
        path = Path(path)
        if not path.is_file() or path.stat().st_size <= 0:
            raise RuntimeError(f"refusing to upload empty/missing file: {path}")
        ctype = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return self.upload_bytes(path.read_bytes(), key, ctype)

    def upload_bytes(self, data: bytes, key: str, content_type: str) -> str:
        if not data:
            raise RuntimeError(f"refusing to upload empty bytes for key {key}")
        req = urllib.request.Request(
            self._url(key),
            data=data,
            method="PUT",
            headers=self._headers(content_type),
        )
        try:
            urllib.request.urlopen(req, timeout=self.timeout).close()
        except urllib.error.HTTPError as e:
            body = e.read()[:300]
            raise RuntimeError(f"R2 PUT failed ({e.code}) for {key}: {body!r}") from None
        return self.public_url(key)

    def read(self, key: str) -> bytes:
        req = urllib.request.Request(self._url(key), headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFoundError(key) from None
            body = e.read()[:300]
            raise RuntimeError(f"R2 GET failed ({e.code}) for {key}: {body!r}") from None

    def head(self, key: str) -> tuple[int, str | None]:
        """Return (content_length, content_type). Raises FileNotFoundError if missing."""
        req = urllib.request.Request(self._url(key), method="HEAD", headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                length = int(resp.headers.get("Content-Length") or 0)
                ctype = resp.headers.get("Content-Type")
                return length, ctype
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise FileNotFoundError(key) from None
            body = e.read()[:300]
            raise RuntimeError(f"R2 HEAD failed ({e.code}) for {key}: {body!r}") from None

    def delete(self, key: str) -> None:
        """Delete one object; missing keys are ignored."""
        req = urllib.request.Request(self._url(key), method="DELETE", headers=self._headers())
        try:
            urllib.request.urlopen(req, timeout=self.timeout).close()
        except urllib.error.HTTPError as e:
            if e.code != 404:
                body = e.read()[:300]
                raise RuntimeError(f"R2 DELETE failed ({e.code}) for {key}: {body!r}") from None

    def list_keys(self, prefix: str = "", *, per_page: int = 1000) -> list[str]:
        """List object keys in the bucket (optionally under prefix)."""
        keys: list[str] = []
        cursor = None
        while True:
            q = [f"per_page={per_page}"]
            if prefix:
                q.append(f"prefix={urllib.parse.quote(prefix)}")
            if cursor:
                q.append(f"cursor={urllib.parse.quote(cursor)}")
            url = (
                f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}"
                f"/r2/buckets/{self.bucket}/objects?{'&'.join(q)}"
            )
            req = urllib.request.Request(url, headers=self._headers())
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read())
            result = data.get("result")
            objs = result if isinstance(result, list) else (result or {}).get("objects") or []
            for o in objs:
                if isinstance(o, str):
                    keys.append(o)
                elif isinstance(o, dict):
                    k = o.get("key") or o.get("name")
                    if k:
                        keys.append(k)
            cursor = None
            if isinstance(result, dict):
                cursor = result.get("cursor") or result.get("truncated_token")
            # Cloudflare often returns truncated via result_info
            info = data.get("result_info") or {}
            cursor = cursor or info.get("cursor")
            if not cursor:
                break
        return keys

    def ensure_bucket(self) -> None:
        """Create the bucket if it does not already exist (idempotent)."""
        list_url = (
            f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/r2/buckets"
        )
        req = urllib.request.Request(
            list_url,
            data=json_bytes({"name": self.bucket}),
            method="POST",
            headers={**self._headers("application/json")},
        )
        try:
            urllib.request.urlopen(req, timeout=self.timeout).close()
        except urllib.error.HTTPError as e:
            body = e.read()
            # 409 / already exists is fine
            if e.code in (409, 400) and b"already exists" in body.lower():
                return
            if e.code == 409:
                return
            raise RuntimeError(f"R2 create bucket failed ({e.code}): {body[:300]!r}") from None


def json_bytes(obj: dict) -> bytes:
    return json.dumps(obj).encode()


def get_client() -> R2Client:
    """Build an R2Client from env, or raise R2ConfigError with a clear message."""
    return R2Client.from_env()
