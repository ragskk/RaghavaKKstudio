#!/bin/bash
# protect.js gap fix (2026-08-30) — commit 70a4c10 already made; this just pushes.
# (created by Claude, safe to delete after use)
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock .git/HEAD.lock
git push origin main
git push origin "pre-protectjs-gap-2026-08-30"
echo
echo "=== DONE — press any key to close ==="
read -n 1
