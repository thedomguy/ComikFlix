"""Shared HTTP opener for connection reuse across HTML and image downloads."""
from __future__ import annotations

import threading
import urllib.request

_lock = threading.Lock()
_opener: urllib.request.OpenerDirector | None = None

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)


def get_opener() -> urllib.request.OpenerDirector:
    global _opener
    with _lock:
        if _opener is None:
            _opener = urllib.request.build_opener()
        return _opener


def open_url(url: str, headers: dict | None = None, timeout: float = 30.0):
    hdrs = {"User-Agent": USER_AGENT}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    return get_opener().open(req, timeout=timeout)
