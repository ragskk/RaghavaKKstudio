#!/bin/bash
# Preview Toys.command
# ---------------------------------------------------------------
# Double-click this file in Finder to preview toys2.html locally.
#
# Why this exists
#   toys2.html uses 3D models loaded via fetch(), which browsers
#   block when the page is opened directly from disk (file://).
#   This script starts a local HTTP server in the website folder
#   and opens the page in your default browser at the right URL.
#
# When you're done
#   Switch back to the Terminal window this opens and press Ctrl+C
#   to stop the server, or just close the Terminal tab.
# ---------------------------------------------------------------

# Resolve the website root (the parent directory of this script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT=8000

cd "$SITE_ROOT" || {
  echo "Could not cd into $SITE_ROOT"
  echo "Press any key to close."
  read -n 1
  exit 1
}

# Find a free port starting at 8000
while lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 ; do
  PORT=$((PORT + 1))
  if [ "$PORT" -gt 8050 ]; then
    echo "No free port between 8000-8050 — close other servers and try again."
    echo "Press any key to close."
    read -n 1
    exit 1
  fi
done

URL="http://localhost:$PORT/toys2.html"

echo "─────────────────────────────────────────────────────────"
echo "  Raghava KK · toys2.html preview"
echo "─────────────────────────────────────────────────────────"
echo "  Serving:  $SITE_ROOT"
echo "  Port:     $PORT"
echo "  URL:      $URL"
echo ""
echo "  Opening browser in 1 second…"
echo "  Press Ctrl+C in this window to stop the server."
echo "─────────────────────────────────────────────────────────"
echo ""

# Open the browser shortly after the server starts.
( sleep 1 && open "$URL" ) &

# Use python3 if available, fall back to python (macOS default).
if command -v python3 >/dev/null 2>&1 ; then
  python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1 ; then
  python -m SimpleHTTPServer "$PORT"
else
  echo "No python found. Install Python 3 (https://www.python.org) and retry."
  echo "Press any key to close."
  read -n 1
  exit 1
fi
