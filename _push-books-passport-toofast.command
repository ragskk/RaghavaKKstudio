#!/bin/bash
# Library — add PASSPORT + too fast, split art shelves, fix 2-up pairing,
# give the three text-only booklets real spreads so every book opens in the reader.
# (created by Claude 2026-08-30, safe to delete after use)
# Scoped add: leaves the about2 rework and other uncommitted edits alone.
cd "/Users/raghavakalyanaraman/Documents/Claude/Projects/The New Raghava KK Website" || exit 1
rm -f .git/index.lock
STAMP=$(date +%Y-%m-%d)
git tag -f "pre-library-books-$STAMP"
git add \
  "books/art books/PASSPORT book.pdf" "books/art books/PASSPORT book.md" \
  "books/art books/too fast.pdf" "books/art books/too fast.md" \
  images/books/art_PASSPORT.jpg images/books/art_too_fast.jpg \
  images/spreads/PASSPORT images/spreads/too_fast \
  images/spreads/Artist_Not_Found images/spreads/Studio_Projects_Book images/spreads/duck_forgot \
  js/book-modal.js css/book-modal.css data/library-rows.js lab2.html library2.html
git commit -m "library: add PASSPORT + too fast; art books over two shelves; reader pairs true spreads (cover alone, then 2-3); spreads for all three text-only booklets"
git push origin main
git push origin "pre-library-books-$STAMP"
echo
echo "=== DONE — press any key to close ==="
read -n 1
