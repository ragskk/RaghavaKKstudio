#!/usr/bin/env python3
"""
c2pa_sign.py — embed C2PA Content Credentials in every artwork file.

What it does:
  Writes a signed C2PA manifest (JUMBF segment in JPEG, iTXt/caBX chunk in
  PNG) into each image, asserting: creator Raghava KK, copyright, the
  studio URL, and a "created" action. Pixels are untouched — the manifest
  is metadata; the image data is hashed, so ANY later edit breaks the seal
  (which is the point: an intact seal = untouched file from the studio).

Signing identity:
  _tools/c2pa/studio-signing.crt + chain.pem  (public, tracked in git)
  _tools/c2pa/studio-signing.key             (PRIVATE, gitignored — back it
  up off-machine; if lost, generate a new pair and re-sign everything)

Honest limits:
  The certificate is self-issued by "Raghava KK Studio Root". Verifiers such
  as contentcredentials.org/verify will show the credentials and the
  signer name but flag the signer as not on the C2PA trust list. Getting
  on that list means a certificate from a C2PA-conformant CA (paid,
  identity-verified). Until then this is a cryptographic authorship
  statement, not a third-party-verified one.

Order of operations: run LAST — after cap_1600.py and stamp_copyright.py.
Re-running is safe: files with an existing valid manifest are skipped
unless --force.

Run:
  python3 _tools/c2pa_sign.py             # sign everything missing a manifest
  python3 _tools/c2pa_sign.py --dry-run
  python3 _tools/c2pa_sign.py --limit N   # chunked runs
  python3 _tools/c2pa_sign.py --force     # re-sign all
"""
from __future__ import annotations
import argparse, datetime, io, json, os, pathlib, shutil, sys, tempfile
import c2pa

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEYDIR = ROOT / "_tools" / "c2pa"
INCLUDE_DIRS = ["images", "toys"]
EXCLUDE_DIRS = ["images/brushes"]
EXCLUDE_NAME_FRAGMENTS = ["logo", "favicon"]
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
YEAR = datetime.date.today().year


def manifest_json() -> str:
    return json.dumps({
        "claim_generator_info": [{"name": "Raghava KK Studio signer", "version": "1.0"}],
        "title": "Artwork by Raghava KK",
        "assertions": [
            {"label": "c2pa.actions", "data": {"actions": [
                {"action": "c2pa.created",
                 "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"}
            ]}},
            {"label": "stds.schema-org.CreativeWork", "data": {
                "@context": "https://schema.org", "@type": "CreativeWork",
                "author": [{"@type": "Person", "name": "Raghava KK",
                            "url": "https://raghavakkstudio.com"}],
                "copyrightHolder": {"@type": "Person", "name": "Raghava KK"},
                "copyrightNotice": f"Copyright (c) 2008-{YEAR} Raghava KK. All rights reserved.",
                "license": "https://raghavakkstudio.com/terms.html",
            }, "kind": "Json"},
            {"label": "c2pa.training-mining", "data": {"entries": {
                "c2pa.ai_generative_training": {"use": "notAllowed"},
                "c2pa.ai_inference": {"use": "notAllowed"},
                "c2pa.ai_training": {"use": "notAllowed"},
                "c2pa.data_mining": {"use": "notAllowed"},
            }}},
        ],
    })


def configure():
    # No auto-thumbnail inside the manifest: keeps the embedded credential
    # small (~3 KB instead of ~150 KB) and never ships a second copy of the image.
    c2pa.load_settings(json.dumps({"builder": {"thumbnail": {"enabled": False}}}))


def signer() -> c2pa.Signer:
    cert = (KEYDIR / "chain.pem").read_bytes()
    key = (KEYDIR / "studio-signing.key").read_bytes()
    info = c2pa.C2paSignerInfo(alg=b"es256", sign_cert=cert, private_key=key, ta_url=None)
    return c2pa.Signer.from_info(info)


def candidates():
    for d in INCLUDE_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file() or p.suffix.lower() not in MIME:
                continue
            rel = p.relative_to(ROOT).as_posix()
            if any(rel.startswith(x + "/") for x in EXCLUDE_DIRS):
                continue
            if any(f in p.name.lower() for f in EXCLUDE_NAME_FRAGMENTS):
                continue
            yield p


def sniff(p: pathlib.Path) -> str | None:
    with open(p, "rb") as f:
        head = f.read(8)
    if head[:2] == b"\xff\xd8":
        return "image/jpeg"
    if head == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return None


def has_manifest(p: pathlib.Path, mime: str) -> bool:
    try:
        with open(p, "rb") as f:
            r = c2pa.Reader(mime, f)
            ok = r.get_active_manifest() is not None
            r.close()
            return ok
    except Exception:
        return False


def sign_one(p: pathlib.Path, mime: str, s: c2pa.Signer) -> None:
    tmp = p.with_suffix(p.suffix + ".c2pa-tmp")
    b = c2pa.Builder(manifest_json())
    with open(p, "rb") as src, open(tmp, "wb") as dst:
        b.sign(s, mime, src, dst)
    b.close()
    # verify before replacing
    with open(tmp, "rb") as f:
        r = c2pa.Reader(mime, f)
        state = r.get_validation_state()
        r.close()
    if str(state).lower().find("invalid") >= 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"manifest invalid after signing: {state}")
    with open(tmp, "rb") as f, open(p, "wb") as out:  # in-place write (mount forbids unlink)
        shutil.copyfileobj(f, out)
    try:
        tmp.unlink()
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    configure()
    s = None if a.dry_run else signer()
    counts, done = {}, 0
    for p in candidates():
        mime = sniff(p)
        if not mime:
            counts["skip-unreadable"] = counts.get("skip-unreadable", 0) + 1
            print("SKIP unreadable", p.relative_to(ROOT)); continue
        if not a.force and has_manifest(p, mime):
            counts["already"] = counts.get("already", 0) + 1; continue
        if a.dry_run:
            counts["would-sign"] = counts.get("would-sign", 0) + 1
        else:
            try:
                sign_one(p, mime, s)
                counts["signed"] = counts.get("signed", 0) + 1
            except Exception as e:
                counts["error"] = counts.get("error", 0) + 1
                print("ERROR", p.relative_to(ROOT), e)
        done += 1
        if a.limit and done >= a.limit:
            break
    print("summary:", counts)


if __name__ == "__main__":
    main()
