"""In-memory relay between "screens" (app tabs that can be driven) and remotes.

A screen holds an SSE stream open and receives commands; it posts its state (what it
is showing, scroll position, ...) which is fanned out to any remotes watching it.
Nothing is persisted: a screen exists exactly while its stream is connected.

The relay also carries WebRTC signaling so a remote and its screen can open a direct
data channel (same Wi-Fi: phone -> laptop without the round trip through this server);
the HTTP command path stays as the fallback.
"""
from __future__ import annotations

import queue
import threading
import time

HEARTBEAT = 15  # seconds; keeps nginx/browsers from timing out idle streams


class _Screen:
    def __init__(self, sid: str, name: str):
        self.id = sid
        self.name = name
        self.state: dict = {}
        self.updated = time.time()
        self.commands: queue.Queue = queue.Queue(maxsize=200)
        self.conn = object()  # identity of the stream that currently owns this screen


_lock = threading.Lock()
_screens: dict[str, _Screen] = {}
_watchers: dict[str, set[queue.Queue]] = {}  # screen id -> remote queues


def _public(s: _Screen) -> dict:
    return {"id": s.id, "name": s.name, "state": s.state, "updated": s.updated}


def list_screens() -> list[dict]:
    with _lock:
        return sorted((_public(s) for s in _screens.values()), key=lambda x: -x["updated"])


def _notify(sid: str, event: str, data) -> None:
    for q in list(_watchers.get(sid, ())):
        try:
            q.put_nowait((event, data))
        except queue.Full:
            pass


def connect_screen(sid: str, name: str) -> tuple[_Screen, object]:
    """Register (or take over) a screen; returns it plus a token for disconnect_screen."""
    with _lock:
        s = _screens.get(sid)
        if s is None:
            s = _screens[sid] = _Screen(sid, name)
        s.name = name or s.name
        s.conn = conn = object()  # a reconnect supersedes the old stream
        s.updated = time.time()
        return s, conn


def disconnect_screen(s: _Screen, conn: object) -> None:
    with _lock:
        if s.conn is not conn or _screens.get(s.id) is not s:
            return  # a newer stream owns it
        del _screens[s.id]
        _notify(s.id, "gone", {})


def set_state(sid: str, state: dict) -> bool:
    with _lock:
        s = _screens.get(sid)
        if s is None:
            return False
        s.state = state
        s.updated = time.time()
        _notify(sid, "state", _public(s))
        return True


def send_command(sid: str, cmd: dict) -> bool:
    with _lock:
        s = _screens.get(sid)
    if s is None:
        return False
    try:
        s.commands.put_nowait(cmd)
    except queue.Full:
        return False
    return True


def signal_remotes(sid: str, payload: dict) -> None:
    """WebRTC signaling from a screen to the remotes watching it (each filters by `to`)."""
    with _lock:
        _notify(sid, "signal", payload)


def watch(sid: str) -> tuple[queue.Queue, dict | None]:
    q: queue.Queue = queue.Queue(maxsize=100)
    with _lock:
        _watchers.setdefault(sid, set()).add(q)
        s = _screens.get(sid)
        return q, (_public(s) if s else None)


def unwatch(sid: str, q: queue.Queue) -> None:
    with _lock:
        ws = _watchers.get(sid)
        if ws:
            ws.discard(q)
            if not ws:
                del _watchers[sid]
