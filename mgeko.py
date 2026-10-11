"""mgeko.cc as a second chapter source, read the same way as Asura: series page for the
details, the all-chapters page for the list, each chapter's reader page for its image URLs.

Series from here are stored under the slug "mgeko-<their slug>", so any code holding a slug
knows which site to ask. mgeko's chapter URLs don't follow one pattern (a series can change
slug part way through), so each chapter's link is kept from the list rather than built.
"""
from __future__ import annotations

import html as htmllib
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from urllib.parse import quote, urljoin, urlparse

import asura_chapter_pages as asura

BASE = "https://www.mgeko.cc"
PREFIX = "mgeko-"
SERIES_URL = BASE + "/manga/{slug}/"
CHAPTERS_URL = BASE + "/manga/{slug}/all-chapters/"
SEARCH_URL = BASE + "/autocomplete?term={q}"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
SEARCH_ITEM_RE = re.compile(r'<a href="/manga/([^"/]+)/" title="([^"]*)"')

ITEM_RE = re.compile(
    r'<a href="(/reader/[^"]+)"[^>]*>.*?<strong class="chapter-title">\s*([^<]*?)\s*</strong>'
    r'(?:\s*<time[^>]*datetime="([^"]*)")?',
    re.S,
)
PAGE_IMG_RE = re.compile(r'<img\s+src="(https?://[^"]+)"[^>]*\bid="image-(\d+)"')
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def is_mgeko(value: str) -> bool:
    value = (value or "").strip().lower()
    return value.startswith(PREFIX) or "mgeko.cc/" in value


def parse_slug(value: str) -> str:
    """A stored slug ("mgeko-x") or any mgeko.cc/manga/<x>/... URL -> "mgeko-x"."""
    value = value.strip()
    if value.lower().startswith(PREFIX):
        slug = value[len(PREFIX):].lower()
    else:
        parts = urlparse(value if "//" in value else "//" + value).path.strip("/").split("/")
        if "manga" not in parts or parts.index("manga") + 1 >= len(parts):
            raise ValueError("Use an mgeko.cc series link (https://www.mgeko.cc/manga/<name>/), "
                             "not a chapter link")
        slug = parts[parts.index("manga") + 1].lower()
    if not SLUG_RE.match(slug):
        raise ValueError("Invalid mgeko series link")
    return PREFIX + slug


def _site_slug(slug: str) -> str:
    return slug[len(PREFIX):] if slug.startswith(PREFIX) else slug


def _text(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", "\n", fragment)
    text = htmllib.unescape(re.sub(r"<[^>]+>", "", fragment))
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def _first(pattern: str, page: str) -> str | None:
    m = re.search(pattern, page, re.S)
    return _text(m.group(1)) if m else None


def parse_date(value: str | None) -> str | None:
    """mgeko prints dates the Django way ("Dec. 24, 2024, 3:10 a.m.", "Sept. 3, 2024, noon").
    The site doesn't say which zone they're in; they're read as UTC."""
    m = re.match(r"\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})(?:,\s*(.*))?", value or "")
    if not m or m.group(1)[:3].lower() not in MONTHS:
        return None
    hour = minute = 0
    t = (m.group(4) or "").strip().lower()
    if t == "noon":
        hour = 12
    elif tm := re.match(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m", t):
        hour = int(tm.group(1)) % 12 + (12 if tm.group(3) == "p" else 0)
        minute = int(tm.group(2) or 0)
    try:
        return datetime(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)),
                        hour, minute, tzinfo=timezone.utc).isoformat()
    except ValueError:
        return None


SMALL_WORDS = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "who"}


def _title_case(title: str) -> str:
    """mgeko often lowercases titles ("The tutorial tower of the advanced player")."""
    if title != title[:1] + title[1:].lower():
        return title  # the site already cased it; keep that
    words = title.split(" ")
    return " ".join(w if i and w in SMALL_WORDS else w[:1].upper() + w[1:] for i, w in enumerate(words))


def _number(title: str) -> str | None:
    """"190-eng-li" -> "190"; "52.fix-eng-li" -> "52"; "10.5-eng-li" -> "10.5"."""
    m = re.match(r"(\d+(?:\.\d+)?)(?![\d])", title)
    if not m:
        return None
    n = float(m.group(1))
    return str(int(n)) if n.is_integer() else m.group(1)


def search(query: str, limit: int = 8) -> list[dict]:
    """Find series on mgeko by title (the site's own search box), scored like the Asura
    catalogue search so the two can be compared."""
    words = re.findall(r"[a-z0-9]+", (query or "").lower())
    if not words:
        return []
    page = asura.fetch_html(SEARCH_URL.format(q=quote(" ".join(words))))
    out = []
    for site, title in SEARCH_ITEM_RE.findall(page):
        title = htmllib.unescape(title)
        name = re.findall(r"[a-z0-9]+", title.lower())
        overlap = sum(1 for w in words if w in name) / len(words)
        ratio = SequenceMatcher(None, " ".join(words), " ".join(name)).ratio()
        out.append({"slug": PREFIX + site, "title": title, "url": SERIES_URL.format(slug=site),
                    "score": round(0.6 * overlap + 0.4 * ratio, 3), "source": "mgeko"})
    return sorted(out, key=lambda r: -r["score"])[:limit]


def fetch_series_info(slug: str) -> dict:
    """Same shape as ingest.fetch_series_info, plus a "url" on every chapter."""
    site = _site_slug(slug)
    page = asura.fetch_html(SERIES_URL.format(slug=site))
    listing = asura.fetch_html(CHAPTERS_URL.format(slug=site))

    title = _first(r'<h1[^>]*class="novel-title[^"]*"[^>]*>(.*?)</h1>', page)
    if not title:
        raise RuntimeError("series not found (page has no title)")
    alts = _first(r'<h2[^>]*class="alternative-title[^"]*"[^>]*>(.*?)</h2>', page) or ""
    author = _first(r'itemprop="author"[^>]*>(.*?)</span>', page)
    status = _first(r'<strong class="\w+">\s*(\w+)\s*</strong>\s*<small>Status</small>', page)
    cover = re.search(r'<meta property="og:image" content="([^"]+)"', page)
    desc = _first(r'<p class="description">(.*?)</p>', page) or ""
    # mgeko opens every description with the same boilerplate; the real text follows it.
    desc = re.sub(r"^.*?The Summary is\s*", "", desc, flags=re.S).strip()
    genres = [_text(g).strip() for g in re.findall(r'title="([^"]+?) Genre" class="property-item"', page)]

    chapters, seen = [], set()
    for href, label, date in ITEM_RE.findall(listing):
        number = _number(label)
        if number is None or number in seen:
            continue  # newest first, so a re-upload ("52.fix") wins over an older copy
        seen.add(number)
        chapters.append({
            "number": number,
            "url": urljoin(BASE, href),
            "published_at": parse_date(date),
            "page_count": None,
            "locked": False,
        })
    if not chapters:
        raise RuntimeError("series has no chapters on mgeko")
    chapters.sort(key=lambda c: float(c["number"]))

    return {
        "slug": PREFIX + site,
        "moved_from": None,
        "source_url": SERIES_URL.format(slug=site),
        "title": _title_case(title),
        "description": desc,
        "alt_titles": [a.strip() for a in alts.split(",") if a.strip() and a.strip() != "Updating"],
        "cover_url": cover.group(1) if cover else None,
        "rating": None,
        "bookmarks": None,
        "status": status.lower() if status else None,
        "type": "Manhwa" if "Manhwa" in genres else None,
        "author": None if author in (None, "", "Updating") else author,
        "artist": None,
        "genres": [g for g in genres if g not in ("Manhwa", "Manga", "Manhua")],
        "chapters": chapters,
    }


def extract_pages(page: str) -> list[dict]:
    """Reader images in page order, in the same form as asura.extract_pages."""
    found = {int(n): src for src, n in PAGE_IMG_RE.findall(page)}
    return [{"page_index": i, "src": found[n], "aspect_ratio": None, "alt": None}
            for i, n in enumerate(sorted(found))]
