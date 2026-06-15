# Calling All Gods — `calling3.html` handoff

A standalone exhibition microsite for *Calling All Gods* (Parsons School of Design, NY, Dec 2026 – Mar 2027). This is the **redesigned** page; `calling2.html` is the earlier version and is left untouched.

## Look & build
- **Bold contemporary poster** direction: grey high-contrast ground, near-black panels, one loud vermilion accent, oversized headlines over imagery, asymmetric bento, kinetic scroll reveals.
- **System fonts only** (Helvetica Neue / Arial / system mono). No web-font dependency, so it renders identically in every browser and offline. (Earlier Syne version was dropped per preference.)
- **Standalone**: no links to other pages, no access gate. Safe to deploy on its own.

## How to view / deploy
- **3D toys need a served page.** Open from a local server, not as a file:
  `cd "The New Raghava KK Website" && python3 -m http.server 8000` → `http://localhost:8000/calling3.html`
- **Live site**: push `main` (Vercel auto-deploys). `vercel.json` already carries the CSP fix (`wasm-unsafe-eval` + `worker-src blob:`) that lets the 3D render once deployed.

## Working pieces
- Collapsible **artist statement** with two expandable footnotes.
- **Art-zine shelf** (4 books: Calling All Gods, 33M Gods, MAYBE you KNOW ME) → opens the shared **popup spread reader**. Calling All Gods book = 49 spreads at `images/spreads/Calling_All_Gods/`.
- **Pantheon**: 4 live 3D toy figures (Trump, Bezos, Musk, Zuck).
- **Full-screen** button, top right.

## Open items (TODO)
1. **Signature** — drop `images/raghava-signature.png` (transparent PNG) into the project. It is already wired into the footer and rendered white automatically; hidden until the file exists.
2. **Toys as flat images** — the four GLBs only show as 3D when served. Headless rendering was not possible in this environment. To show them offline/in the preview, render the GLBs to PNGs on a machine with working WebGL and swap the `<model-viewer>` tags for `<img>`.
3. **Practical TKs** — fill exact gallery, opening date & time, hours, curator (footer ticket).
4. **Hero image** — the gallery composite has placeholder wall labels baked in ("Surrealist Tapestry / Cosmic Pantheon, Artist 2023"); swap if undesired.

## Files involved
- `calling3.html` — the page.
- `images/spreads/Calling_All_Gods/p-01…49.jpg` — book reader spreads.
- `images/books/art_Calling_All_Gods.jpg` — book cover.
- `books/art books/Calling All Gods_Artist Book.pdf` — 49pp book (52 MB).
- `js/book-modal.js` — has the `Calling All Gods` spreads entry.
- `vercel.json` — CSP updated for 3D.
