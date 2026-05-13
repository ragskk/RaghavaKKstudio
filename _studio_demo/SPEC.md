# RKK Studio — Drop-Page Composer · v1 Spec

**Synthesis:** MSCHF drop-page energy × Yale typographic discipline × the RKK website's locked voice. The studio produces pages that look like an art collective's drop pages designed by a Yale typography graduate working on cream paper.

**Status:** v1 scaffold. No animations wired beyond idle-motion variants. Single user (Raghava). Direct write to folder via File System Access API. Hybrid image model (inline + decorative).

---

## File layout

```
/studio/
  studio.html        ← editor shell
  studio.js          ← editor logic (drop, drag, resize, rotate, inspector, save)
  studio.css         ← editor chrome only — NEVER style elements; that's render.css
/render/
  render.js          ← shared renderer used by studio AND published pages
  render.css         ← shared base styles for rendered elements
/pages/
  <slug>/
    page.json        ← layout source of truth
    assets/          ← uploaded PNGs (originals + cut versions)
      <hash>.png
      <hash>.cut.png
/<slug>.html         ← thin published page: imports render.js, calls renderPage('<slug>')
```

Rule: studio.css styles ONLY editor chrome (toolbar, handles, inspector, panels). The DOM rendered for the page itself uses render.css — same in edit and view mode. This guarantees WYSIWYG.

---

## page.json schema (v1)

```json
{
  "version": 1,
  "slug": "doomscrollers",
  "title": "The Doomscrollers",
  "dropNumber": "07",                         // string, shows as "DROP No. 07"
  "section": "DEVOTION",                      // breadcrumb / folio section
  "canvas": {
    "background": "paper",                    // "paper" | "paper-2" | "paper-3" | "ink"
    "maxWidth": 1480,                         // px, content max-width
    "minHeight": 100                          // % of viewport height
  },
  "cursor": "default",                        // "default" | "paint" | "crosshair" | "red-dot"
  "signature": "none",                        // "none" | "draggable-stickers" | "paint-trail"
  "elements": [ /* see below */ ],
  "createdAt": "2026-05-10T...",
  "updatedAt": "2026-05-10T..."
}
```

All numeric positions/sizes are **percentages of canvas width** (height computed from aspect or content).

---

## Element types

Every element has:
```json
{
  "id": "el-1a2b3c",
  "type": "...",
  "z": 5,                  // stacking order
  "locked": false,
  "hidden": false
}
```

### `text`
```json
{
  "type": "text",
  "x": 8.3, "y": 12.0, "w": 41.7,        // % of canvas width; y is doc-flow position for inline mode
  "content": "Where I come from, we have <span class='red'>thirty-three million</span> gods.",
  "style": {
    "family": "display",      // "display" (Instrument Serif italic) | "serif" (Fraunces) | "mono" (JetBrains Mono caps)
    "size": 5.2,              // % of canvas width
    "weight": 400,
    "leading": 0.95,          // line-height multiplier
    "align": "left",          // "left" | "right" | "center"
    "italic": true,
    "transform": "none"       // "none" | "uppercase"
  },
  "rotation": 0,
  "wrapNeighbours": true      // if true and a floated image is nearby, text reflows around it
}
```

Content supports inline HTML for `<span class="red">…</span>` only. Text is always a `<div contenteditable>` in edit mode, plain `<div>` in view mode.

### `image-inline` (floats, wraps text)
```json
{
  "type": "image-inline",
  "src": "./assets/<hash>.png",
  "cutSrc": "./assets/<hash>.cut.png",   // alpha-masked version used for shape-outside
  "side": "right",                        // "left" | "right"
  "anchor": { "afterParagraph": 2 },      // inserts as float before paragraph N+1 of nearest text block
  "width": 38,                            // % of column width
  "rotation": -3,                         // degrees; renderer re-bakes alpha mask if non-zero
  "shapeMargin": 18,                      // px breathing room
  "shapeThreshold": 0.35,                 // alpha cutoff for shape-outside
  "specimen": false                       // if true, adds polaroid frame + watermark
}
```

### `image-decorative` (absolute, no wrap, draggable-at-runtime if marked)
```json
{
  "type": "image-decorative",
  "src": "./assets/<hash>.png",
  "x": 12.5, "y": 24.0,                   // % of canvas (top-left of bounding box)
  "w": 22.0,                              // % of canvas width; height auto from aspect
  "rotation": 8,
  "opacity": 1,
  "draggableAtRuntime": false,            // if true, visitor can drag it on the live page
  "idleMotion": "none"                    // "none" | "float" | "wobble" | "spin-slow" | "parallax-mouse"
}
```

### `marquee` (full-bleed scrolling band)
```json
{
  "type": "marquee",
  "y": 0,                                  // doc-flow position; 0 = top, 100 = bottom
  "content": "DROP No. 07 · DEVOTION · A FRAGMENT FROM 33M GODS · ",
  "background": "ink",                     // "ink" | "red" | "paper-2" | "transparent"
  "color": "paper",
  "speed": 38,                             // seconds for full loop
  "direction": "left"                      // "left" | "right"
}
```

### `hero-artifact` (big centered image with idle motion — MSCHF signature)
```json
{
  "type": "hero-artifact",
  "src": "./assets/<hash>.png",
  "w": 60,                                 // % of canvas width
  "idleMotion": "float",                   // "float" | "wobble" | "spin-slow" | "parallax-mouse"
  "specimen": false,
  "caption": "DOOMSCROLLER · CERAMIC · 2025"
}
```

### `spec-sheet` (Yale-typographic two-column data block)
```json
{
  "type": "spec-sheet",
  "rows": [
    { "label": "MEDIUM", "value": "CERAMIC, GLAZED" },
    { "label": "DIMENSIONS", "value": "21 × 18 × 14 CM" },
    { "label": "EDITION", "value": "1 / 1" },
    { "label": "YEAR", "value": "2025" }
  ]
}
```

Renders as a clean grid: label left in JetBrains Mono caps muted, value right in Fraunces serif ink.

### `single-field` (CTA primitive — one input as the page's terminal action)
```json
{
  "type": "single-field",
  "placeholder": "your.email@studio",
  "buttonLabel": "JOIN THE DISPATCH",
  "action": { "type": "mailto", "to": "studio@raghavakk.com" }
}
```

### `asterism` (typographic break)
```json
{ "type": "asterism" }
```

### `drop-cap` (modifier on a text element — not a separate type)
Set `style.dropCap: true` on a `text` element. Renderer applies the broadsheet drop cap convention (Instrument Serif red, ~4.6em, float left).

---

## Rendering rules

### Canvas scaffolding
Every page is wrapped:
```html
<div class="rkk-page" data-bg="paper" data-cursor="default" data-signature="none">
  <div class="rkk-tape">…top tape (always present)…</div>
  <header class="rkk-masthead">…masthead with drop number…</header>
  <main class="rkk-canvas" style="--max:1480px">
    <!-- elements rendered here in z-order, layout depends on type -->
  </main>
  <footer class="rkk-colophon">…colophon with seal…</footer>
</div>
```

The tape, masthead, and colophon are rendered automatically from page meta — they are NOT elements in the array. Elements only describe the page body.

### Inline images and text wrap
- `image-inline` becomes `<figure class="rkk-float" style="float: <side>; width: <w>%; shape-outside: url(<cutSrc>)">…</figure>`
- It is inserted into the DOM **inside the nearest preceding text element's content**, before paragraph index `anchor.afterParagraph` (paragraphs split on `\n\n` in source content).
- When `rotation !== 0`, renderer calls `bakeAlphaMask(cutSrc, rotation)` to produce a rotated data-URL, applies it as both the visual transform and the shape-outside source. This keeps wrap and visual aligned.
- Resize is real-time (browser reflows on width change). Rotation is debounced to 32ms during drag, instant on release.

### Decorative images
- Rendered as `<img class="rkk-deco" style="position:absolute; left:<x>%; top:<y>%; width:<w>%; transform: rotate(<rotation>deg)">`.
- If `draggableAtRuntime: true`, renderer attaches a pointerdown handler in view mode that lets the visitor drag the image. No persistence.
- `idleMotion` applies a CSS animation class (`.rkk-motion-float`, `.rkk-motion-wobble`, `.rkk-motion-spin-slow`, `.rkk-motion-parallax-mouse`).

### Cursor
`data-cursor` on the page root selects from `cursor: url(...) auto` overrides defined in render.css. Options: `default`, `paint` (red ink dot), `crosshair`, `red-dot`.

### Signature interaction
`data-signature` on the page root activates a global script:
- `draggable-stickers`: any element with class `rkk-sticker` becomes draggable on the live page.
- `paint-trail`: loads draw.js (existing on Index2) for that page.
- `none`: nothing.

---

## Renderer API (`/render/render.js`)

ES module exporting:

```js
// Render an entire page into a container element.
// pageData: parsed page.json. mode: 'view' | 'edit'. options: { onElementClick }.
export async function renderPage(pageData, container, mode = 'view', options = {}) { … }

// Re-render a single element in place (for live updates from the editor).
export async function renderElement(elementData, parent, mode = 'view', options = {}) { … }

// Bake a rotated alpha mask. Returns a data URL the caller can use as
// shape-outside / mask-image / src. Cached by (url, deg) internally.
export async function bakeAlphaMask(imageUrl, rotationDeg) { … }

// Knock out the dominant background color of an image (sample corner pixels,
// soft alpha ramp around the threshold). Returns a data URL with proper alpha.
// Used by the studio on drop. Conservative defaults: corner sample, distance ramp 35→75.
export async function knockBackground(imageUrl) { … }

// Convenience: load and render the page at /pages/<slug>/page.json.
// Used by the published HTML stubs.
export async function bootPage(slug, container = document.getElementById('page')) { … }
```

In edit mode every rendered element gets:
- `data-element-id="<id>"`
- `data-element-type="<type>"`
- A 1px transparent outline that highlights on hover

The renderer does NOT attach selection handles or property panels. Those are studio.js's job.

---

## Studio UI (`/studio/`)

Single HTML page. Three regions:

**Top toolbar** (full width, ink background, mono caps):
- Page picker (dropdown of /pages/* + "+ New Page" + "Open project folder")
- Add: `T Text`, `M Marquee`, `H Hero Artifact`, `S Spec Sheet`, `F Single Field`, `· Asterism`, `↳ Image (drop a file)`
- Undo / Redo
- Save indicator (auto-saves every 2s, shows "saved" or "saving…")
- View mode toggle (renders the page without editor chrome — essentially a preview window)

**Center stage**:
- The page renders here at fluid width with editor chrome overlaid:
  - Selection ring (1px red dashed)
  - Eight resize handles (red squares, 8px)
  - Rotation handle (red circle, 12px above top-center)
  - During drag of an inline image vertically: thin red horizontal guide line showing landing paragraph

**Right inspector** (cream-paper card, 320px wide):
- For text: family, size, weight, leading, align, italic, transform, drop cap toggle, rotation
- For image-inline: side, anchor paragraph, width, rotation, shape margin, shape threshold, specimen toggle, "Switch to decorative" button
- For image-decorative: x, y, w, rotation, opacity, draggable-at-runtime toggle, idle motion select, "Switch to inline" button
- For marquee: content, background, color, speed, direction
- For hero artifact: width, idle motion, specimen toggle, caption
- For spec sheet: editable rows
- For single field: placeholder, button label, action target
- Page-level (when nothing selected): drop number, section, background, cursor, signature

**Left layers panel** (cream-paper card, 240px wide, collapsible):
- Z-ordered list of elements
- Each row: type icon · short label · eye toggle · lock toggle
- Drag to reorder z-index
- Click to select

**Drop zone**: the entire stage area accepts file drops. PNG/JPG only. On drop:
1. Hash the file (sha-256, first 12 chars).
2. Write original to `pages/<slug>/assets/<hash>.<ext>` via FSA.
3. Call `renderer.knockBackground()` to produce the alpha-masked version. Write to `<hash>.cut.png`.
4. Insert a new `image-inline` element at the drop location. Inspector switches to it.
5. User can immediately switch to `image-decorative` if they want free placement.

**Save mechanics**:
- File System Access API. On first launch, studio asks user to grant access to the project root.
- All saves go through a debounced writer (2s after last change).
- Writes to `pages/<slug>/page.json`.
- Also rewrites the published HTML stub at `/<slug>.html` if it doesn't exist (10-line template).

**Keyboard**:
- Cmd+Z / Cmd+Shift+Z — undo / redo
- Cmd+D — duplicate selected
- Delete / Backspace — remove selected
- Arrow keys — nudge by 0.5%
- Shift + Arrow keys — nudge by 5%
- Cmd+S — force save
- Esc — deselect

---

## Asset processing

### `knockBackground(imageUrl)`
Implementation: load image to a canvas, sample the four corner pixels, take the median color as background, compute distance per pixel from background, ramp alpha from 0 → 255 across distance band 35 → 75. Crop to bounding box of opaque pixels with 8px padding. Resize so longest side ≤ 1400px. Return as PNG data URL.

This handles the doomscroller (white bg) and the centaur (grey bg) cleanly. For PNGs that already have proper alpha (corner pixels are transparent), short-circuit and return the original.

### `bakeAlphaMask(imageUrl, rotationDeg)`
Implementation: load image to a canvas sized to bounding box of rotation, draw the image rotated, return data URL. Cached by `(imageUrl, rotationDeg)` so repeated rotations are instant. Used by the renderer on rotated inline images.

---

## What's OUT of scope for v1

- Animation primitives beyond `idleMotion` (fade-in, scroll-parallax, hover-scale, sequenceText). Schema reserves `anim` field on every element but renderer ignores it.
- Multiple pages in one tab.
- Mobile-specific overrides (per-element `mobile` block).
- Collaborative editing, history, drafts.
- Built-in fonts beyond the three loaded by the site.
- Sound on hover.
- Modal-as-payoff (deferred to v2 — schema reserves a `modal` field on `single-field` action).
- Per-page font/palette overrides (RKK voice constant; do not introduce).
- Custom-cursor bitmap upload (v1 uses the four named cursors only).

---

## Success test

A round-trip works when:
1. Open `/studio/studio.html` in Chrome.
2. Connect project folder.
3. Create a new page "test-drop".
4. Drop a PNG from desktop. It auto-knocks background, appears as inline image with text wrap.
5. Add a text block. Type. Watch text wrap around the image silhouette in real-time.
6. Resize the image. Text reflows in real-time.
7. Rotate the image 30°. Text reflows around the rotated silhouette in real-time.
8. Switch the image to decorative mode. It pops out of flow and floats free. Drag it. Text returns to full width.
9. Add a marquee, a hero artifact, and a spec sheet.
10. Open `/test-drop.html` in another tab. The page renders identically without editor chrome.
11. Reload `/studio/studio.html`. Page comes back exactly as left.
