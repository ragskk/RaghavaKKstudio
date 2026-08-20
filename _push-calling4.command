#!/bin/bash
# Calling All Gods — one-shot commit + push (created by Claude, safe to delete after use)
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
git add calling4.html middleware.js images/details
git commit -m "calling4: pantheon to 4 compact 3D studies; correct La Liberte size (11.5x23.5); real La Liberte details; Volte Art Projects as presenting gallery"
git push origin main
echo
echo "=== DONE — press any key to close ==="
read -n 1
