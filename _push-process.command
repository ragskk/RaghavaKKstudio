#!/bin/bash
# Process pages — one-shot backup tag + commit + push of ALL process dossiers
# (created by Claude, safe to delete after use)
# Run this AFTER all series dossiers are built. It picks up:
#   - process.html (the index) and every process-*.html dossier
#   - all curated images + doc PDFs under images/process/
#   - .gitignore (keeps raw source folders out of git)
#   - studio2.html + timeline2.html (dossier cross-links on Edges surfaces)
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
STAMP=$(date +%Y-%m-%d)
git tag -f "pre-process-pages-$STAMP"
git add .gitignore process.html process-*.html "images/process" studio2.html timeline2.html
git commit -m "process: dossier index + series process pages + cross-links from studio and timeline"
git push origin main
git push origin "pre-process-pages-$STAMP"
echo
echo "=== DONE — press any key to close ==="
read -n 1
