#!/bin/bash
# Typography + ground rollout (2026-08-30) — one-shot backup tag + commit + push
# (created by Claude, safe to delete after use)
# Ships: Erode / Literata / iA Writer Mono self-hosted in /fonts/, white ground,
# shared css/type.css, strict mono diet + TYPE-SPEC normalizations across 22 pages
# + 5 css modules + render.css. calling4 untouched.
# Folder backup already exists: _backups/2026-08-30-pre-type-rollout/
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
git tag -f "pre-type-rollout-2026-08-30"
git add fonts css/type.css css/book-modal.css css/library-shelf.css css/network-field.css css/toys-grid.css render/render.css
git add home.html index.html gate.html studio2.html timeline2.html excavate2.html process.html process-edges.html process-orgasm.html process-trojan.html becoming2.html writings2.html about2.html lab2.html library2.html network.html sitemap2.html talks2.html toys2.html terms.html 33m-mild.html untitled-drop.html
git commit -m "type rollout: Erode + Literata + iA Writer Mono self-hosted, white ground, shared type.css tokens, strict mono diet + spec normalizations sitewide (calling4 exempt)"
git push origin main
git push -f origin "pre-type-rollout-2026-08-30"
echo
echo "=== DONE — press any key to close ==="
read -n 1
