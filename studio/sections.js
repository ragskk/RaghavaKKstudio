// ───────────────────────────────────────────────────────────────────
// RKK Studio · Section Library · v2
// Pre-composed groups of elements. Each section returns a fresh
// array of element objects with new ids. The studio appends them to
// the current page; nothing is locked once placed.
// ───────────────────────────────────────────────────────────────────

function rid(prefix) {
  // Cheap unique id: prefix + base36 of (now + random).
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${t}${r}`.slice(0, 24);
}

export const SECTIONS = [
  // 1. Manifesto block ────────────────────────────────────────────────
  {
    id: 'manifesto',
    label: 'Manifesto',
    description: 'Display italic with one red word and a serif italic dek.',
    preview: 'THE STUDIO\nIS A FRAGMENT.\n— a small dek follows.',
    build: () => ([
      {
        id: rid('txt'), type: 'text', z: 1, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'left', w: 60, rotation: 0,
        content: "The studio answers in italic serif and a single <span class='red'>red</span> word.",
        style: { family: 'display', size: 5.2, weight: 400, leading: 0.98, align: 'left', italic: true, transform: 'none', dropCap: false },
        wrapNeighbours: false,
      },
      {
        id: rid('txt'), type: 'text', z: 2, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'left', w: 36, rotation: 0,
        content: 'A dek in serif italic. Quiet, accurate, not embarrassed by feeling.',
        style: { family: 'serif', size: 1.2, weight: 380, leading: 1.5, align: 'left', italic: true, transform: 'none', dropCap: false },
        wrapNeighbours: true,
      },
    ]),
  },

  // 2. Image with wrap ───────────────────────────────────────────────
  {
    id: 'image-with-wrap',
    label: 'Image with wrap',
    description: 'Right-floated image with body text wrapping around it.',
    preview: '┌──┐  body text\n│██│  body text\n└──┘  body text',
    build: () => ([
      {
        id: rid('img'), type: 'image-inline', z: 1, locked: false, hidden: false,
        src: '', cutSrc: '', side: 'right',
        anchor: { afterParagraph: 1 },
        width: 38, rotation: 0, shapeMargin: 18, shapeThreshold: 0.35,
        specimen: false, crop: null, caption: null,
      },
      {
        id: rid('txt'), type: 'text', z: 2, locked: false, hidden: false,
        mode: 'flow', w: 100, rotation: 0,
        content: "A first paragraph sets the room. The studio is a workbench, not an altar.\n\nA second paragraph admits the <span class='red'>obvious</span> thing the first refused to. The image floats here on the right and the type breathes around its silhouette.\n\nA third paragraph carries the argument forward without pressing.\n\nA fourth paragraph is shorter, a half-step.\n\nA fifth paragraph closes on something usable: a piece of work, a date, a small refusal.",
        style: { family: 'serif', size: 1.15, weight: 400, leading: 1.55, align: 'left', italic: false, transform: 'none', dropCap: true },
        wrapNeighbours: true,
      },
    ]),
  },

  // 3. Hero artifact ────────────────────────────────────────────────
  {
    id: 'hero-artifact',
    label: 'Hero artifact',
    description: 'Centered hero image with a serif body block beneath.',
    preview: '   ┌──────┐\n   │ HERO │\n   └──────┘\n     body',
    build: () => ([
      {
        id: rid('hro'), type: 'hero-artifact', z: 1, locked: false, hidden: false,
        src: '', w: 60, idleMotion: 'float', specimen: false,
        caption: 'WORKING TITLE · MEDIUM · YEAR',
      },
      {
        id: rid('txt'), type: 'text', z: 2, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'center', w: 50, rotation: 0,
        content: "A short paragraph in serif. Three of them, centered, none of them long.\n\nA second paragraph that admits something specific about the object above it.\n\nA third paragraph that lands.",
        style: { family: 'serif', size: 1.1, weight: 400, leading: 1.55, align: 'left', italic: false, transform: 'none', dropCap: false },
        wrapNeighbours: true,
      },
    ]),
  },

  // 4. Spec sheet ──────────────────────────────────────────────────
  {
    id: 'spec-sheet',
    label: 'Spec sheet',
    description: 'Mono caps eyebrow over a four-row Yale data block.',
    preview: 'SPECIMEN\nMEDIUM     ·····\nDIMENSIONS ·····\nEDITION    ·····\nYEAR       ·····',
    build: () => ([
      {
        id: rid('txt'), type: 'text', z: 1, locked: false, hidden: false,
        mode: 'flow', w: 100, rotation: 0,
        content: 'SPECIMEN',
        style: { family: 'mono', size: 0.78, weight: 500, leading: 1.2, align: 'left', italic: false, transform: 'uppercase', dropCap: false },
        wrapNeighbours: false,
      },
      {
        id: rid('spc'), type: 'spec-sheet', z: 2, locked: false, hidden: false,
        rows: [
          { label: 'MEDIUM',     value: 'CERAMIC, GLAZED' },
          { label: 'DIMENSIONS', value: '21 × 18 × 14 CM' },
          { label: 'EDITION',    value: '1 / 1' },
          { label: 'YEAR',       value: '2025' },
        ],
      },
    ]),
  },

  // 5. Three-up gallery ────────────────────────────────────────────
  {
    id: 'three-up-gallery',
    label: 'Three-up gallery',
    description: 'Three decorative images placed in a row across the canvas.',
    preview: '[A]   [B]   [C]\n one   two   three',
    build: () => ([
      {
        id: rid('dec'), type: 'image-decorative', z: 1, locked: false, hidden: false,
        src: '', x: 8, y: 20, w: 24, rotation: 0, opacity: 1,
        draggableAtRuntime: false, idleMotion: 'none',
        crop: null,
        caption: { content: 'ONE', style: { family: 'mono', size: 0.78, transform: 'uppercase', align: 'center' } },
      },
      {
        id: rid('dec'), type: 'image-decorative', z: 2, locked: false, hidden: false,
        src: '', x: 38, y: 20, w: 24, rotation: 0, opacity: 1,
        draggableAtRuntime: false, idleMotion: 'none',
        crop: null,
        caption: { content: 'TWO', style: { family: 'mono', size: 0.78, transform: 'uppercase', align: 'center' } },
      },
      {
        id: rid('dec'), type: 'image-decorative', z: 3, locked: false, hidden: false,
        src: '', x: 68, y: 20, w: 24, rotation: 0, opacity: 1,
        draggableAtRuntime: false, idleMotion: 'none',
        crop: null,
        caption: { content: 'THREE', style: { family: 'mono', size: 0.78, transform: 'uppercase', align: 'center' } },
      },
    ]),
  },

  // 6. Pull quote ─────────────────────────────────────────────────
  {
    id: 'pull-quote',
    label: 'Pull quote',
    description: 'Asterism, a centered display italic line with one red word, asterism.',
    preview: '·   ·   ·\nA QUOTE LANDS\n·   ·   ·',
    build: () => ([
      { id: rid('ast'), type: 'asterism', z: 1, locked: false, hidden: false },
      {
        id: rid('txt'), type: 'text', z: 2, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'center', w: 60, rotation: 0,
        content: "What the studio keeps it keeps in <span class='red'>silence</span>.",
        style: { family: 'display', size: 4.2, weight: 400, leading: 1.05, align: 'center', italic: true, transform: 'none', dropCap: false },
        wrapNeighbours: false,
      },
      { id: rid('ast'), type: 'asterism', z: 3, locked: false, hidden: false },
    ]),
  },

  // 7. Stamp stack ────────────────────────────────────────────────
  {
    id: 'stamp-stack',
    label: 'Stamp stack',
    description: 'Three mono-caps lines anchored left, center, right. Echoes 33M Gods.',
    preview: 'WHERE I COME FROM\n            WE HAVE\nTHIRTY-THREE MILLION GODS',
    build: () => ([
      {
        id: rid('txt'), type: 'text', z: 1, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'left', w: 36, rotation: 0,
        content: 'WHERE I COME FROM',
        style: { family: 'mono', size: 0.78, weight: 500, leading: 1.2, align: 'left', italic: false, transform: 'uppercase', dropCap: false },
        wrapNeighbours: false,
      },
      {
        id: rid('txt'), type: 'text', z: 2, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'center', w: 36, rotation: 0,
        content: 'WE HAVE',
        style: { family: 'mono', size: 0.78, weight: 500, leading: 1.2, align: 'center', italic: false, transform: 'uppercase', dropCap: false },
        wrapNeighbours: false,
      },
      {
        id: rid('txt'), type: 'text', z: 3, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'right', w: 36, rotation: 0,
        content: 'THIRTY-THREE MILLION GODS',
        style: { family: 'mono', size: 0.78, weight: 500, leading: 1.2, align: 'right', italic: false, transform: 'uppercase', dropCap: false },
        wrapNeighbours: false,
      },
    ]),
  },

  // 8. Marquee band ───────────────────────────────────────────────
  {
    id: 'marquee-band',
    label: 'Marquee band',
    description: 'Full-bleed scrolling band on ink with mono caps.',
    preview: '▓▓ FOLIO No. 07 · DEVOTION · ▓▓',
    build: () => ([
      {
        id: rid('mrq'), type: 'marquee', z: 1, locked: false, hidden: false,
        y: 0, content: 'FOLIO No. 07 · DEVOTION · ',
        background: 'ink', color: 'paper', speed: 38, direction: 'left',
      },
    ]),
  },

  // 9. CTA strip ─────────────────────────────────────────────────
  {
    id: 'cta-strip',
    label: 'CTA strip',
    description: 'Mono caps eyebrow above a one-field subscribe form.',
    preview: 'JOIN THE STUDIO DISPATCH\n[ your.email@studio ] [ SUBSCRIBE ]',
    build: () => ([
      {
        id: rid('txt'), type: 'text', z: 1, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'center', w: 60, rotation: 0,
        content: 'JOIN THE STUDIO DISPATCH',
        style: { family: 'mono', size: 0.78, weight: 500, leading: 1.2, align: 'center', italic: false, transform: 'uppercase', dropCap: false },
        wrapNeighbours: false,
      },
      {
        id: rid('fld'), type: 'single-field', z: 2, locked: false, hidden: false,
        placeholder: 'your.email@studio',
        buttonLabel: 'SUBSCRIBE',
        action: { type: 'mailto', to: 'studio@raghavakk.com' },
      },
    ]),
  },

  // 10. Coda ─────────────────────────────────────────────────────
  {
    id: 'coda',
    label: 'Coda',
    description: 'Closing eyebrow, a centered display italic line, an asterism.',
    preview: 'CLOSING LINE\nTHE STUDIO HOLDS ITS QUIET\n·   ·   ·',
    build: () => ([
      {
        id: rid('txt'), type: 'text', z: 1, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'center', w: 60, rotation: 0,
        content: 'CLOSING LINE',
        style: { family: 'mono', size: 0.78, weight: 500, leading: 1.2, align: 'center', italic: false, transform: 'uppercase', dropCap: false },
        wrapNeighbours: false,
      },
      {
        id: rid('txt'), type: 'text', z: 2, locked: false, hidden: false,
        mode: 'flow', pageAnchor: 'center', w: 50, rotation: 0,
        content: "The studio holds its <span class='red'>quiet</span>.",
        style: { family: 'display', size: 5.2, weight: 400, leading: 1.0, align: 'center', italic: true, transform: 'none', dropCap: false },
        wrapNeighbours: false,
      },
      { id: rid('ast'), type: 'asterism', z: 3, locked: false, hidden: false },
    ]),
  },
];
