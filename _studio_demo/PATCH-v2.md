# RKK Studio v2 Patch

Builds on `_studio_demo/SPEC.md` (v1). All v1 contracts still hold; this adds new fields and behaviors. Keep changes additive — do not break existing v1 page.json files.

---

## Schema additions

### `text` element — new fields
```json
{
  "type": "text",
  "mode": "flow",                 // NEW: "flow" | "decorative"; default "flow"
  "pageAnchor": "none",           // NEW: "none" | "left" | "center" | "right"; default "none"; only honored in flow mode
  "rotation": 0,                  // NEW (was implicit 0): degrees; honored in decorative mode
  "x": 8.3, "y": 12.0, "w": 41.7, // existing — in decorative mode these are absolute %; in flow mode x/y are ignored, w sets max-width of the block
  ...
}
```

Flow mode (default): block is in normal document order. `pageAnchor` controls horizontal placement of the block within the canvas — left = `margin-right: auto`, center = `margin: 0 auto`, right = `margin-left: auto`. `w` sets `max-width`.

Decorative mode: block is `position: absolute` at `left:x%; top:y%; width:w%`, with `transform: rotate(rotation deg)`. Same affordances as `image-decorative`.

### `image-inline` and `image-decorative` — new fields
```json
{
  "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 },   // NEW: % of image, default all 0 = no crop
  "caption": null                                              // NEW: see below
}
```

`crop` is applied non-destructively via `clip-path: inset(top% right% bottom% left%)` on the displayed image. The original PNG is untouched. The cut PNG used for `shape-outside` should ALSO get the crop applied (otherwise wrap won't match the visible image) — easiest implementation: when crop is non-zero, generate an in-memory cropped+rotated alpha mask via `bakeAlphaMask`-style canvas op and use that as the `shape-outside` URL.

`caption` shape:
```json
{
  "content": "DOOMSCROLLER · CERAMIC · 2025",
  "style": {
    "family": "mono",        // "mono" | "serif" | "display"
    "size": 0.85,            // % of canvas width
    "transform": "uppercase", // "none" | "uppercase"
    "align": "center"        // "left" | "center" | "right"
  }
}
```

Caption renders as `<figcaption class="rkk-caption">` directly below the image, inside the same `<figure>`. It moves with the image (drag the image, caption follows). It's contenteditable in edit mode.

---

## Renderer additions (`/render/render.js`)

### New exports
```js
// Returns the alpha-tight bounding box of an image element in % of canvas width/height.
// For images with a cut alpha mask (image-inline.cutSrc, or any image with transparent
// padding), reads the mask via canvas, finds the box of pixels with alpha > threshold,
// returns { x, y, w, h } in PERCENT relative to the element's bounding rect (NOT canvas).
// The studio multiplies by the rendered element rect to position selection chrome.
// For images without alpha (or fully opaque), returns { x: 0, y: 0, w: 100, h: 100 }.
// Cached by (url, threshold).
export async function getAlphaBounds(imageUrl, threshold = 0.1) { ... }
```

### Updates to existing functions
- `renderElement` and `renderPage`: honor the new fields above.
- For `text` in decorative mode: render as `<div class="rkk-text rkk-text-deco" style="position:absolute; left:x%; top:y%; width:w%; transform:rotate(rotation deg);" contenteditable=...>`.
- For `text` in flow mode: honor `pageAnchor` via class `.rkk-anchor-left`, `.rkk-anchor-center`, `.rkk-anchor-right` on the text block; CSS in render.css implements the margin auto rules.
- For images: apply `clip-path: inset(top% right% bottom% left%)` when crop is set. When crop OR rotation is non-zero AND the element is image-inline, re-bake the shape-outside mask using `bakeAlphaMask` extended to also accept a crop param: `bakeAlphaMask(imageUrl, rotationDeg, crop)`. Update the function signature to accept an optional crop object: `{ left, top, right, bottom }` in %.
- For images: render `<figcaption class="rkk-caption">{content}</figcaption>` inside `<figure>` when caption is set. Inside `<figcaption>` the inner element is contenteditable in edit mode.

### New CSS classes (`render.css`)
- `.rkk-text-deco` — base style for free-placed text blocks
- `.rkk-anchor-left` / `.rkk-anchor-center` / `.rkk-anchor-right` — margin auto rules
- `.rkk-caption` — mono caps muted, small, top-margin 0.6em, follows the image inside the figure
- `.rkk-cropped` — sets `display: block` on the wrapped img with clip-path applied

---

## Studio additions (`/studio/`)

### Multi-file drop
Drop handler iterates over `event.dataTransfer.files`. Each file goes through the existing knock + write + insert pipeline. Insert location: cascade by 24px each so they don't perfectly overlap.

### Image bank panel
New left panel ABOVE (or replacing) the layers panel — actually keep both: bank on top, layers below, both in the same left rail. Bank section header: "BANK". List two sub-sections:
- "PAGE" — assets in `pages/<slug>/assets/` (current page only)
- "STUDIO" — assets in `assets/_bank/` (global, shared across all pages)

Each sub-section shows a 4-column grid of thumbnails (≤72px square, cream background, 1px rule border, mono caps filename below). Drag a thumbnail onto the stage to insert it as `image-inline` (or `image-decorative` if the user is holding `Alt`). The bank panel scans on:
- Studio launch
- After every drop (re-scan to pick up newly-added files)
- A "↻" refresh button at the section header

If `assets/_bank/` doesn't exist, create it on first studio launch (FSA). Show a hint in the empty state: "Drop PNGs into assets/_bank/ from Finder. They appear here."

### Crop tool
When an image is selected, the inspector gains a "Crop" button. Clicking enters crop mode:
- The image renders at full uncropped size with 50% opacity overlay outside the current crop area
- 4 draggable edge bars (top/right/bottom/left) define the crop
- Buttons: "Apply" (commit crop, exit mode), "Reset" (clear crop), "Cancel" (revert to entry crop, exit mode)
- ESC = Cancel
- Return = Apply
- Crop values write to `element.crop` as percentages of original image dimensions

### Tight bounding box for selection chrome
After every render, when an image is selected, the studio:
1. Calls `getAlphaBounds(element.cutSrc || element.src, 0.1)` to get the alpha-tight bbox in % of the element rect
2. Multiplies by the rendered element's `getBoundingClientRect()` to get pixel offsets
3. Positions selection ring + 8 handles + rotation handle on the alpha-tight box (NOT the full element rect)

Resize handles, when dragged, scale the entire underlying image (so transparent padding scales proportionally with the silhouette). Visually it looks like the silhouette is being resized, which is what the user wants.

For text elements (no alpha), keep the existing rectangular bounding box.

### Text page anchor
Text inspector adds a segmented control: "Anchor: [None] [←] [Center] [→]". Default None. Only visible when `mode === "flow"`.

### Text mode toggle
Text inspector adds a "Mode: [Flow] [Free]" toggle. Switching to "Free" sets `mode: "decorative"` and seeds `x:20, y:20, w:30, rotation:0`. Switching back to "Flow" clears those fields back to defaults.

### Free text drag/rotate
When text element has `mode: "decorative"`, the studio attaches the same selection chrome as images (ring + 8 handles + rotation handle). Drag the body to move (changes x/y), drag a corner to resize (changes w), drag the rotation handle to rotate. Same code path as images.

### Caption editing
Image inspector gains "+ Add caption" button when caption is null. Once added, the inspector shows: caption.content (textarea), caption.style.family (select), caption.style.size (number), caption.style.transform (select), caption.style.align (select), and a "Remove caption" button. Caption text is also editable inline by clicking the rendered caption (it's contenteditable).

### Split block at cursor
When a text block is being edited (cursor inside contenteditable), a "Split" button appears in the inspector. Cmd+Enter while editing also triggers it. Split logic:
1. Find the cursor position in the text element
2. Slice the content into two parts: before-cursor and after-cursor
3. Update the current element's content to before-cursor
4. Create a new text element (copy of the current one with a new id, offset y by the height of the original or insert immediately after in flow), set its content to after-cursor
5. Re-render

Split must work in both flow mode and decorative mode (in decorative mode, the second block appears slightly offset).

### Inspector summary (after v2)
Per element type, the v2 inspector shows everything in the v1 spec PLUS:
- text: pageAnchor, mode, rotation (if decorative), Split button (if editing)
- image-inline: crop button, "+ Add caption" or caption editor
- image-decorative: crop button, "+ Add caption" or caption editor

---

## Section library

A new toolbar dropdown labeled "+ Section" shows a grid of pre-composed sections. Each section is a small group of pre-configured elements with sensible defaults that get pushed into the current page in order. After insertion, every element is fully editable; the section is just a starting point, not a locked group.

The studio includes 10 sections in v2. They live in `/studio/sections.js` as a single exported module: `export const SECTIONS = [{ id, label, description, preview, build }, ...]` where `build()` returns an array of element objects ready to push.

The 10 sections, with their composition:

1. **Manifesto block** — `text` (display italic, size 5.2, one red word, pageAnchor "left", w 60) + `text` (serif italic dek, size 1.2, w 36)
2. **Image with wrap** — `image-inline` (side "right", width 38, anchor.afterParagraph 1) + `text` (serif body, w 100, dropCap on, ~5 paragraphs of placeholder content with one red span)
3. **Hero artifact** — `hero-artifact` (w 60, idleMotion "float", caption set) + `text` (serif body, pageAnchor "center", w 50, ~3 short paragraphs)
4. **Spec sheet** — `text` (mono caps eyebrow "SPECIMEN") + `spec-sheet` (4 default rows: MEDIUM / DIMENSIONS / EDITION / YEAR)
5. **Three-up gallery** — three `image-decorative` elements positioned at x=8/38/68, y=20, w=24, with optional captions seeded on each
6. **Pull quote** — `asterism` + `text` (display italic, pageAnchor "center", size 4.2, w 60, align "center", one red word) + `asterism`
7. **Stamp stack** — three `text` elements (family "mono", size 0.78, transform "uppercase", w 36) with cascading pageAnchor [left, center, right] OR cascading indents — both echo the 33M Gods rhythm; pick one default
8. **Marquee band** — `marquee` (background "ink", color "paper", speed 38, default content "FOLIO No. 07 · DEVOTION · ")
9. **CTA strip** — `text` (mono caps small eyebrow "JOIN THE STUDIO DISPATCH") + `single-field` (placeholder "your.email@studio", buttonLabel "SUBSCRIBE", action mailto:studio@raghavakk.com)
10. **Coda** — `text` (mono caps small "CLOSING LINE") + `text` (display italic, pageAnchor "center", size 5.2, w 50, one red word) + `asterism`

Each section's `preview` field is a 24-line ASCII or tiny SVG snippet shown in the picker (don't ship images — keep it lightweight). The picker UI: click "+ Section" in the toolbar → a modal-like dropdown opens (cream paper, 1px rule border, ink type) with a 2-column grid of sections, each card showing label + 1-line description + tiny preview. Click a card → section's elements are appended to the page, picker closes, the first new element gets selected.

Inserted elements get fresh IDs (sha-256 of timestamp + random). Anchor offsets are computed so multiple sections inserted in a row don't pile on top of each other.

The section library lives in its own file (`/studio/sections.js`) so adding new sections later is a one-file change.

---

## Out of scope for v2
- Asset bank from a folder OUTSIDE the project root (would require a second FSA handle).
- Crop preview while dragging crop bars (just show the post-crop result on Apply).
- Per-caption mode switch (decorative captions). Captions move with image only.
- Group/ungroup multiple elements.
- Snapping to other elements (only canvas edges via pageAnchor).
- Exported flat-image versions of cropped+rotated PNGs (always non-destructive in v2).

---

## Files touched in v2
**Renderer:** modify `/render/render.js`, modify `/render/render.css`. ADD `getAlphaBounds`. Update `bakeAlphaMask` signature to accept crop. Update `renderElement` for new schema fields.

**Studio:** modify `/studio/studio.html` (add bank panel slot), modify `/studio/studio.js` (multi-file drop, bank panel, crop tool, tight bbox, free text, page anchor, caption editing, split block), modify `/studio/studio.css` (bank panel styles, crop overlay styles).

**Bank seed:** ensure `/assets/_bank/.gitkeep` exists so the folder ships even when empty.

**No NEW top-level files.** No new HTML pages. Patches only.
