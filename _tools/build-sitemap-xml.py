#!/usr/bin/env python3
"""
build-sitemap-xml.py

Regenerates /sitemap.xml from every *.html file at the project root.
Run this whenever you add, remove, or rename a page.

Usage (from repo root):
    python3 _tools/build-sitemap-xml.py

What it does:
  - Scans the repo root for *.html files
  - Skips a small explicit exclude list (e.g. anything you don't want indexed)
  - Reads <title> from each page for the entry
  - Maps the filename to the canonical clean URL (vercel.json has cleanUrls: true)
  - Writes sitemap.xml at the repo root

The script is intentionally simple. It does NOT update sitemap2.html — that's
the visual/human sitemap and is curated by hand (node positions matter).
If you add a new page, also drop it into sitemap2.html's NODES array.
"""

from __future__ import annotations

import os
import re
import sys
from datetime import date
from pathlib import Path

# ---- Configuration ----------------------------------------------------------

BASE_URL = "https://raghavakkstudio.com"

# Files NOT to include in sitemap.xml.
# (Vercel cleanUrls strips the .html, so list the filenames as they exist.)
EXCLUDE = {
    # Add filenames here if you want a page kept out of search indexing.
    # Example: "draft-only.html",
}

# Files that, when present, should map to "/" (the root URL) instead of "/<slug>".
ROOT_FILES = {"index.html"}

# Priority hints. Anything not listed defaults to 0.6.
PRIORITY = {
    "index.html": "1.0",
    "calling2.html": "0.9",
    "studio2.html": "0.9",
    "lab2.html": "0.9",
    "becoming2.html": "0.9",
    "excavate2.html": "0.9",
    "about2.html": "0.8",
    "writings2.html": "0.8",
    "library2.html": "0.8",
    "talks2.html": "0.8",
    "network.html": "0.7",
    "parsons-proposal.html": "0.7",
    "sitemap2.html": "0.5",
    "terms.html": "0.3",
}

# ---- Logic ------------------------------------------------------------------


def page_title(path: Path) -> str:
    try:
        s = path.read_text(errors="ignore")
    except OSError:
        return path.stem
    m = re.search(r"<title>([^<]+)</title>", s)
    return m.group(1).strip() if m else path.stem


def page_lastmod(path: Path) -> str:
    """Use the file mtime, falling back to today."""
    try:
        ts = path.stat().st_mtime
        return date.fromtimestamp(ts).isoformat()
    except OSError:
        return date.today().isoformat()


def slug_for(filename: str) -> str:
    if filename in ROOT_FILES:
        return "/"
    return "/" + filename[:-5]  # strip .html (Vercel cleanUrls handles it)


def collect_pages(root: Path) -> list[Path]:
    pages = []
    for p in sorted(root.iterdir()):
        if p.is_file() and p.suffix.lower() == ".html" and p.name not in EXCLUDE:
            pages.append(p)
    return pages


def build_xml(pages: list[Path]) -> str:
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for p in pages:
        loc = BASE_URL + slug_for(p.name)
        lastmod = page_lastmod(p)
        priority = PRIORITY.get(p.name, "0.6")
        lines += [
            "  <url>",
            f"    <loc>{loc}</loc>",
            f"    <lastmod>{lastmod}</lastmod>",
            f"    <changefreq>monthly</changefreq>",
            f"    <priority>{priority}</priority>",
            "  </url>",
        ]
    lines.append("</urlset>")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    pages = collect_pages(root)
    if not pages:
        print("No HTML pages found at repo root.", file=sys.stderr)
        return 1
    xml = build_xml(pages)
    out = root / "sitemap.xml"
    out.write_text(xml, encoding="utf-8")
    print(f"Wrote {out.relative_to(root)} with {len(pages)} pages:")
    for p in pages:
        print(f"  - {BASE_URL}{slug_for(p.name)}   ({page_title(p)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
