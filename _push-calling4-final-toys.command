#!/bin/bash
# calling4 final toys — one-shot commit + push (created by Claude, safe to delete after use)
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
git add -A
git commit -m "calling4: pantheon swapped to final toys (matte black, equal-height framing); site-wide PDF spreads + today's process pages"
git push origin main
echo
echo "=== DONE — press any key to close ==="
read -n 1
