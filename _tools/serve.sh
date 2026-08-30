#!/bin/bash
# Local development server for The New Raghava KK Website
# Browsers block PDF.js from loading PDFs over file:// for security.
# This script serves the site over http://localhost so PDFs load correctly.

cd "$(dirname "$0")/.."

PORT=8000

# Find a free port if 8000 is taken
while lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo ""
echo "  ──────────────────────────────────────────────"
echo "  Raghava KK · local server"
echo "  ──────────────────────────────────────────────"
echo "  Serving at  http://localhost:$PORT"
echo "  Press Ctrl+C to stop"
echo "  ──────────────────────────────────────────────"
echo ""

# Open in default browser after short delay
( sleep 1 && open "http://localhost:$PORT" ) &

python3 -m http.server "$PORT"
