#!/usr/bin/env python3
"""
fix_studio_assets.py

Two surgical fixes against `images/studio/`:

  (1) Mislabeled PNGs:
      18 files were saved with a `.jpg` extension but their content is
      actually PNG. The site loads them by .jpg path, browsers content-
      sniff and render OK, but it's wrong on the wire (Content-Type
      mismatch) and bloats payloads. We re-encode each as a real JPEG
      at quality 92, compositing any alpha onto the site's paper color
      so transparent areas look the same as they did against the page
      background. No HTML changes required.

  (2) Two corrupt assets:
      images/studio/02-impossible-bouquets/2E.jpg and
      images/studio/03-guernica/3C.jpg are 1602-byte HTML 404 pages
      saved with an image extension (failed download artifact). They
      represent real works in the studio data array, so we replace
      each with a paper-toned placeholder JPEG that names the work,
      so the gallery doesn't show a broken-image icon. Raghava drops
      in real artwork later.

After running, re-run stamp_copyright.py to refresh EXIF copyright on
the newly-encoded JPEGs.

Run:
  python3 _tools/fix_studio_assets.py            # apply fixes
  python3 _tools/fix_studio_assets.py --dry-run  # report only
"""

from __future__ import annotations
import argparse, pathlib, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAPER = (244, 241, 234)  # #F4F1EA
INK   = (43, 42, 38)     # #2B2A26
RULE  = (139, 133, 121)  # muted

# (1) The 18 known mislabeled-as-jpg PNGs in the studio tree.
# Detected and confirmed via signature inspection (89 50 4E 47 PNG header).
MISLABELED = [
    "images/studio/06-orgasm-project/6A.jpg",
    "images/studio/08-mtf/8A.jpg",
    "images/studio/09-powerfluff/9A.jpg",
    "images/studio/09-powerfluff/9B.jpg",
    "images/studio/09-powerfluff/9C.jpg",
    "images/studio/09-powerfluff/9D.jpg",
    "images/studio/09-powerfluff/9E.jpg",
    "images/studio/09-powerfluff/9F.jpg",
    "images/studio/11-toy-trojan/11A.jpg",
    "images/studio/11-toy-trojan/11B.jpg",
    "images/studio/11-toy-trojan/11C.jpg",
    "images/studio/11-toy-trojan/11D.jpg",
    "images/studio/13-toy-faces/13A.jpg",
    "images/studio/13-toy-faces/13B.jpg",
    "images/studio/13-toy-faces/13C.jpg",
    "images/studio/13-toy-faces/13D.jpg",
    "images/studio/13-toy-faces/13E.jpg",
    "images/studio/13-toy-faces/13F.jpg",
]

# (2) Corrupt 1602-byte HTML files. Each maps to its work title for the
# placeholder caption, sourced from studio2.html SERIES data.
BROKEN = {
    "images/studio/02-impossible-bouquets/2E.jpg": ("2E", "To See Or Not To See", "Impossible Bouquets · 2023"),
    "images/studio/03-guernica/3C.jpg":            ("3C", "Guernica 2.0",         "The Guernica Project · 2015"),
}


def sig(path: pathlib.Path) -> str:
    try:
        with open(path, "rb") as f:
            head = f.read(8)
        if head[:3] == b"\xff\xd8\xff":   return "JPEG"
        if head[:8] == b"\x89PNG\r\n\x1a\n": return "PNG"
        if head[:1] == b"<":               return "HTML"
        return f"OTHER({head[:4].hex()})"
    except Exception:
        return "MISSING"


def reencode_png_as_jpeg(path: pathlib.Path, dry: bool) -> str:
    if not path.exists():
        return "missing"
    if sig(path) != "PNG":
        return f"skip-not-png({sig(path)})"

    if dry:
        return "would-reencode"

    with Image.open(path) as img:
        img.load()
        if img.mode in ("RGBA", "LA"):
            bg = Image.new("RGB", img.size, PAPER)
            mask = img.split()[-1] if img.mode == "RGBA" else img.split()[-1]
            bg.paste(img.convert("RGBA"), mask=mask)
            out = bg
        elif img.mode == "P":
            out = img.convert("RGB")
        else:
            out = img.convert("RGB")

        tmp = path.with_suffix(".jpg.tmp")
        out.save(tmp, "JPEG", quality=92, optimize=True, progressive=True)
    import os
    os.replace(tmp, path)
    return "reencoded"


def make_placeholder(path: pathlib.Path, work_id: str, title: str, sub: str, dry: bool) -> str:
    if dry:
        return "would-placeholder"

    W, H = 1600, 1200
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # Subtle outer rule
    d.rectangle((40, 40, W - 40, H - 40), outline=RULE, width=1)

    def load(size, italic=False):
        candidates = [
            "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
            "/System/Library/Fonts/Times.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
            "/usr/share/fonts/dejavu/DejaVuSerif.ttf",
        ]
        for c in candidates:
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
        return ImageFont.load_default()

    f_meta = load(28)
    f_id = load(180)
    f_title = load(64)
    f_sub = load(36)
    f_note = load(28)

    def text(xy, s, font, fill=INK, anchor="lm"):
        d.text(xy, s, font=font, fill=fill, anchor=anchor)

    text((80, 80), "RAGHAVA KK · STUDIO", f_meta, fill=RULE)
    text((W - 80, 80), "IMAGE PENDING", f_meta, fill=RULE, anchor="rm")

    # Centered work id
    text((W / 2, H / 2 - 90), work_id, f_id, anchor="mm")
    # Title
    text((W / 2, H / 2 + 70), title, f_title, anchor="mm")
    # Sub
    text((W / 2, H / 2 + 130), sub, f_sub, fill=RULE, anchor="mm")

    text((80, H - 80), "Replace this file with the final artwork export.", f_note, fill=RULE)

    tmp = path.with_suffix(".jpg.tmp")
    img.save(tmp, "JPEG", quality=92, optimize=True, progressive=True)
    import os
    os.replace(tmp, path)
    return "placeholder-written"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print("\n=== (1) Re-encode mislabeled PNGs as JPEGs ===")
    for rel in MISLABELED:
        p = ROOT / rel
        before = sig(p)
        r = reencode_png_as_jpeg(p, args.dry_run)
        after = sig(p)
        sz = p.stat().st_size if p.exists() else 0
        print(f"  {rel:<50} {before:>5} -> {after:<5}  {r:<18} size={sz}")

    print("\n=== (2) Replace corrupt HTML-in-jpg files with placeholders ===")
    for rel, (wid, title, sub) in BROKEN.items():
        p = ROOT / rel
        before = sig(p)
        r = make_placeholder(p, wid, title, sub, args.dry_run)
        after = sig(p)
        sz = p.stat().st_size if p.exists() else 0
        print(f"  {rel:<50} {before:>5} -> {after:<5}  {r:<22} size={sz}")

    print("\nDone. Now re-run: python3 _tools/stamp_copyright.py")


if __name__ == "__main__":
    main()
