"""Single-user PIN auth with long-lived device sessions.

The PIN (6-8 digits) is the only credential; its hash lives in the `auth` table (set it
with `server.py --set-pin`). Each signed-in device gets a random session token in an
HttpOnly cookie; only its SHA-256 is stored, so a leaked DB can't be replayed as a cookie.

A PIN is short, so failed attempts are throttled twice: per client IP, and globally
across all IPs (spreading guesses over many addresses doesn't help). Until a PIN is set,
auth is off and the app stays open (the server logs a warning at startup).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from datetime import datetime, timezone

import db

COOKIE = "comikflix_session"
SESSION_DAYS = 365
PBKDF2_ITERS = 600_000

# Login throttle: 5 misses from one IP in 15 min locks that IP out; 20 misses from
# anywhere in an hour locks PIN sign-in for everyone (signed-in devices are unaffected).
IP_LIMIT = (5, 15 * 60)
GLOBAL_LIMIT = (20, 60 * 60)
GLOBAL_KEY = "*all*"
PIN_DIGITS = (6, 8)
_fails: dict[str, list[float]] = {}
_fails_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get(key: str) -> str | None:
    row = db.get_conn().execute("SELECT value FROM auth WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def enabled() -> bool:
    # A pre-PIN password hash still counts, so upgrading never leaves the app open.
    return _get("pin_hash") is not None or _get("password_hash") is not None


def _hash_secret(secret: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", secret.encode(), salt, PBKDF2_ITERS)
    return f"pbkdf2_sha256${PBKDF2_ITERS}${salt.hex()}${digest.hex()}"


def _put(key: str, value: str | None) -> None:
    with db.transaction() as c:
        if value is None:
            c.execute("DELETE FROM auth WHERE key = ?", (key,))
        else:
            c.execute(
                "INSERT INTO auth (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )


def valid_pin_format(pin: str) -> bool:
    return pin.isdigit() and PIN_DIGITS[0] <= len(pin) <= PIN_DIGITS[1]


def set_pin(pin: str) -> None:
    """Store a new PIN and sign out every device."""
    _put("pin_hash", _hash_secret(pin))
    _put("pin_length", str(len(pin)))
    _put("password_hash", None)  # the PIN replaces the old password
    with db.transaction() as c:
        c.execute("DELETE FROM sessions")


def pin_length() -> int:
    """Digits in the PIN (0 = none). Lets the login screen sign in on the last digit."""
    return int(_get("pin_length") or 0) if _get("pin_hash") else 0


def check_pin(pin: str) -> bool:
    stored = _get("pin_hash")
    if not stored or not pin.isdigit():
        return False
    try:
        _, iters, salt, digest = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), int(iters))
    except ValueError:
        return False
    return hmac.compare_digest(got.hex(), digest)


def _recent(key: str, window: int) -> list[float]:
    recent = [t for t in _fails.get(key, []) if time.time() - t < window]
    _fails[key] = recent
    return recent


def locked_out(ip: str) -> str | None:
    """Why sign-in is blocked for this IP right now, or None."""
    with _fails_lock:
        if len(_recent(GLOBAL_KEY, GLOBAL_LIMIT[1])) >= GLOBAL_LIMIT[0]:
            return "Too many wrong PINs. Sign-in is paused for up to an hour."
        if len(_recent(ip, IP_LIMIT[1])) >= IP_LIMIT[0]:
            return "Too many attempts. Try again in 15 minutes."
    return None


def record_failure(ip: str) -> None:
    with _fails_lock:
        now = time.time()
        _fails.setdefault(ip, []).append(now)
        _fails.setdefault(GLOBAL_KEY, []).append(now)


def clear_failures(ip: str) -> None:
    with _fails_lock:
        _fails.pop(ip, None)


def valid_api_token(header: str | None) -> bool:
    """Server-to-server access (e.g. the Jarvis MCP): `Authorization: Bearer <COMIKFLIX_API_TOKEN>`."""
    expected = os.environ.get("COMIKFLIX_API_TOKEN", "").strip()
    if not expected or not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].strip(), expected)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_agent: str) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    with db.transaction() as c:
        c.execute(
            "INSERT INTO sessions (token_hash, created_at, last_seen, user_agent) VALUES (?, ?, ?, ?)",
            (_hash(token), now, now, (user_agent or "")[:300]),
        )
    return token


def valid_session(token: str | None) -> bool:
    if not token:
        return False
    h = _hash(token)
    row = db.get_conn().execute("SELECT created_at, last_seen FROM sessions WHERE token_hash = ?", (h,)).fetchone()
    if not row:
        return False
    created = datetime.fromisoformat(row["created_at"])
    if (datetime.now(timezone.utc) - created).days >= SESSION_DAYS:
        delete_session(token)
        return False
    # Touch last_seen at most hourly to keep reads cheap.
    last = datetime.fromisoformat(row["last_seen"])
    if (datetime.now(timezone.utc) - last).total_seconds() > 3600:
        with db.transaction() as c:
            c.execute("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", (_now(), h))
    return True


def delete_session(token: str | None) -> None:
    if not token:
        return
    with db.transaction() as c:
        c.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))
