"""Watch list: entry rules (statuses, ratings, duplicates, Completed vs ongoing), Asura links,
slug moves, suggestions, and the HTTP API. Run: .venv/bin/python -m unittest discover tests"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
import watchlist as wl  # noqa: E402
from watchlist import WatchlistError  # noqa: E402

NANO = "nano-machine-bd5bdaf8"
SOLO = "solo-leveling-0a1b2c3d"


def lib_series(slug, title, status="ongoing", chapters=("1", "2", "3"), remote_total=None):
    return {
        "slug": slug, "title": title, "status": status, "type": "manhwa", "author": "A", "artist": "B",
        "description": "d", "genres": ["Action"], "alt_titles": [], "poster": f"https://img/{slug}.webp",
        "source_url": f"https://asurascans.com/comics/{slug}", "remote_total": remote_total,
        "chapters": [{"id": c, "page_count": 10, "date": None} for c in chapters],
    }


def asura_info(slug, title, status="completed", moved_from=None):
    return {
        "slug": slug, "moved_from": moved_from, "source_url": f"https://asurascans.com/comics/{slug}",
        "title": title, "description": "desc", "alt_titles": [f"{title} Alt"], "cover_url": "https://img/c.webp",
        "status": status, "type": "manhwa", "author": "X", "artist": "Y", "genres": ["Fantasy"],
        "chapters": [{"number": "1"}, {"number": "200"}],
    }


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db.set_db_path(Path(self.tmp.name) / "t.db")
        db.init_schema()
        self.lib = [lib_series(NANO, "Nano Machine")]
        self.fetched = []

    def tearDown(self):
        db.close_thread_conn()
        db.set_db_path(None)
        self.tmp.cleanup()

    def fetch(self, slug):
        self.fetched.append(slug)
        return asura_info(slug, "Solo Leveling")

    def add(self, data, prog=None):
        return wl.add_entry(data, self.lib, prog or {}, fetch=self.fetch)

    def update(self, entry_id, data, prog=None):
        return wl.update_entry(entry_id, data, self.lib, prog or {}, fetch=self.fetch)


class Entries(Base):
    def test_manual_entry_with_metadata(self):
        e = self.add({"title": "Omniscient Reader", "status": "reading", "rating": 4.5, "notes": "great",
                      "series_status": "FINISHED", "type": "Webtoon", "genres": "Action, Fantasy",
                      "cover_url": "https://x/y.jpg", "chapters_total": "551"})
        self.assertEqual(e["source"], "manual")
        self.assertEqual(e["rating"], 4.5)
        self.assertEqual(e["series_status"], "completed")  # AniList's FINISHED
        self.assertEqual(e["type"], "webtoon")
        self.assertEqual(e["genres"], ["Action", "Fantasy"])
        self.assertEqual(e["chapters_total"], 551)
        self.assertFalse(e["in_library"])
        self.assertIsNone(e["asura_slug"])
        stored = db.get_conn().execute("SELECT rating FROM watchlist").fetchone()[0]
        self.assertEqual(stored, 9)  # half-stars

    def test_status_defaults_to_plan_and_accepts_words(self):
        self.assertEqual(self.add({"title": "A"})["status"], "plan")
        self.assertEqual(self.add({"title": "B", "status": "Plan to Read"})["status"], "plan")
        self.assertEqual(self.add({"title": "C", "status": "currently reading"})["status"], "reading")
        with self.assertRaises(WatchlistError):
            self.add({"title": "D", "status": "dropped"})

    def test_rating_rules(self):
        self.assertEqual(wl.parse_rating(0.5), 1)
        self.assertEqual(wl.parse_rating("5"), 10)
        self.assertIsNone(wl.parse_rating(0))
        self.assertIsNone(wl.parse_rating(None))
        for bad in (4.3, 6, -1, "x", 0.25):
            with self.assertRaises(WatchlistError):
                wl.parse_rating(bad)

    def test_title_required_and_urls_checked(self):
        with self.assertRaises(WatchlistError):
            self.add({"status": "plan"})
        with self.assertRaises(WatchlistError):
            self.add({"title": "X", "cover_url": "javascript:alert(1)"})

    def test_duplicates_by_title_alt_title_and_slug(self):
        first = self.add({"title": "The Greatest Estate Developer", "alt_titles": ["Yeokdaegeup Yeongji Seolgyesa"]})
        for data in ({"title": "the greatest estate-developer"}, {"title": "Yeokdaegeup Yeongji Seolgyesa"}):
            with self.assertRaises(WatchlistError) as cm:
                self.add(data)
            self.assertEqual(cm.exception.status, 409)
            self.assertEqual(cm.exception.extra["id"], first["id"])
        self.add({"asura": NANO})
        with self.assertRaises(WatchlistError) as cm:
            self.add({"asura": f"https://asurascans.com/comics/{NANO}/chapter/3"})
        self.assertEqual(cm.exception.status, 409)

    def test_asura_in_library_uses_library_data_without_fetching(self):
        e = self.add({"asura": NANO, "status": "reading", "rating": 5})
        self.assertEqual(self.fetched, [])
        self.assertTrue(e["in_library"])
        self.assertEqual(e["asura_slug"], NANO)
        self.assertEqual(e["title"], "Nano Machine")
        self.assertEqual(e["cover_url"], f"https://img/{NANO}.webp")

    def test_asura_not_in_library_fetches_metadata_only(self):
        e = self.add({"asura": SOLO, "status": "completed"})
        self.assertEqual(self.fetched, [SOLO])
        self.assertFalse(e["in_library"])
        self.assertEqual(e["title"], "Solo Leveling")
        self.assertEqual(e["chapters_total"], 200)
        self.assertEqual(e["series_status"], "completed")
        # nothing was added to the library
        self.assertEqual(db.get_conn().execute("SELECT COUNT(*) FROM series").fetchone()[0], 0)

    def test_asura_fetch_failure_is_a_502(self):
        def boom(slug):
            raise RuntimeError("series not found")
        with self.assertRaises(WatchlistError) as cm:
            wl.add_entry({"asura": SOLO}, self.lib, {}, fetch=boom)
        self.assertEqual(cm.exception.status, 502)


class Completed(Base):
    def test_ongoing_or_hiatus_cannot_be_completed(self):
        for status in ("ongoing", "hiatus", "Releasing"):
            with self.assertRaises(WatchlistError) as cm:
                self.add({"title": f"T {status}", "status": "completed", "series_status": status})
            self.assertEqual(cm.exception.extra["code"], "series_continuing")
        with self.assertRaises(WatchlistError):
            self.add({"asura": NANO, "status": "completed"})  # library says ongoing

    def test_ended_or_unknown_can_be_completed(self):
        self.add({"title": "Ended", "status": "completed", "series_status": "completed"})
        self.add({"title": "Cancelled", "status": "completed", "series_status": "cancelled"})
        self.add({"title": "Unknown", "status": "completed"})

    def test_update_checks_the_live_library_status(self):
        e = self.add({"asura": NANO, "status": "reading"})
        with self.assertRaises(WatchlistError):
            self.update(e["id"], {"status": "completed"})
        self.lib[0]["status"] = "completed"
        self.assertEqual(self.update(e["id"], {"status": "completed"})["status"], "completed")

    def test_editing_other_fields_of_a_completed_entry_still_works(self):
        e = self.add({"title": "S2 later", "status": "completed", "series_status": "completed"})
        self.update(e["id"], {"series_status": "ongoing"})  # season 2 announced
        out = self.update(e["id"], {"rating": 3, "notes": "n"})
        self.assertEqual(out["status"], "completed")
        self.assertEqual(out["suggestion"]["status"], "reading")


class Updates(Base):
    def test_status_rating_notes(self):
        e = self.add({"title": "A"})
        out = self.update(e["id"], {"status": "reading", "rating": 3.5, "notes": "  hi  "})
        self.assertEqual((out["status"], out["rating"], out["notes"]), ("reading", 3.5, "hi"))
        self.assertNotEqual(out["status_at"], e["status_at"])
        out = self.update(e["id"], {"rating": None, "notes": ""})
        self.assertEqual((out["rating"], out["notes"]), (None, None))

    def test_metadata_only_editable_on_manual_entries(self):
        e = self.add({"asura": NANO})
        with self.assertRaises(WatchlistError):
            self.update(e["id"], {"title": "Renamed"})
        m = self.add({"title": "Manual"})
        self.assertEqual(self.update(m["id"], {"title": "Manual 2", "author": "Z"})["author"], "Z")

    def test_link_and_unlink_asura(self):
        m = self.add({"title": "Solo Leveling (my note)", "notes": "keep", "rating": 4})
        linked = self.update(m["id"], {"asura": SOLO})
        self.assertEqual((linked["source"], linked["asura_slug"], linked["title"]), ("asura", SOLO, "Solo Leveling"))
        self.assertEqual((linked["notes"], linked["rating"]), ("keep", 4))
        unlinked = self.update(m["id"], {"asura": None})
        self.assertEqual((unlinked["source"], unlinked["title"]), ("manual", "Solo Leveling"))

    def test_link_rejects_slug_already_on_list(self):
        self.add({"asura": NANO})
        m = self.add({"title": "Other"})
        with self.assertRaises(WatchlistError) as cm:
            self.update(m["id"], {"asura": NANO})
        self.assertEqual(cm.exception.status, 409)

    def test_unknown_id_and_remove(self):
        with self.assertRaises(WatchlistError) as cm:
            self.update("nope", {"status": "plan"})
        self.assertEqual(cm.exception.status, 404)
        e = self.add({"title": "A"})
        self.assertTrue(wl.remove_entry(e["id"]))
        self.assertFalse(wl.remove_entry(e["id"]))


class Moves(Base):
    def _series(self, slug):
        now = db._now()
        with db.transaction() as c:
            c.execute("INSERT INTO series (slug, title, created_at, updated_at) VALUES (?, ?, ?, ?)", (slug, "S", now, now))

    def test_move_series_carries_the_entry(self):
        self.add({"asura": NANO})
        self._series(NANO)
        db.move_series(NANO, "nano-machine-ffffffff")
        row = db.get_conn().execute("SELECT source_id FROM watchlist").fetchone()
        self.assertEqual(row[0], "nano-machine-ffffffff")

    def test_move_merges_into_existing_entry(self):
        old = self.add({"asura": NANO, "rating": 4, "notes": "old"})
        # an entry under the new slug too (a different title, or the duplicate check stops it)
        self.lib.append(lib_series("nano-machine-ffffffff", "Nano Machine (new)"))
        new = self.add({"asura": "nano-machine-ffffffff"})
        with db.transaction() as c:
            wl.move(c, NANO, "nano-machine-ffffffff")
        rows = db.get_conn().execute("SELECT id, rating, notes FROM watchlist").fetchall()
        self.assertEqual([tuple(r) for r in rows], [(new["id"], 8, "old")])
        self.assertNotEqual(old["id"], new["id"])

    def test_refresh_follows_a_moved_series(self):
        self.lib = []
        e = self.add({"asura": SOLO})
        moved = "solo-leveling-99999999"
        out = wl.refresh_entry(e["id"], [], {}, fetch=lambda s: asura_info(moved, "Solo Leveling", moved_from=s))
        self.assertEqual(out["asura_slug"], moved)


class Suggestions(Base):
    def test_plan_to_reading_once_started(self):
        e = self.add({"asura": NANO})
        self.assertIsNone(e["suggestion"])
        prog = {NANO: {"chapter": "1", "frac": 0.5, "read": [], "read_at": 1}}
        self.assertEqual(wl.get_entry(e["id"], self.lib, prog)["suggestion"]["status"], "reading")

    def test_completed_when_every_chapter_read_of_an_ended_series(self):
        self.lib[0].update(status="completed", remote_total=3)
        e = self.add({"asura": NANO, "status": "reading"})
        prog = {NANO: {"chapter": "3", "frac": 1, "read": ["1", "2", "3"], "read_at": 1}}
        self.assertEqual(wl.get_entry(e["id"], self.lib, prog)["suggestion"]["status"], "completed")
        self.lib[0]["remote_total"] = 5  # chapters on the source not fetched yet
        self.assertIsNone(wl.get_entry(e["id"], self.lib, prog)["suggestion"])
        self.lib[0].update(status="ongoing", remote_total=3)
        self.assertIsNone(wl.get_entry(e["id"], self.lib, prog)["suggestion"])

    def test_completed_entry_whose_series_resumed(self):
        self.lib[0]["status"] = "completed"
        e = self.add({"asura": NANO, "status": "completed"})
        self.assertIsNone(e["suggestion"])
        self.lib[0]["status"] = "hiatus"
        self.assertEqual(wl.get_entry(e["id"], self.lib, {})["suggestion"]["status"], "reading")


class StaleRefresh(Base):
    def test_refresh_stale_updates_old_asura_entries(self):
        self.lib = []
        e = self.add({"asura": SOLO})
        with db.transaction() as c:
            c.execute("UPDATE watchlist SET metadata_at = '2000-01-01', series_status = 'ongoing'")
        n = wl.refresh_stale([], fetch=lambda s: asura_info(s, "Solo Leveling", status="completed"), background=False)
        self.assertEqual(n, 1)
        self.assertEqual(wl.get_entry(e["id"], [], {})["series_status"], "completed")
        self.assertEqual(wl.refresh_stale([], fetch=self.fetch, background=False), 0)  # fresh now


class Http(unittest.TestCase):
    """The real request handler on a free port, with a temp DB (no PIN set: auth is off)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        db.set_db_path(Path(cls.tmp.name) / "h.db")
        db.init_schema()
        import server

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=str(server.HERE)))
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        db.close_thread_conn()
        db.set_db_path(None)
        cls.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        h = {"Content-Type": "application/json"} if body is not None else {}
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={**h, **(headers or {})})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def test_crud(self):
        st, e = self.call("POST", "/api/watchlist", {"title": "Omniscient Reader", "status": "reading", "rating": 5})
        self.assertEqual(st, 201)
        st, rows = self.call("GET", "/api/watchlist")
        self.assertEqual((st, [r["id"] for r in rows]), (200, [e["id"]]))
        st, out = self.call("PATCH", f"/api/watchlist/{e['id']}", {"notes": "re-read"})
        self.assertEqual((st, out["notes"]), (200, "re-read"))
        st, out = self.call("PATCH", f"/api/watchlist/{e['id']}", {"status": "completed", "series_status": "ongoing"})
        self.assertEqual((st, out["code"]), (409, "series_continuing"))
        st, out = self.call("POST", "/api/watchlist", {"title": "omniscient reader"})
        self.assertEqual((st, out["id"]), (409, e["id"]))
        st, _ = self.call("POST", f"/api/watchlist/{e['id']}/refresh", {})
        self.assertEqual(st, 200)
        st, _ = self.call("DELETE", f"/api/watchlist/{e['id']}", headers={"Origin": "https://evil.example"})
        self.assertEqual(st, 403)
        st, _ = self.call("DELETE", f"/api/watchlist/{e['id']}")
        self.assertEqual(st, 200)
        st, _ = self.call("GET", f"/api/watchlist/{e['id']}")
        self.assertEqual(st, 404)
        st, _ = self.call("POST", f"/api/watchlist/{e['id']}/bogus", {})
        self.assertEqual(st, 404)


if __name__ == "__main__":
    unittest.main()
