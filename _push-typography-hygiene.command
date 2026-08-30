#!/bin/bash
# Typography hygiene pass (2026-08-21) — one-shot backup tag + commit + push
# (created by Claude, safe to delete after use)
# Picks up:
#   - 23 root pages: dead CSS excised, Space Grotesk dropped, Fraunces trimmed 300..700,
#     inline type styles promoted to classes, becoming2 colophon h4/h3 fix,
#     gate pages red accent-word fix + 44px touch targets
#   - Index2.html deletion (retired to not-used/archive-removed-pages-2026-08-21/)
#   - .gitignore (adds _typography-audit/)
# Folder backup already exists: _backups/2026-08-21-pre-typography-hygiene/
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
git tag -f "pre-typography-hygiene-2026-08-21"
git add .gitignore 33m-mild.html about2.html becoming2.html calling4.html excavate2.html gate.html home.html index.html lab2.html library2.html network.html process-edges.html process-orgasm.html process-trojan.html process.html sitemap2.html studio2.html talks2.html terms.html timeline2.html toys2.html untitled-drop.html writings2.html
git add -A -- Index2.html
git commit -m "typography hygiene: excise dead CSS + dormant subsystems, drop Space Grotesk, trim Fraunces to 300..700, promote inline type styles to classes; fix becoming2 colophon h4/h3 and gate accent word; retire Index2.html"
git push origin main
git push -f origin "pre-typography-hygiene-2026-08-21"
echo
echo "=== DONE — press any key to close ==="
read -n 1
