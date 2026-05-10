#!/usr/bin/env python3
"""
stamp_copyright.py

Embed copyright + creator + AI opt-out metadata into every artwork
file shipped with the website.

Why:
  - EXIF / IPTC / PNG-text copyright fields are the strongest *legal*
    signal of authorship that survives screenshots, re-uploads, and
    cross-platform reposts. They are written into the file itself.
  - Combined with the X-Robots-Tag noai/noimageai header on the server
    side and the robots.txt training-bot bans, they form the metadata
    layer of the protection stack.

Targets (artwork only — UI assets like logos and brushes are skipped):
  - images/**/*.jpg, images/**/*.png  (excluding logos and /brushes/)
  - paint strokes/**/*.{jpg,png}
  - toys/**/*.{jpg,jpeg,png,JPG,JPEG,PNG}

Idempotent: a file already carrying our copyright string is left alone.

Run:
  python3 _tools/stamp_copyright.py            # stamp the whole tree
  python3 _tools/stamp_copyright.py --dry-run  # report only

Note on quality:
  - JPGs are stamped via piexif.insert(), which rewrites only the EXIF
    APP1 segment and does NOT recompress the image. No quality loss.
  - PNGs are re-encoded via Pillow PngInfo, which is lossless. File
    sizes may change slightly due to chunk reordering.
"""

from __future__ import annotations
import sys, os, datetime, argparse, pathlib
from typing import Iterable

from PIL import Image, PngImagePlugin
import piexif

ROOT = pathlib.Path(__file__).resolve().parent.parent
YEAR = datetime.date.today().year

CREATOR        = "Raghava KK"
COPYRIGHT_LINE = f"Copyright (c) 2008-{YEAR} Raghava KK. All rights reserved."
RIGHTS_LINE    = (
    "All rights reserved. Not licensed for AI training, model fine-tuning, "
    "embedding generation, or any machine learning dataset. "
    "See https://raghavakk.com/terms.html"
)
SOURCE_URL     = "https://raghavakk.com"
DESCRIPTION    = (
    f"Artwork by Raghava KK. {RIGHTS_LINE}"
)

INCLUDE_DIRS = ["images", "paint strokes", "toys"]
EXCLUDE_DIRS = ["images/brushes"]
EXCLUDE_NAME_FRAGMENTS = ["logo", "favicon"]
IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


def is_artwork(path: pathlib.Path) -> bool:
    rel = path.relative_to(ROOT).as_posix()
    if path.suffix.lower() not in IMAGE_EXTS:
        return False
    for ex in EXCLUDE_DIRS:
        if rel.startswith(ex + "/") or rel == ex:
            return False
    name_low = path.name.lower()
    for frag in EXCLUDE_NAME_FRAGMENTS:
        if frag in name_low:
            return False
    return True


def iter_targets() -> Iterable[pathlib.Path]:
    for d in INCLUDE_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.is_file() and is_artwork(p):
                yield p


def stamp_jpeg(path: pathlib.Path, dry: bool) -> str:
    try:
        exif_dict = piexif.load(str(path))
    except Exception:
        exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}

    zeroth = exif_dict.setdefault("0th", {})

    existing_copy = zeroth.get(piexif.ImageIFD.Copyright)
    existing_artist = zeroth.get(piexif.ImageIFD.Artist)
    if existing_copy and CREATOR.encode() in existing_copy and existing_artist:
        return "skip-already-stamped"

    zeroth[piexif.ImageIFD.Copyright] = COPYRIGHT_LINE.encode("utf-8") + b"\x00"
    zeroth[piexif.ImageIFD.Artist] = CREATOR.encode("utf-8") + b"\x00"
    zeroth[piexif.ImageIFD.ImageDescription] = DESCRIPTION.encode("utf-8") + b"\x00"
    zeroth[piexif.ImageIFD.XPAuthor] = (CREATOR + "\x00").encode("utf-16le")
    zeroth[piexif.ImageIFD.XPKeywords] = ("noai;noimageai;copyright\x00").encode("utf-16le")

    if dry:
        return "would-stamp-jpeg"

    try:
        exif_bytes = piexif.dump(exif_dict)
        piexif.insert(exif_bytes, str(path))
        return "stamped-jpeg"
    except Exception as e:
        return f"ERROR-jpeg:{e}"


def stamp_png(path: pathlib.Path, dry: bool) -> str:
    try:
        with Image.open(path) as img:
            existing_text = dict(getattr(img, "text", {}) or {})
            if "Copyright" in existing_text and CREATOR in existing_text["Copyright"]:
                return "skip-already-stamped"

            info = PngImagePlugin.PngInfo()
            for k, v in existing_text.items():
                if k in ("Copyright", "Author", "Source", "Description",
                         "Comment", "Title", "Artist", "Disclaimer", "Warning"):
                    continue  # we'll override these
                try:
                    info.add_text(k, v)
                except Exception:
                    pass

            info.add_text("Title", path.stem)
            info.add_text("Author", CREATOR)
            info.add_text("Artist", CREATOR)
            info.add_text("Copyright", COPYRIGHT_LINE)
            info.add_text("Source", SOURCE_URL)
            info.add_text("Description", DESCRIPTION)
            info.add_text("Disclaimer", RIGHTS_LINE)
            info.add_text("Warning", "noai, noimageai")

            if dry:
                return "would-stamp-png"

            img.load()
            mode = img.mode
            tmp = path.with_suffix(path.suffix + ".tmp")
            img.save(tmp, "PNG", pnginfo=info, optimize=False)

        os.replace(tmp, path)
        return "stamped-png"
    except Exception as e:
        return f"ERROR-png:{e}"


def detect_format(path: pathlib.Path) -> str:
    """Return 'JPEG' / 'PNG' / 'OTHER' / 'INVALID' based on file content,
    not the filename extension. Some files in this tree have the wrong
    extension (PNGs saved as .jpg)."""
    try:
        with open(path, "rb") as f:
            head = f.read(16)
        if head[:3] == b"\xff\xd8\xff":
            return "JPEG"
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return "PNG"
        if head[:6] in (b"GIF87a", b"GIF89a"):
            return "GIF"
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            return "WEBP"
        if head.startswith(b"<") or b"html" in head.lower():
            return "INVALID"  # text/html mislabelled as image
        return "OTHER"
    except Exception:
        return "INVALID"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after N files (debug)")
    args = ap.parse_args()

    counts = {}
    examples = {}
    mismatches = []
    n = 0
    for p in iter_targets():
        if args.limit and n >= args.limit:
            break
        ext = p.suffix.lower()
        actual = detect_format(p)

        if ext in (".jpg", ".jpeg") and actual != "JPEG":
            mismatches.append((p, actual))
        elif ext == ".png" and actual != "PNG":
            mismatches.append((p, actual))

        if actual == "JPEG":
            r = stamp_jpeg(p, args.dry_run)
        elif actual == "PNG":
            r = stamp_png(p, args.dry_run)
        elif actual == "INVALID":
            r = "skip-invalid-file"
        else:
            r = f"skip-actual-{actual.lower()}"

        counts[r] = counts.get(r, 0) + 1
        if r.startswith("ERROR") and len(examples.get(r, [])) < 5:
            examples.setdefault(r, []).append(str(p.relative_to(ROOT)))
        n += 1

    if mismatches:
        print("\n!! Filename / format mismatches (please rename or re-save):")
        for p, actual in mismatches:
            print(f"  {p.relative_to(ROOT)}   (extension says {p.suffix}, content is {actual})")

    print(f"\n{'result':<28} {'count':>7}")
    print("-" * 38)
    for k in sorted(counts):
        print(f"{k:<28} {counts[k]:>7}")
    print(f"{'TOTAL':<28} {n:>7}")
    if examples:
        print("\nError examples:")
        for k, v in examples.items():
            print(f"  {k}:")
            for path in v:
                print(f"    {path}")


if __name__ == "__main__":
    main()
