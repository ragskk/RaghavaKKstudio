// ───────────────────────────────────────────────────────────────────
// RKK Studio · Shared Renderer · v2
// Used by both the studio editor and published drop pages.
// Same code, edit/view switch. WYSIWYG by construction.
// v2 adds: text mode (flow/decorative), pageAnchor, image crop,
// image caption, and getAlphaBounds for tight selection chrome.
// ───────────────────────────────────────────────────────────────────

// LRU cache. Map preserves insertion order; on set, oldest entries are
// evicted once size exceeds cap. Critical for MASK_CACHE specifically
// because each rotated/cropped variant is a multi-megabyte data URL —
// rotating an image through 360 degrees would otherwise leak ~500MB.
class LRU {
  constructor(cap) { this.cap = cap; this.map = new Map(); }
  has(k) { return this.map.has(k); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);   // refresh recency
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);
    return this;
  }
  delete(k) { return this.map.delete(k); }
  clear() { this.map.clear(); }
  keys() { return this.map.keys(); }
  get size() { return this.map.size; }
}

// Caps tuned to: ~24 baked masks (rotation states) per session, ~32 knocked
// PNGs (drops), ~64 alpha-bounds reads. Exceed → oldest is evicted.
const MASK_CACHE = new LRU(24);   // key: `${url}|${deg}|${cropKey}` → data URL
const KNOCK_CACHE = new LRU(32);  // key: url → data URL
const ALPHA_BOUNDS_CACHE = new LRU(64); // key: `${url}|${threshold}` → { x, y, w, h }
const PARALLAX_HANDLERS = new WeakMap(); // element → handler

// ─── Utilities ──────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k.startsWith('data-') || k === 'role' || k === 'aria-label' || k === 'href' || k === 'target') {
      node.setAttribute(k, v);
    } else {
      node[k] = v;
    }
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Allow only <span class="red">…</span> through. Everything else is escaped.
function sanitizeInline(html) {
  if (!html) return '';
  // Tokenise on the allowed span tags first.
  const parts = String(html).split(/(<span class=["']red["']>|<\/span>)/gi);
  let out = '';
  let depth = 0;
  for (const p of parts) {
    if (/^<span class=["']red["']>$/i.test(p)) { out += '<span class="red">'; depth++; }
    else if (/^<\/span>$/i.test(p)) { if (depth > 0) { out += '</span>'; depth--; } }
    else { out += escapeHtml(p); }
  }
  while (depth-- > 0) out += '</span>';
  return out;
}

function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function paragraphsFrom(content) {
  if (!content) return [''];
  return String(content).split(/\n\n+/);
}

function tagInEditMode(node, element, mode) {
  if (mode === 'edit') {
    node.setAttribute('data-element-id', element.id || '');
    node.setAttribute('data-element-type', element.type || '');
    node.classList.add('rkk-editable');
  }
}

// ─── bakeAlphaMask ─────────────────────────────────────────────────
// Loads an image, optionally crops, then draws rotated into a canvas
// sized to the rotated bbox of the (cropped) image. Cached by (url, deg, crop).
// crop is { left, top, right, bottom } in % of source image, or null.
export async function bakeAlphaMask(imageUrl, rotationDeg = 0, crop = null) {
  const deg = Math.round(Number(rotationDeg) || 0);
  const c = normalizeCrop(crop);
  const cropKey = c ? `${c.left},${c.top},${c.right},${c.bottom}` : '0';
  const key = `${imageUrl}|${deg}|${cropKey}`;
  if (MASK_CACHE.has(key)) return MASK_CACHE.get(key);
  if (deg === 0 && !c) { MASK_CACHE.set(key, imageUrl); return imageUrl; }

  const img = await loadImage(imageUrl);
  const sw = img.naturalWidth, sh = img.naturalHeight;

  // Step 1: crop source onto an intermediate canvas (if crop is active).
  let src = img, cw = sw, ch = sh;
  if (c) {
    const sx = Math.round(sw * (c.left / 100));
    const sy = Math.round(sh * (c.top / 100));
    cw = Math.max(1, Math.round(sw * (1 - (c.left + c.right) / 100)));
    ch = Math.max(1, Math.round(sh * (1 - (c.top + c.bottom) / 100)));
    const cc = document.createElement('canvas');
    cc.width = cw; cc.height = ch;
    cc.getContext('2d').drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
    src = cc;
  }

  // Step 2: rotate (or just emit cropped) onto output canvas.
  if (deg === 0) {
    const url = src.toDataURL('image/png');
    MASK_CACHE.set(key, url);
    return url;
  }
  const rad = deg * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const W = Math.ceil(cw * cos + ch * sin);
  const H = Math.ceil(cw * sin + ch * cos);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.translate(W / 2, H / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -cw / 2, -ch / 2);
  const url = cv.toDataURL('image/png');
  MASK_CACHE.set(key, url);
  return url;
}

// ─── getAlphaBounds ────────────────────────────────────────────────
// Returns the alpha-tight bbox of an image as PERCENT of natural size.
// Falls back to full rect on CORS-taint, load failure, or fully-opaque image.
// Cached by (url, threshold).
export async function getAlphaBounds(imageUrl, threshold = 0.1) {
  const FULL = { x: 0, y: 0, w: 100, h: 100 };
  if (!imageUrl) return FULL;
  const t = Number(threshold);
  const key = `${imageUrl}|${t}`;
  if (ALPHA_BOUNDS_CACHE.has(key)) return ALPHA_BOUNDS_CACHE.get(key);
  const cache = (v) => { ALPHA_BOUNDS_CACHE.set(key, v); return v; };

  let img;
  try { img = await loadImage(imageUrl); }
  catch (err) { console.warn('getAlphaBounds: load failed, returning full rect', err); return cache(FULL); }
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) return cache(FULL);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  let data;
  try { data = ctx.getImageData(0, 0, W, H); }
  catch (err) { console.warn('getAlphaBounds: CORS-tainted, returning full rect', err); return cache(FULL); }

  const px = data.data;
  const cutoff = Math.max(0, Math.min(255, Math.round(t * 255)));
  let minX = W, minY = H, maxX = -1, maxY = -1, hasAlpha = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = px[(y * W + x) * 4 + 3];
      if (a < 255) hasAlpha = true;
      if (a > cutoff) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
  }
  if (!hasAlpha || maxX < 0) return cache(FULL);
  return cache({
    x: (minX / W) * 100, y: (minY / H) * 100,
    w: ((maxX - minX) / W) * 100, h: ((maxY - minY) / H) * 100,
  });
}

// Normalize a crop object to { left, top, right, bottom } numbers.
// Accepts null, undefined, or a partial object. Returns null if all zero/missing.
function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const left = Number(crop.left) || 0;
  const top = Number(crop.top) || 0;
  const right = Number(crop.right) || 0;
  const bottom = Number(crop.bottom) || 0;
  if (!left && !top && !right && !bottom) return null;
  return { left, top, right, bottom };
}

// ─── knockBackground ──────────────────────────────────────────────
// Sample 4 corners → median bg color → ramp alpha across distance 35→75
// → crop to opaque bbox + 8px padding → resize longest side ≤ 1400px.
// Short-circuits if corner pixels are already transparent.
export async function knockBackground(imageUrl) {
  if (KNOCK_CACHE.has(imageUrl)) return KNOCK_CACHE.get(imageUrl);
  const img = await loadImage(imageUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  let data;
  try { data = ctx.getImageData(0, 0, w, h); }
  catch (err) {
    console.warn('knockBackground: cross-origin image, returning original', err);
    KNOCK_CACHE.set(imageUrl, imageUrl); return imageUrl;
  }
  const px = data.data;

  // Already transparent? Short-circuit.
  const corners = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]
  ];
  const cornerSamples = corners.map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [px[i], px[i + 1], px[i + 2], px[i + 3]];
  });
  if (cornerSamples.every(c => c[3] < 16)) {
    KNOCK_CACHE.set(imageUrl, imageUrl); return imageUrl;
  }

  // Median per channel of corner pixels.
  const med = [0, 1, 2].map(ch => {
    const sorted = cornerSamples.map(c => c[ch]).sort((a, b) => a - b);
    return (sorted[1] + sorted[2]) / 2;
  });
  const [br, bg, bb] = med;

  const RAMP_LO = 35, RAMP_HI = 75;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = px[i] - br, dg = px[i + 1] - bg, db = px[i + 2] - bb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      let a;
      if (dist <= RAMP_LO) a = 0;
      else if (dist >= RAMP_HI) a = 255;
      else a = Math.round(255 * (dist - RAMP_LO) / (RAMP_HI - RAMP_LO));
      // Combine with original alpha (premultiply downward).
      const origA = px[i + 3];
      a = Math.min(a, origA);
      px[i + 3] = a;
      if (a > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  ctx.putImageData(data, 0, 0);

  if (maxX < 0) { // entirely transparent
    KNOCK_CACHE.set(imageUrl, imageUrl); return imageUrl;
  }

  // Crop with 8px padding.
  const pad = 8;
  const cx = Math.max(0, minX - pad);
  const cy = Math.max(0, minY - pad);
  const cw = Math.min(w, maxX + pad + 1) - cx;
  const ch = Math.min(h, maxY + pad + 1) - cy;

  // Resize so longest side ≤ 1400.
  const MAX = 1400;
  const longest = Math.max(cw, ch);
  const scale = longest > MAX ? MAX / longest : 1;
  const outW = Math.round(cw * scale);
  const outH = Math.round(ch * scale);

  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cv, cx, cy, cw, ch, 0, 0, outW, outH);
  const url = out.toDataURL('image/png');
  KNOCK_CACHE.set(imageUrl, url);
  return url;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Image load failed: ' + src));
    img.src = src;
  });
}

export function clearCache(imageUrl) {
  if (!imageUrl) {
    MASK_CACHE.clear();
    KNOCK_CACHE.clear();
    ALPHA_BOUNDS_CACHE.clear();
    return;
  }
  KNOCK_CACHE.delete(imageUrl);
  for (const k of Array.from(MASK_CACHE.keys())) {
    if (k.startsWith(imageUrl + '|')) MASK_CACHE.delete(k);
  }
  for (const k of Array.from(ALPHA_BOUNDS_CACHE.keys())) {
    if (k.startsWith(imageUrl + '|')) ALPHA_BOUNDS_CACHE.delete(k);
  }
}

// ─── Page scaffolding ─────────────────────────────────────────────

function buildTape(pageData) {
  const drop = pageData.dropNumber || '00';
  const section = pageData.section || '';
  const title = (pageData.title || '').toUpperCase();
  const phrase = `NO. ${drop}${section ? ' · ' + section : ''}${title ? ' · ' + title : ''}`;
  const fill = (phrase + ' · ').repeat(6);

  return el('div', { class: 'rkk-tape' },
    el('span', { class: 'rkk-tape-mark' }, 'RKK · STUDIO'),
    el('div', { class: 'rkk-tape-marquee' },
      el('span', {}, fill)
    ),
    el('span', { class: 'rkk-tape-year' }, String(new Date().getFullYear()))
  );
}

function fmtAccession(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `A. ${y}.${m}.${day}`;
  } catch { return ''; }
}

function buildMasthead(pageData) {
  return el('header', { class: 'rkk-masthead' },
    el('div', { class: 'rkk-masthead-left' }, 'RKK · The Studio Broadsheet'),
    el('div', { class: 'rkk-masthead-center' }, `FOLIO No. ${pageData.dropNumber || '00'}`),
    el('div', { class: 'rkk-masthead-right' }, fmtAccession(pageData.updatedAt) || fmtAccession(pageData.createdAt))
  );
}

function buildColophon(pageData) {
  return el('footer', { class: 'rkk-colophon' },
    el('div', { class: 'rkk-colophon-left' }, 'RKK Studio · Bengaluru / New York'),
    el('div', { class: 'rkk-seal' }, el('span', {}, 'RKK')),
    el('div', { class: 'rkk-colophon-right' }, 'Set in Instrument Serif, Fraunces & JetBrains Mono')
  );
}

// ─── Element renderers ────────────────────────────────────────────

function renderText(elementData, mode) {
  const s = elementData.style || {};
  const family = s.family === 'serif' ? 'var(--serif)'
              : s.family === 'mono' ? 'var(--mono)'
              : 'var(--display)';
  const node = el('div', { class: 'rkk-text' });
  if (s.dropCap) node.classList.add('rkk-dropcap');
  node.style.fontFamily = family;
  if (s.size != null) node.style.fontSize = `clamp(1rem, ${s.size}vw, ${s.size * 1.15}rem)`;
  if (s.weight != null) node.style.fontWeight = String(s.weight);
  if (s.leading != null) node.style.lineHeight = String(s.leading);
  if (s.align) node.style.textAlign = s.align;
  if (s.italic) node.style.fontStyle = 'italic';
  if (s.transform === 'uppercase') {
    node.style.textTransform = 'uppercase';
    node.style.letterSpacing = '0.18em';
  }

  // v2: text mode (flow | decorative). Default flow.
  const textMode = elementData.mode === 'decorative' ? 'decorative' : 'flow';
  const rot = Number(elementData.rotation) || 0;

  if (textMode === 'decorative') {
    node.classList.add('rkk-text-deco');
    node.style.position = 'absolute';
    if (elementData.x != null) node.style.left = `${elementData.x}%`;
    if (elementData.y != null) node.style.top = `${elementData.y}%`;
    if (elementData.w != null) node.style.width = `${elementData.w}%`;
    node.style.transform = `rotate(${rot}deg)`;
    node.style.transformOrigin = 'top left';
  } else {
    // Flow mode. Width as percentage of canvas (acts as max-width).
    if (elementData.w != null) {
      node.style.width = `${elementData.w}%`;
      node.style.maxWidth = `${elementData.w}%`;
    }
    if (rot) node.style.transform = `rotate(${rot}deg)`;
    // pageAnchor: only honored in flow mode. Default "none".
    const anchor = elementData.pageAnchor;
    if (anchor === 'left') node.classList.add('rkk-anchor-left');
    else if (anchor === 'center') node.classList.add('rkk-anchor-center');
    else if (anchor === 'right') node.classList.add('rkk-anchor-right');
  }

  // contenteditable in edit mode (caller may further configure).
  if (mode === 'edit') node.setAttribute('contenteditable', 'true');

  // Render paragraphs as direct children of the same block so floats wrap.
  const paras = paragraphsFrom(elementData.content);
  for (let i = 0; i < paras.length; i++) {
    const p = el('p', { class: 'rkk-p' });
    p.innerHTML = sanitizeInline(paras[i]);
    p.dataset.paraIndex = String(i);
    node.appendChild(p);
  }
  return node;
}

async function renderImageInline(elementData, mode) {
  const fig = el('figure', { class: 'rkk-image-inline rkk-float' });
  const side = elementData.side === 'left' ? 'left' : 'right';
  fig.style.float = side;
  fig.style.width = `${elementData.width != null ? elementData.width : 38}%`;
  if (elementData.specimen) fig.classList.add('rkk-specimen');

  const rot = Number(elementData.rotation) || 0;
  const crop = normalizeCrop(elementData.crop);
  const src = elementData.src;
  let cutSrc = elementData.cutSrc || elementData.src;
  let visualSrc = src;

  // v2: re-bake the alpha mask when EITHER rotation OR crop is non-zero so
  // the shape-outside silhouette matches the visible (cropped, rotated) image.
  if ((rot !== 0 || crop) && cutSrc) {
    try {
      const baked = await bakeAlphaMask(cutSrc, rot, crop);
      cutSrc = baked;
      // Use the baked image as the visual too so wrap and visual stay aligned.
      visualSrc = baked;
    } catch (e) {
      console.warn('bakeAlphaMask failed, falling back', e);
    }
  }

  const margin = elementData.shapeMargin != null ? elementData.shapeMargin : 18;
  const threshold = elementData.shapeThreshold != null ? elementData.shapeThreshold : 0.35;
  fig.style.shapeOutside = `url("${cutSrc}")`;
  fig.style.shapeMargin = `${margin}px`;
  fig.style.shapeImageThreshold = String(threshold);

  // Side-aware breathing room.
  if (side === 'right') fig.style.margin = `0.6rem -2vw 1.2rem 1.4rem`;
  else fig.style.margin = `0.6rem 1.4rem 1.2rem -2vw`;

  const img = el('img', { src: visualSrc, alt: elementData.alt || '' });
  // When we baked the visual, the crop is already applied to the pixel data,
  // so we should NOT also apply clip-path. Only apply clip-path when we did
  // not bake (crop active but baking failed, or the bake codepath was skipped).
  if (crop && visualSrc === src) {
    img.classList.add('rkk-cropped');
    img.style.clipPath = `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`;
  }
  fig.appendChild(img);

  // v2: caption inside figure, below image. Does not affect float bbox
  // since shape-outside reads from `fig` and only the image fills the figure.
  appendCaption(fig, elementData, mode);
  return fig;
}

function renderImageDecorative(elementData, mode) {
  const crop = normalizeCrop(elementData.crop);
  const hasCaption = !!(elementData.caption && elementData.caption.content != null);
  const rot = Number(elementData.rotation) || 0;

  const img = el('img', { class: 'rkk-image-deco rkk-deco', src: elementData.src, alt: elementData.alt || '' });
  if (crop) {
    img.classList.add('rkk-cropped');
    img.style.clipPath = `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`;
  }
  const motion = elementData.idleMotion;
  if (motion && motion !== 'none') {
    img.classList.add(`rkk-motion-${motion}`);
    if (motion === 'parallax-mouse') attachParallax(img);
  }
  if (elementData.draggableAtRuntime && mode === 'view') attachRuntimeDrag(img);

  // Place the positioning style on the OUTER node (img alone in v1, figure in v2).
  const outer = hasCaption ? el('figure', { class: 'rkk-image-deco-fig' }) : img;
  outer.style.position = 'absolute';
  if (elementData.x != null) outer.style.left = `${elementData.x}%`;
  if (elementData.y != null) outer.style.top = `${elementData.y}%`;
  if (elementData.w != null) outer.style.width = `${elementData.w}%`;
  outer.style.transform = `rotate(${rot}deg)`;
  if (elementData.opacity != null) outer.style.opacity = String(elementData.opacity);

  if (!hasCaption) return img;
  // v2: caption present. Image fills the figure width.
  outer.style.transformOrigin = 'top left';
  img.style.width = '100%';
  img.style.display = 'block';
  outer.appendChild(img);
  appendCaption(outer, elementData, mode);
  return outer;
}

// ─── Caption helper ───────────────────────────────────────────────
// Appends a <figcaption class="rkk-caption"> to the given figure when
// elementData.caption is set. Editable in edit mode. Per-instance style
// overrides come from caption.style and are applied as inline styles so
// they win over render.css defaults.
function appendCaption(fig, elementData, mode) {
  const cap = elementData.caption;
  if (!cap || cap.content == null) return;
  const node = el('figcaption', { class: 'rkk-caption' });
  if (elementData.id) node.setAttribute('data-element-id', `${elementData.id}-caption`);
  const cs = cap.style || {};
  if (cs.family === 'serif') node.style.fontFamily = 'var(--serif)';
  else if (cs.family === 'display') node.style.fontFamily = 'var(--display)';
  else if (cs.family === 'mono') node.style.fontFamily = 'var(--mono)';
  if (cs.size != null) node.style.fontSize = `clamp(0.7rem, ${cs.size}vw, ${cs.size * 1.4}rem)`;
  if (cs.transform === 'uppercase') {
    node.style.textTransform = 'uppercase';
  } else if (cs.transform === 'none') {
    node.style.textTransform = 'none';
    node.style.letterSpacing = 'normal';
  }
  if (cs.align) node.style.textAlign = cs.align;
  node.innerHTML = sanitizeInline(String(cap.content));
  if (mode === 'edit') node.setAttribute('contenteditable', 'true');
  fig.appendChild(node);
}

function attachRuntimeDrag(node) {
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  node.style.touchAction = 'none';
  node.addEventListener('pointerdown', (e) => {
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const m = node.style.transform.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
    ox = m ? parseFloat(m[1]) : 0;
    oy = m ? parseFloat(m[2]) : 0;
    node.setPointerCapture(e.pointerId);
    node.classList.add('rkk-dragging');
  });
  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    const rot = node.dataset.rotation || extractRot(node.style.transform);
    node.style.transform = `translate(${ox + dx}px, ${oy + dy}px) rotate(${rot}deg)`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('rkk-dragging');
    try { node.releasePointerCapture(e.pointerId); } catch {}
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
}

function extractRot(t) {
  const m = t.match(/rotate\(([-\d.]+)deg\)/);
  return m ? m[1] : '0';
}

function attachParallax(node) {
  if (PARALLAX_HANDLERS.has(node)) return;
  const handler = (e) => {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = (e.clientX - cx) / cx;
    const dy = (e.clientY - cy) / cy;
    const rot = extractRot(node.style.transform);
    node.style.transform = `translate(${dx * 18}px, ${dy * 18}px) rotate(${rot}deg)`;
  };
  window.addEventListener('mousemove', handler, { passive: true });
  PARALLAX_HANDLERS.set(node, handler);
}

function renderMarquee(elementData, mode) {
  const wrap = el('div', { class: 'rkk-marquee' });
  wrap.dataset.background = elementData.background || 'ink';
  wrap.dataset.color = elementData.color || 'paper';
  const speed = Number(elementData.speed) || 38;
  const dir = elementData.direction === 'right' ? 'right' : 'left';
  const track = el('div', { class: 'rkk-marquee-track' });
  track.style.animationDuration = `${speed}s`;
  if (dir === 'right') track.style.animationDirection = 'reverse';
  const content = (elementData.content || '') + ' ';
  const inner = el('span', {}, (content + content).repeat(2));
  track.appendChild(inner);
  wrap.appendChild(track);
  return wrap;
}

function renderHero(elementData, mode) {
  const w = elementData.w != null ? elementData.w : 60;
  const fig = el('figure', { class: 'rkk-hero' });
  fig.style.width = `${w}%`;
  if (elementData.specimen) fig.classList.add('rkk-specimen');
  const motion = elementData.idleMotion;
  if (motion && motion !== 'none') {
    fig.classList.add(`rkk-motion-${motion}`);
    if (motion === 'parallax-mouse') attachParallax(fig);
  }

  const crop = normalizeCrop(elementData.crop);
  const altText = typeof elementData.caption === 'string'
    ? elementData.caption
    : (elementData.caption && elementData.caption.content) || '';
  const img = el('img', { src: elementData.src, alt: altText });
  if (crop) {
    img.classList.add('rkk-cropped');
    img.style.clipPath = `inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%)`;
  }
  fig.appendChild(img);

  // Caption: v1 supported a plain string. v2 supports a {content, style} object.
  if (typeof elementData.caption === 'string' && elementData.caption) {
    fig.appendChild(el('figcaption', { class: 'rkk-hero-caption' }, elementData.caption));
  } else if (elementData.caption && typeof elementData.caption === 'object' && elementData.caption.content != null) {
    appendCaption(fig, elementData, mode);
  }
  return fig;
}

function renderSpec(elementData, mode) {
  const wrap = el('div', { class: 'rkk-spec' });
  const rows = Array.isArray(elementData.rows) ? elementData.rows : [];
  for (const row of rows) {
    wrap.appendChild(el('div', { class: 'rkk-spec-label' }, String(row.label || '')));
    wrap.appendChild(el('div', { class: 'rkk-spec-value' }, String(row.value || '')));
  }
  return wrap;
}

function renderField(elementData, mode) {
  const form = el('form', { class: 'rkk-field' });
  form.setAttribute('autocomplete', 'off');
  const input = el('input', { type: 'text', class: 'rkk-field-input', placeholder: elementData.placeholder || '' });
  const button = el('button', { type: 'submit', class: 'rkk-field-button' }, elementData.buttonLabel || 'SUBMIT');
  form.appendChild(input);
  form.appendChild(button);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (mode === 'edit') return;
    const action = elementData.action || {};
    const value = input.value.trim();
    if (action.type === 'mailto') {
      const to = action.to || '';
      const subject = encodeURIComponent(action.subject || 'Studio dispatch');
      const body = encodeURIComponent(value);
      window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
    } else if (action.type === 'external') {
      const url = action.url || value;
      if (url) window.open(url, '_blank', 'noopener');
    } else if (action.type === 'copy') {
      const v = action.value || value;
      navigator.clipboard?.writeText(v).then(() => showToast(form, 'Copied.'));
    }
  });
  return form;
}

function showToast(parent, msg) {
  const toast = el('div', { class: 'rkk-toast' }, msg);
  parent.appendChild(toast);
  setTimeout(() => toast.classList.add('rkk-toast-show'), 10);
  setTimeout(() => { toast.classList.remove('rkk-toast-show'); setTimeout(() => toast.remove(), 400); }, 1800);
}

function renderAsterism() {
  return el('div', { class: 'rkk-asterism' }, '·   ·   ·');
}

// ─── Element dispatcher ───────────────────────────────────────────

async function buildElement(elementData, mode) {
  let node;
  switch (elementData.type) {
    case 'text': node = renderText(elementData, mode); break;
    case 'image-inline': node = await renderImageInline(elementData, mode); break;
    case 'image-decorative': node = renderImageDecorative(elementData, mode); break;
    case 'marquee': node = renderMarquee(elementData, mode); break;
    case 'hero-artifact': node = renderHero(elementData, mode); break;
    case 'spec-sheet': node = renderSpec(elementData, mode); break;
    case 'single-field': node = renderField(elementData, mode); break;
    case 'asterism': node = renderAsterism(); break;
    default:
      console.warn('Unknown element type:', elementData.type);
      node = el('div', { class: 'rkk-unknown' }, `[unknown: ${elementData.type}]`);
  }
  if (elementData.z != null) node.style.zIndex = String(elementData.z);
  if (elementData.hidden) node.style.display = 'none';
  tagInEditMode(node, elementData, mode);
  return node;
}

// Public: render or re-render one element in place.
export async function renderElement(elementData, parent, mode = 'view', options = {}) {
  const node = await buildElement(elementData, mode);
  // Replace existing node with same id, if present.
  const existing = parent.querySelector(`[data-element-id="${CSS.escape(elementData.id || '')}"]`);
  if (existing && existing.parentNode === parent) parent.replaceChild(node, existing);
  else parent.appendChild(node);
  if (typeof options.onElementClick === 'function') {
    node.addEventListener('click', (e) => options.onElementClick(elementData, e));
  }
  return node;
}

// ─── Page render ──────────────────────────────────────────────────

export async function renderPage(pageData, container, mode = 'view', options = {}) {
  if (!container) throw new Error('renderPage: container is required');
  clearChildren(container);

  const page = el('div', { class: 'rkk-page' });
  page.dataset.bg = pageData.canvas?.background || 'paper';
  page.dataset.cursor = pageData.cursor || 'default';
  page.dataset.signature = pageData.signature || 'none';
  page.dataset.mode = mode;

  page.appendChild(buildTape(pageData));
  page.appendChild(buildMasthead(pageData));

  const canvas = el('main', { class: 'rkk-canvas' });
  const maxW = pageData.canvas?.maxWidth || 1480;
  const minH = pageData.canvas?.minHeight;
  canvas.style.setProperty('--max', `${maxW}px`);
  if (minH) canvas.style.minHeight = `${minH}vh`;

  // Sort elements by z (stable for ties).
  const elements = Array.isArray(pageData.elements) ? pageData.elements.slice() : [];
  elements.forEach((e, i) => { e.__order = i; });
  elements.sort((a, b) => {
    const za = a.z == null ? 0 : a.z;
    const zb = b.z == null ? 0 : b.z;
    if (za !== zb) return za - zb;
    return a.__order - b.__order;
  });

  // Build all elements first.
  const built = [];
  for (const e of elements) {
    if (e.hidden && mode === 'view') continue;
    const node = await buildElement(e, mode);
    if (typeof options.onElementClick === 'function') {
      node.addEventListener('click', (ev) => options.onElementClick(e, ev));
    }
    built.push({ data: e, node });
  }

  // Two-pass: place text/marquee/hero/spec/field/asterism in flow.
  // image-decorative are absolute → appended at end into canvas.
  // image-inline are floats → inserted into the nearest preceding text element
  // before paragraph N+1.
  // v2: text elements with mode === 'decorative' are also absolute → join the decoratives bucket.
  const flowNodes = []; // text(flow)/marquee/hero/spec/field/asterism
  const inlineImages = [];
  const decoratives = [];

  for (const item of built) {
    const t = item.data.type;
    if (t === 'image-inline') inlineImages.push(item);
    else if (t === 'image-decorative') decoratives.push(item);
    else if (t === 'text' && item.data.mode === 'decorative') decoratives.push(item);
    else flowNodes.push(item);
  }

  // First, place flow nodes in order.
  for (const item of flowNodes) canvas.appendChild(item.node);

  // Now, attach inline images. For each inline image, find the nearest
  // preceding text element in the flow order, then insert the figure as
  // the first child of paragraph N+1, OR before the text element if N === 0.
  for (const item of inlineImages) {
    const data = item.data;
    const anchorAfter = data.anchor?.afterParagraph;
    // Find nearest preceding text element in built order.
    // Skip decorative-mode text blocks since they are not in the doc flow.
    let anchorText = null;
    const myIdx = built.indexOf(item);
    for (let i = myIdx - 1; i >= 0; i--) {
      const d = built[i].data;
      if (d.type === 'text' && d.mode !== 'decorative') { anchorText = built[i]; break; }
    }
    if (!anchorText) {
      // No preceding text → attach to canvas directly so it floats in canvas.
      canvas.insertBefore(item.node, canvas.firstChild);
      continue;
    }
    const textNode = anchorText.node;
    const paras = textNode.querySelectorAll(':scope > .rkk-p');
    const after = anchorAfter == null ? 0 : Math.max(0, anchorAfter);
    if (after === 0) {
      // Spec: insert before the text element entirely so the float clears
      // upward and wrap propagates from the very first paragraph.
      // Text element MUST be a single block so floats inside its previous
      // sibling continue to wrap subsequent paragraphs as well.
      textNode.parentNode.insertBefore(item.node, textNode);
    } else if (paras.length === 0) {
      textNode.insertBefore(item.node, textNode.firstChild);
    } else {
      // afterParagraph: N → insert into paragraph N+1 (zero-indexed: paras[N]).
      const targetIdx = Math.min(after, paras.length - 1);
      const target = paras[targetIdx];
      target.insertBefore(item.node, target.firstChild);
    }
  }

  // Decoratives append last (absolute, won't affect flow).
  // Canvas needs position:relative for absolute children, set in CSS.
  for (const item of decoratives) canvas.appendChild(item.node);

  page.appendChild(canvas);
  page.appendChild(buildColophon(pageData));

  applySignature(page);

  container.appendChild(page);
  return page;
}

function applySignature(page) {
  const sig = page.dataset.signature;
  if (sig === 'draggable-stickers') {
    page.querySelectorAll('.rkk-sticker').forEach(attachRuntimeDrag);
  } else if (sig === 'paint-trail') {
    console.log('[rkk] signature=paint-trail would load /draw.js (v1 stub)');
  }
}

// ─── bootPage convenience ─────────────────────────────────────────

export async function bootPage(slug, container = document.getElementById('page')) {
  if (!container) throw new Error('bootPage: container element not found');
  const url = `/pages/${slug}/page.json`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`bootPage: failed to load ${url} (${res.status})`);
  const data = await res.json();
  return renderPage(data, container, 'view');
}
