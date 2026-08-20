#!/bin/bash
# calling4 — copy + paintings-section rework (created by Claude, safe to delete after use)
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
git add calling4.html
git commit -m "calling4: Parsons lockup joined; quotes credited to Raghava KK; paintings section reworked title-first with curated detail thumbs; Kellen Gallery named; opening by invitation; credits updated (Vertex Inc, INK Foundation)"
git push origin main
echo
echo "=== DONE — press any key to close ==="
read -n 1
