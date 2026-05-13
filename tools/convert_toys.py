#!/usr/bin/env python3
"""
convert_toys.py
---------------
Walks /toys-source/ and converts source 3D files (STL / OBJ / GLB) into
web-optimized GLBs in /toys/.

Pipeline per file:
  1. Load (trimesh handles STL/OBJ/GLB natively).
  2. Decimate to a target face count (default 35k) so we ship ~1-3MB GLBs.
  3. Center + uniform-scale to a 1.0 bounding sphere so model-viewer's
     default camera framing is consistent across all toys.
  4. Assign a neutral matte PBR material when one is missing (STLs come
     in materialless — we don't want a plasticky white shine).
  5. Export to GLB.
  6. Post-process the GLB with `gltf-transform optimize` (Draco mesh
     compression, weld vertices, dedupe, prune unused).

Usage:
  python3 tools/convert_toys.py
  python3 tools/convert_toys.py --target-faces 50000
  python3 tools/convert_toys.py --skip-existing

This script is idempotent: re-running it overwrites the outputs.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

# ----------------------------------------------------------------------
# Paths

ROOT          = Path(__file__).resolve().parent.parent
SOURCE_DIR    = ROOT / "toys-source"
OUTPUT_DIR    = ROOT / "toys" / "3d"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"

# gltf-transform CLI path (installed globally under user's npm prefix)
GLTF_TRANSFORM = shutil.which("gltf-transform") or os.path.expanduser(
    "~/.npm-global/bin/gltf-transform"
)


# ----------------------------------------------------------------------
# Per-toy metadata. Source of truth for the manifest. Edit titles, years,
# notes here — slugs map to the files written to /toys/.

# ROWS — how toys are grouped on the page's shelves. Each row gets a
# label (mono caps) + note (display italic) above it, library-style.
# Slugs not listed in any row fall into a default "Other" row at the bottom.
ROWS = [
    {
        "label": "Pantheon",
        "note":  "caricatured figures of contemporary power",
        "slugs": ["trump", "bezos", "musk", "zuck"],
    },
    {
        "label": "Studio dolls",
        "note":  "softer figures from the studio",
        "slugs": ["holo-1", "tiwrk-01"],
    },
]


# Per-toy keys:
#   slug, source, title, year, medium, dimensions, note (manifest data)
#   poster      — optional source image path, becomes the tile poster
#   axis_up     — "y" (default; glTF/model-viewer convention) or "z"
#                 (source is Z-up; will be rotated −90° around X so the
#                 figure stands upright in the viewer)
#   material    — optional PBR override for materialless meshes (STLs):
#                 {name, baseColor [3 or 4 floats 0-1], metallic, roughness}
TOYS = [
    {
        "slug":       "trump",
        "source":     "1_Trump.stl",
        "title":      "Trump",
        "year":       "2025",
        "medium":     "Digital sculpt, 3D-printable",
        "dimensions": "TK",
        "note":       "TK — one line on what this figure does in the work.",
        "axis_up":    "z",
        # No source textures exist for the STL caricatures. Per-toy PBR
        # colors give them distinguishable identities instead of identical
        # matte-clay sameness. Tied to recognizable character cues:
        # tie-red, deep cool grey, chrome, muted blue.
        "material":   {"name": "trump-red",   "baseColor": [0.65, 0.18, 0.16], "metallic": 0.0, "roughness": 0.55},
    },
    {
        "slug":       "bezos",
        "source":     "2_Bezos.stl",
        "title":      "Bezos",
        "year":       "2025",
        "medium":     "Digital sculpt, 3D-printable",
        "dimensions": "TK",
        "note":       "TK — one line on what this figure does in the work.",
        "axis_up":    "z",
        "material":   {"name": "bezos-graphite", "baseColor": [0.32, 0.32, 0.34], "metallic": 0.05, "roughness": 0.55},
    },
    {
        "slug":       "musk",
        "source":     "3_Musk.stl",
        "title":      "Musk",
        "year":       "2025",
        "medium":     "Digital sculpt, 3D-printable",
        "dimensions": "TK",
        "note":       "TK — one line on what this figure does in the work.",
        "axis_up":    "z",
        "material":   {"name": "musk-chrome", "baseColor": [0.72, 0.74, 0.76], "metallic": 0.85, "roughness": 0.32},
    },
    {
        "slug":       "zuck",
        "source":     "4_Zuck.stl",
        "title":      "Zuck",
        "year":       "2025",
        "medium":     "Digital sculpt, 3D-printable",
        "dimensions": "TK",
        "note":       "TK — one line on what this figure does in the work.",
        "axis_up":    "z",
        "material":   {"name": "zuck-blue", "baseColor": [0.18, 0.28, 0.42], "metallic": 0.0, "roughness": 0.6},
    },
    {
        "slug":       "holo-1",
        "source":     "Holo_toy1.glb",
        "title":      "Holo · I",
        "year":       "2024",
        "medium":     "Resin + holographic film",
        "dimensions": "TK",
        "note":       "TK — one line on what this figure does in the work.",
    },
    {
        "slug":       "tiwrk-01",
        "source":     "TIWRK-01/1.1.obj",
        "title":      "TIWRK · 01",
        "year":       "2023",
        "medium":     "Cast resin, painted",
        "dimensions": "TK",
        "note":       "TK — first of the cute-doll-of-india pantheon.",
        "poster":     "TIWRK-01/poster.png",
    },
]


# ----------------------------------------------------------------------

def info(msg: str) -> None:
    print(f"  · {msg}", flush=True)


def log(msg: str) -> None:
    print(f"\n[{msg}]", flush=True)


def normalize_and_decimate(
    mesh: trimesh.Trimesh,
    target_faces: int,
    axis_up: str = "y",
) -> trimesh.Trimesh:
    """Orient, scale, foot-align, and decimate.

    Foot-alignment matters for the toys shelf: model-viewer auto-frames
    each model with its bbox CENTER at the viewport center. For toys
    with different bbox shapes that gives different on-screen heights
    for their "feet". To make every toy stand on the same shelf line,
    every GLB ships with its lowest point at Y = -0.5 in model space
    (X and Z centered on 0). Combined with a FIXED `camera-target` in
    the page JS (see js/toys-lazy.js), world Y = -0.5 maps to the same
    screen Y across every tile.

    axis_up: "y" (default — glTF / model-viewer convention, no rotation),
             "z" (source is Z-up — common for STL, Blender, ZBrush,
                  most 3D-printing tools — apply −90° X rotation so the
                  source's +Z becomes the viewer's +Y).
    """

    if isinstance(mesh, trimesh.Scene):
        if len(mesh.geometry) == 0:
            raise RuntimeError("scene contains no geometry")
        mesh = trimesh.util.concatenate(
            [m for m in mesh.geometry.values() if isinstance(m, trimesh.Trimesh)]
        )

    # Axis fix BEFORE anything else so bbox is computed in viewer orientation.
    if axis_up == "z":
        info("rotating Z-up → Y-up (−90° around X)")
        rot = trimesh.transformations.rotation_matrix(-np.pi / 2.0, [1, 0, 0])
        mesh.apply_transform(rot)
    elif axis_up != "y":
        info(f"unknown axis_up='{axis_up}' — leaving orientation unchanged")

    # Scale first so the foot-alignment target value (-0.5) is in the
    # same units across all toys.
    extents = mesh.bounding_box.extents
    longest = float(np.max(extents))
    if longest > 0:
        mesh.apply_scale(1.0 / longest)

    # Foot-align: bottom (min_y) at -0.5, X and Z centers at 0.
    bounds = mesh.bounds          # [[min_x, min_y, min_z], [max_x, max_y, max_z]]
    cx = (bounds[0][0] + bounds[1][0]) * 0.5
    cz = (bounds[0][2] + bounds[1][2]) * 0.5
    shift_y = -0.5 - bounds[0][1]
    mesh.apply_translation([-cx, shift_y, -cz])
    info(f"foot-aligned: min_y=-0.5, X/Z centered")

    n_faces = len(mesh.faces)
    if n_faces > target_faces:
        ratio = target_faces / n_faces
        info(f"decimating {n_faces:,} → ~{target_faces:,} faces (ratio {ratio:.2f})")
        try:
            mesh = mesh.simplify_quadric_decimation(face_count=target_faces)
        except Exception as e:
            info(f"quadric decimation unavailable ({e}); falling back to no-op")
    else:
        info(f"{n_faces:,} faces — under budget, no decimation")

    return mesh


def ensure_pbr_material(mesh: trimesh.Trimesh, material_override: dict | None = None) -> trimesh.Trimesh:
    """Assign a PBR material if the mesh has none, or override if specified.

    STL files arrive without materials. By default we give them a warm
    matte clay so they read well on the paper palette. Individual toys
    can override via the `material` key in TOYS — a dict with optional
    keys: baseColor (3 or 4 floats 0-1), metallic, roughness, name.
    """

    if material_override:
        info(f"applying per-toy material override: {material_override.get('name','?')}")
        base = material_override.get("baseColor", [0.74, 0.69, 0.59, 1.0])
        if len(base) == 3:
            base = list(base) + [1.0]
        mat = trimesh.visual.material.PBRMaterial(
            name=material_override.get("name", "override"),
            baseColorFactor=base,
            metallicFactor=float(material_override.get("metallic", 0.0)),
            roughnessFactor=float(material_override.get("roughness", 0.85)),
        )
        mesh.visual = trimesh.visual.TextureVisuals(material=mat)
        return mesh

    has_material = (
        getattr(mesh.visual, "material", None) is not None
        or getattr(mesh.visual, "vertex_colors", None) is not None
    )
    if not has_material:
        info("no material on source — assigning matte clay PBR")
        mat = trimesh.visual.material.PBRMaterial(
            name="matte-clay",
            baseColorFactor=[0.74, 0.69, 0.59, 1.0],
            metallicFactor=0.0,
            roughnessFactor=0.85,
        )
        mesh.visual = trimesh.visual.TextureVisuals(material=mat)

    return mesh


def convert_obj_via_obj2gltf(src: Path, dst: Path) -> bool:
    """Convert OBJ + MTL (with per-face materials) to GLB using obj2gltf.

    trimesh flattens multi-material OBJs to a single material on load,
    which loses the painterly coloring of files like the TIWRK toys.
    obj2gltf (Node tool) preserves the full MTL setup. Returns True
    on success.
    """
    OBJ2GLTF = shutil.which("obj2gltf") or os.path.expanduser("~/.npm-global/bin/obj2gltf")
    if not Path(OBJ2GLTF).exists() and not shutil.which("obj2gltf"):
        info("obj2gltf not found — falling back to trimesh OBJ load")
        return False
    try:
        result = subprocess.run(
            [OBJ2GLTF, "-i", str(src), "-o", str(dst), "-b"],
            capture_output=True, text=True, timeout=180,
        )
        if result.returncode == 0 and dst.exists():
            info("obj2gltf preserved MTL materials")
            return True
        info(f"obj2gltf failed (rc={result.returncode}): {result.stderr.strip()[:200]}")
    except Exception as e:
        info(f"obj2gltf error: {e}")
    return False


def normalize_glb_in_place(path: Path, axis_up: str, target_faces: int) -> None:
    """Load a GLB (from obj2gltf or passthrough), apply axis fix, scale
    by max-axis = 1.0, foot-align so min_y = -0.5 with X/Z centered.
    Used wherever per-mesh materials must be preserved — trimesh
    concatenate flattens them but Scene-level apply_transform keeps
    the scene structure intact."""
    scene = trimesh.load(str(path))
    if isinstance(scene, trimesh.Scene):
        if axis_up == "z":
            info("rotating Z-up → Y-up (−90° around X)")
            rot = trimesh.transformations.rotation_matrix(-np.pi / 2.0, [1, 0, 0])
            scene.apply_transform(rot)
        # Scale to unit max extent
        extents = scene.bounding_box.extents
        longest = float(np.max(extents))
        if longest > 0:
            scene.apply_scale(1.0 / longest)
        # Foot-align (after scale, so bounds are in normalized units)
        bounds = scene.bounds
        cx = (bounds[0][0] + bounds[1][0]) * 0.5
        cz = (bounds[0][2] + bounds[1][2]) * 0.5
        shift_y = -0.5 - bounds[0][1]
        scene.apply_translation([-cx, shift_y, -cz])
        info(f"foot-aligned scene: min_y=-0.5, X/Z centered")
        scene.export(file_obj=str(path), file_type="glb")


def simplify_glb_meshopt(path: Path, ratio: float = 0.08) -> None:
    """Run gltf-transform's meshopt-based simplifier in place. Preserves
    per-mesh materials (unlike trimesh concatenation). Used after
    obj2gltf to bring file size from full-resolution down to web-sized
    while keeping the multi-material coloring intact."""
    if not Path(GLTF_TRANSFORM).exists() and not shutil.which("gltf-transform"):
        info("gltf-transform not available — skipping simplification")
        return
    before = path.stat().st_size / (1024 * 1024)
    try:
        result = subprocess.run(
            [GLTF_TRANSFORM, "simplify", str(path), str(path),
             "--ratio", str(ratio), "--error", "0.001"],
            capture_output=True, text=True, timeout=180,
        )
        after = path.stat().st_size / (1024 * 1024)
        if result.returncode == 0:
            info(f"simplified (ratio {ratio}): {before:.2f}MB → {after:.2f}MB")
        else:
            info(f"simplify failed: {result.stderr.strip()[:200]}")
    except Exception as e:
        info(f"simplify error: {e}")


def export_glb(mesh: trimesh.Trimesh, dst: Path) -> None:
    """Write a GLB."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(file_obj=str(dst), file_type="glb")


def run_gltf_optimize(path: Path) -> None:
    """Run gltf-transform dedupe + prune (no Draco / meshopt compression).

    Why no Draco: model-viewer loads its Draco decoder via fetch() of
    a wasm file. Chrome blocks that fetch when the page is opened via
    file://, so Draco-compressed GLBs fail to render under local
    double-click previews. Without Draco, GLBs are larger (~5-10×)
    but the page works under both file:// and http(s)://, which is
    the workflow Raghava actually uses. Texture compression to WebP
    is kept — that's a static format model-viewer reads natively.
    """
    if not Path(GLTF_TRANSFORM).exists() and not shutil.which("gltf-transform"):
        info("gltf-transform not found — skipping optimization step")
        return

    cmd = [
        GLTF_TRANSFORM,
        "optimize",
        str(path),
        str(path),
        "--compress",         "void",     # no Draco / meshopt — keep file:// preview working
        "--texture-compress", "webp",
        "--simplify",         "false",    # we already decimated in trimesh
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            info(f"gltf-transform warning: {result.stderr.strip()[:200]}")
        else:
            # Pull the final size from the output
            for line in result.stdout.splitlines():
                if "TOTAL" in line or "Saved" in line:
                    info(line.strip())
    except subprocess.TimeoutExpired:
        info("gltf-transform timed out — keeping unoptimized output")


def _manifest_entry_for_existing(toy: dict, dst: Path) -> dict:
    """Build a manifest entry for a toy whose GLB already exists, without
    re-converting. Used when --skip-existing skips the build but the
    toy should still appear in the manifest."""
    out_size = dst.stat().st_size / (1024 * 1024)
    poster_rel = None
    if "poster" in toy:
        # Look for the WebP version produced by the converter
        pdst = OUTPUT_DIR / f"{toy['slug']}.poster.webp"
        if pdst.exists():
            poster_rel = str(pdst.relative_to(ROOT))
    return {
        "slug":       toy["slug"],
        "title":      toy["title"],
        "year":       toy["year"],
        "medium":     toy["medium"],
        "dimensions": toy["dimensions"],
        "note":       toy["note"],
        "glb":        f"toys/3d/{toy['slug']}.glb",
        "poster":     poster_rel,
        "sizeMB":     round(out_size, 2),
    }


def convert_toy(toy: dict, target_faces: int, skip_existing: bool) -> dict | None:
    src = SOURCE_DIR / toy["source"]
    if not src.exists():
        log(f"SKIP {toy['slug']} — source missing: {src}")
        return None

    dst = OUTPUT_DIR / f"{toy['slug']}.glb"
    if skip_existing and dst.exists():
        log(f"SKIP {toy['slug']} — exists (keeping in manifest, use without --skip-existing to rebuild)")
        return _manifest_entry_for_existing(toy, dst)

    log(f"convert {toy['slug']}  ({src.name})")

    src_size = src.stat().st_size / (1024 * 1024)
    info(f"source: {src_size:.1f} MB")

    # Already-web-ready GLB: copy through, then foot-align in place so
    # this toy shares the shelf line with the others. Scene-level
    # apply_transform preserves embedded materials/textures.
    if src.suffix.lower() == ".glb":
        info("source is already GLB — copying through + foot-aligning")
        shutil.copy2(src, dst)
        normalize_glb_in_place(dst, axis_up=toy.get("axis_up", "y"), target_faces=target_faces)
    # OBJ files with MTL: route through obj2gltf so per-face materials
    # survive. trimesh would flatten them to one material.
    elif src.suffix.lower() == ".obj":
        if convert_obj_via_obj2gltf(src, dst):
            normalize_glb_in_place(dst, axis_up=toy.get("axis_up", "y"), target_faces=target_faces)
            # Web-size the GLB while preserving the per-mesh materials
            # the OBJ ships with (which a trimesh path would flatten).
            simplify_glb_meshopt(dst, ratio=toy.get("simplify_ratio", 0.08))
        else:
            info("falling back to trimesh OBJ loader (materials may flatten)")
            mesh = trimesh.load(str(src))
            mesh = normalize_and_decimate(mesh, target_faces=target_faces, axis_up=toy.get("axis_up", "y"))
            mesh = ensure_pbr_material(mesh, toy.get("material"))
            export_glb(mesh, dst)
    # STL and other single-material meshes
    else:
        mesh = trimesh.load(str(src), force="mesh" if src.suffix.lower() == ".stl" else None)
        mesh = normalize_and_decimate(
            mesh,
            target_faces=target_faces,
            axis_up=toy.get("axis_up", "y"),
        )
        mesh = ensure_pbr_material(mesh, toy.get("material"))
        export_glb(mesh, dst)

    run_gltf_optimize(dst)

    out_size = dst.stat().st_size / (1024 * 1024)
    info(f"output: {out_size:.2f} MB  →  {dst.relative_to(ROOT)}")

    # Build poster if specified — resize to 1200px longest side, output WebP.
    poster_rel = None
    if "poster" in toy:
        psrc = SOURCE_DIR / toy["poster"]
        if psrc.exists():
            try:
                img = Image.open(psrc).convert("RGB")
                w, h = img.size
                target = 1200
                if max(w, h) > target:
                    scale = target / max(w, h)
                    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
                pdst = OUTPUT_DIR / f"{toy['slug']}.poster.webp"
                img.save(pdst, "WEBP", quality=82, method=6)
                poster_rel = str(pdst.relative_to(ROOT))
                info(f"poster: {pdst.name}  ({pdst.stat().st_size/1024:.1f}KB)")
            except Exception as e:
                info(f"poster build failed: {e}")
        else:
            info(f"poster not found at {psrc}")

    entry = {
        "slug":       toy["slug"],
        "title":      toy["title"],
        "year":       toy["year"],
        "medium":     toy["medium"],
        "dimensions": toy["dimensions"],
        "note":       toy["note"],
        "glb":        f"toys/3d/{toy['slug']}.glb",
        "poster":     poster_rel,
        "sizeMB":     round(out_size, 2),
    }
    return entry


def write_manifest(entries: list[dict]) -> None:
    """Write the manifest in two forms:
       - toys/3d/manifest.json — canonical data
       - toys/3d/manifest.js   — same data wrapped in window.RKK_TOYS_MANIFEST,
         so the page can load it via <script src> and dodge the file://
         CORS restriction Chrome enforces on fetch().

       The .js form is what the page actually reads. The .json form is
       kept around as a human-readable inspection artifact and so other
       tools can consume it.
    """
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "rows":  ROWS,
        "toys": entries,
    }
    MANIFEST_PATH.write_text(json.dumps(payload, indent=2))

    js_path = OUTPUT_DIR / "manifest.js"
    js_body = (
        "/* AUTO-GENERATED by tools/convert_toys.py — do not edit by hand */\n"
        "window.RKK_TOYS_MANIFEST = " + json.dumps(payload, indent=2) + ";\n"
    )
    js_path.write_text(js_body)

    log(f"wrote manifest with {len(entries)} entries → {MANIFEST_PATH.relative_to(ROOT)} + manifest.js")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-faces", type=int, default=35000)
    parser.add_argument("--skip-existing", action="store_true")
    args = parser.parse_args(argv)

    if not SOURCE_DIR.exists():
        print(f"toys-source/ not found at {SOURCE_DIR}", file=sys.stderr)
        return 1

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    for toy in TOYS:
        entry = convert_toy(toy, args.target_faces, args.skip_existing)
        if entry is not None:
            entries.append(entry)

    write_manifest(entries)
    log("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
