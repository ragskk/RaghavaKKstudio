#!/usr/bin/env python3
"""
cap_1600.py — publish-size cap for every artwork file the site serves.

Policy (2026-08-30, Raghava's call): nothing ships above 1600 px on the
long edge. Less to steal; still sharp on ordinary screens. The 2400 px
masters live off-site (Drive / studio archive), never in this repo.

Rules:
  - Targets images/**, toys/** — .jpg/.jpeg/.png (format sniffed, not trusted
    from the extension: some "jpg" files are PNGs, two are HTML — skipped).
  - Skips logos, favicons, images/brushes/.
  - Only touches files whose long edge exceeds MAX_EDGE. Idempotent.
  - JPEG: Lanczos → quality 95, chroma 4:4:4, ICC profile kept, EXIF kept
    (orientation normalised to 1 after transposing). No 4:2:0, ever
    (see feedback_jpeg_recompress_color_fidelity).
  - PNG: Lanczos, lossless, ICC + text chunks kept.
  - Re-run _tools/stamp_copyright.py afterwards (idempotent), then
    _tools/c2pa_sign.py — the C2PA manifest hashes the final bytes, so it
    must be the LAST step.

Run:
  python3 _tools/cap_1600.py            # do it
  python3 _tools/cap_1600.py --dry-run  # report only
  python3 _tools/cap_1600.py --limit N  # process at most N files (chunked runs)
"""
from __future__ import annotations
import argparse, pathlib, sys
from PIL import Image, ImageOps, PngImagePlugin
import piexif

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_EDGE = 1600
INCLUDE_DIRS = ["images", "toys"]
EXCLUDE_DIRS = ["images/brushes"]
EXCLUDE_NAME_FRAGMENTS = ["logo", "favicon"]
EXTS = {".jpg", ".jpeg", ".png"}


def candidates():
    for d in INCLUDE_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in EXTS:
                continue
            rel = p.relative_to(ROOT).as_posix()
            if any(rel.startswith(x + "/") for x in EXCLUDE_DIRS):
                continue
            if any(f in p.name.lower() for f in EXCLUDE_NAME_FRAGMENTS):
                continue
            yield p


def cap(p: pathlib.Path, dry: bool) -> str:
    try:
        im = Image.open(p)
        im.load()
    except Exception as e:  # HTML-in-jpg etc.
        return f"SKIP unreadable ({e.__class__.__name__})"
    fmt = im.format
    w, h = im.size
    if max(w, h) <= MAX_EDGE:
        return "ok"
    if dry:
        return f"WOULD cap {w}x{h} [{fmt}]"

    icc = im.info.get("icc_profile")
    if fmt == "JPEG":
        exif_bytes = im.info.get("exif")
        im = ImageOps.exif_transpose(im)
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        exif_out = None
        if exif_bytes:
            try:
                d = piexif.load(exif_bytes)
                d["0th"][piexif.ImageIFD.Orientation] = 1
                d["Exif"][piexif.ExifIFD.PixelXDimension] = im.size[0]
                d["Exif"][piexif.ExifIFD.PixelYDimension] = im.size[1]
                d["thumbnail"] = None  # drop embedded preview of the old size
                exif_out = piexif.dump(d)
            except Exception:
                exif_out = None
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        kw = dict(quality=95, subsampling=0, optimize=True)
        if icc:
            kw["icc_profile"] = icc
        if exif_out:
            kw["exif"] = exif_out
        im.save(p, "JPEG", **kw)
    elif fmt == "PNG":
        info = PngImagePlugin.PngInfo()
        for k, v in getattr(im, "text", {}).items():
            try:
                info.add_text(k, v)
            except Exception:
                pass
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        kw = dict(optimize=True, pnginfo=info)
        if icc:
            kw["icc_profile"] = icc
        im.save(p, "PNG", **kw)
    else:
        return f"SKIP format {fmt}"
    nw, nh = im.size
    return f"CAPPED {w}x{h} -> {nw}x{nh} [{fmt}]"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    done = 0
    counts = {}
    for p in candidates():
        r = cap(p, a.dry_run)
        key = r.split()[0]
        counts[key] = counts.get(key, 0) + 1
        if key != "ok":
            print(f"{r:40s} {p.relative_to(ROOT)}")
        if key in ("CAPPED", "WOULD"):
            done += 1
            if a.limit and done >= a.limit:
                break
    print("summary:", counts)


if __name__ == "__main__":
    main()
