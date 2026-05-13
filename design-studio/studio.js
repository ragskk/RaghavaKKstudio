// ───────────────────────────────────────────────────────────────────
// Design Studio · Editor · v2
// In-browser composer for Raghava KK's website.
// (Distinct from the public "Raghava KK Studio" brand / studio2.html.)
// Composes pages on top of the shared renderer. Writes via FSA.
// v2 adds: multi-file drop, image bank, crop tool, tight bbox,
// free text, page anchor, captions, split block, section library.
// ───────────────────────────────────────────────────────────────────

import { renderPage, bakeAlphaMask, knockBackground, getAlphaBounds, clearCache } from '../render/render.js';
import { SECTIONS } from './sections.js';

// ─── State ─────────────────────────────────────────────────────────

const state = {
  rootHandle: null,            // FileSystemDirectoryHandle for project root
  pages: [],                    // [{ slug }]
  currentSlug: null,
  pageData: null,               // current page.json contents
  selectedId: null,             // primary selected element (for inspector etc.)
  selectedIds: [],              // full selection (multi-select). Includes selectedId.
  focusedSectionId: null,       // which section receives new elements / paste
  clipboard: null,              // in-memory paste buffer: { elements: [...] }
  selectedSectionId: null,      // section selected for inspector editing
  dragging: false,              // true during a drag/resize/rotate; lets refreshSelectionChrome skip expensive paths
  editingTextId: null,          // id of text element currently being edited
  history: [],                  // [pageData snapshots]
  historyIdx: -1,
  mode: 'edit',                 // 'edit' | 'view'
  saveState: 'idle',            // idle | dirty | saving | saved | error
  layersCollapsed: false,
  saveTimer: null,
  renderTimer: null,
  inspectorCommitTimer: null,
  bankObjectUrls: [],           // tracked URLs to revoke on rescan
  crop: null,                   // { id, entryCrop, currentCrop }
};

// ─── Section constants ─────────────────────────────────────────────

const SECTION_DEFAULT_HEIGHT = 80;   // vh
const SECTION_MIN_HEIGHT = 20;       // vh
const SECTION_MAX_HEIGHT = 300;      // vh
const SECTION_BG_OPTIONS = ['inherit', 'paper', 'ink', 'red', 'cream'];

const HISTORY_MAX = 50;
const RENDER_DEBOUNCE = 16;
const SAVE_DEBOUNCE = 2000;
const INSPECTOR_COMMIT_DEBOUNCE = 500;

// ─── Tiny IndexedDB wrapper for FSA handle ─────────────────────────

const IDB_NAME = 'rkk-studio';
const IDB_STORE = 'handles';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── DOM refs ──────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const els = {
  toolbar: $('toolbar'),
  pagePicker: $('page-picker'),
  btnNewPage: $('btn-new-page'),
  btnConnect: $('btn-connect'),
  addControls: $('add-controls'),
  btnUndo: $('btn-undo'),
  btnRedo: $('btn-redo'),
  btnSection: $('btn-section'),
  saveIndicator: $('save-indicator'),
  btnView: $('btn-view-toggle'),
  btnLayersToggle: $('btn-leftrail-toggle'),
  shell: document.querySelector('.studio-shell'),
  leftrail: $('leftrail'),
  layers: $('layers'),
  layersList: $('layers-list'),
  bank: $('bank'),
  bankGridPage: $('bank-grid-page'),
  bankGridStudio: $('bank-grid-studio'),
  btnBankRefreshPage: $('btn-bank-refresh-page'),
  btnBankRefreshStudio: $('btn-bank-refresh-studio'),
  stage: $('stage'),
  stageScroll: $('stage-scroll'),
  pageRoot: $('page-root'),
  overlay: $('overlay'),
  inspector: $('inspector'),
  inspectorTitle: $('inspector-title'),
  inspectorBody: $('inspector-body'),
  fileInput: $('file-input'),
  sectionPicker: $('section-picker'),
  sectionPickerGrid: $('section-picker-grid'),
  btnSectionPickerClose: $('btn-section-picker-close'),
};

// ─── Utilities ─────────────────────────────────────────────────────

const clone = (x) => JSON.parse(JSON.stringify(x));

function uid(prefix = 'el') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function setSaveState(s) {
  state.saveState = s;
  if (els.saveIndicator) {
    els.saveIndicator.dataset.state = s;
    els.saveIndicator.textContent = (
      s === 'idle'   ? 'IDLE'    :
      s === 'dirty'  ? 'UNSAVED' :
      s === 'saving' ? 'SAVING…' :
      s === 'saved'  ? 'SAVED'   :
      s === 'error'  ? 'ERROR'   : s.toUpperCase()
    );
  }
}

// ─── FSA helpers ───────────────────────────────────────────────────

async function ensurePermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

async function getOrCreateDir(parent, name) {
  return parent.getDirectoryHandle(name, { create: true });
}

async function writeFile(parent, name, contents) {
  const fh = await parent.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(contents);
  await w.close();
}

async function fileExists(parent, name) {
  try { await parent.getFileHandle(name); return true; }
  catch { return false; }
}

async function dirExists(parent, name) {
  try { await parent.getDirectoryHandle(name); return true; }
  catch { return false; }
}

async function readJsonFile(parent, name) {
  const fh = await parent.getFileHandle(name);
  const file = await fh.getFile();
  return JSON.parse(await file.text());
}

// ─── Project / pages enumeration ───────────────────────────────────

async function loadProject() {
  if (!state.rootHandle) return;
  if (!await ensurePermission(state.rootHandle)) {
    console.warn('Permission denied for stored handle');
    return;
  }
  const pages = [];
  try {
    const pagesDir = await state.rootHandle.getDirectoryHandle('pages', { create: true });
    for await (const entry of pagesDir.values()) {
      if (entry.kind === 'directory') pages.push({ slug: entry.name });
    }
  } catch (e) { console.warn('No /pages dir yet', e); }
  state.pages = pages.sort((a, b) => a.slug.localeCompare(b.slug));
  rebuildPagePicker();
  // Ensure assets/_bank exists for the studio bank.
  try {
    const assetsDir = await state.rootHandle.getDirectoryHandle('assets', { create: true });
    await assetsDir.getDirectoryHandle('_bank', { create: true });
  } catch (e) { console.warn('Could not create assets/_bank', e); }
}

function rebuildPagePicker() {
  const sel = els.pagePicker;
  sel.innerHTML = '';
  if (!state.pages.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— NO PAGES —';
    sel.appendChild(opt);
    return;
  }
  for (const p of state.pages) {
    const opt = document.createElement('option');
    opt.value = p.slug; opt.textContent = p.slug;
    if (p.slug === state.currentSlug) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadPage(slug) {
  if (!state.rootHandle) return;
  // Free renderer caches from the previous page (each rotated/cropped
  // mask is a multi-MB data URL; switching pages without clearing leaks
  // hundreds of MB per page change). Also revoke any bank object URLs.
  clearCache();
  revokeBankUrls();
  state.currentSlug = slug;
  state.selectedId = null;
  state.selectedIds = [];
  state.selectedSectionId = null;
  state.editingTextId = null;
  try {
    const pagesDir = await state.rootHandle.getDirectoryHandle('pages');
    const pageDir = await pagesDir.getDirectoryHandle(slug);
    const data = await readJsonFile(pageDir, 'page.json');
    state.pageData = data;
  } catch (e) {
    console.error('loadPage failed', slug, e);
    state.pageData = defaultPageData(slug);
  }
  migratePageData(state.pageData);
  state.focusedSectionId = state.pageData.sections[0].id;
  state.history = [clone(state.pageData)];
  state.historyIdx = 0;
  setSaveState('saved');
  await rerender();
  renderInspector();
  renderLayers();
  rebuildPagePicker();
  await refreshBank();
}

function defaultPageData(slug) {
  const firstSectionId = uid('sec');
  return {
    version: 2,
    slug,
    title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    dropNumber: '00',
    section: '',
    canvas: { background: 'paper', maxWidth: 1480 },
    cursor: 'default',
    signature: 'none',
    sections: [
      { id: firstSectionId, height: SECTION_DEFAULT_HEIGHT, bg: 'inherit' },
    ],
    elements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Mutate pageData in place so its sections + sectionId fields are valid.
// Idempotent. Called on every loadPage; the next save persists the migration.
//
// Legacy migration: pages saved before the section model had canvas.minHeight
// (in vh). To preserve the existing absolute positions of decoratives — whose
// `top: y%` was being computed against the canvas height — the default
// section adopts that same height. Any drift would only come from browsers
// disagreeing on % of a min-height-only container vs. a definite-height one.
function migratePageData(pd) {
  if (!pd) return pd;
  if (!Array.isArray(pd.sections) || pd.sections.length === 0) {
    const legacyHeight = Number(pd.canvas?.minHeight);
    const defH = Number.isFinite(legacyHeight) && legacyHeight > 0
      ? Math.max(SECTION_MIN_HEIGHT, Math.min(SECTION_MAX_HEIGHT, legacyHeight))
      : SECTION_DEFAULT_HEIGHT;
    // Legacy pages used min-height (flow content could push past it). Match
    // that here by disabling clip on the migrated default section so existing
    // flow content keeps rendering. New sections still default to clip=true.
    pd.sections = [{ id: uid('sec'), height: defH, bg: 'inherit', clip: false }];
  }
  // Validate / normalize each section.
  const seen = new Set();
  pd.sections = pd.sections.map((s, i) => {
    let id = s.id;
    if (!id || seen.has(id)) id = uid('sec');
    seen.add(id);
    return {
      id,
      height: Number.isFinite(s.height)
        ? Math.max(SECTION_MIN_HEIGHT, Math.min(SECTION_MAX_HEIGHT, s.height))
        : SECTION_DEFAULT_HEIGHT,
      clip: s.clip !== false,
      bg: s.bg || 'inherit',
      bgColor: s.bgColor || null,
      bgImage: s.bgImage || null,
      label: s.label || null,
    };
  });
  const firstId = pd.sections[0].id;
  const validIds = new Set(pd.sections.map(s => s.id));
  pd.elements = (pd.elements || []).map(e => {
    if (!e.sectionId || !validIds.has(e.sectionId)) {
      return Object.assign({}, e, { sectionId: firstId });
    }
    return e;
  });
  return pd;
}

// ─── Stub HTML generator ───────────────────────────────────────────

function publishedStub(slug) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${slug}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Instrument+Serif:ital@0;1&family=Space+Grotesk:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/render/render.css" />
</head>
<body><div id="page"></div>
<script type="module">import { bootPage } from '/render/render.js'; bootPage('${slug}');</script>
</body></html>`;
}

// ─── New page ──────────────────────────────────────────────────────

async function createNewPage() {
  if (!state.rootHandle) { alert('Connect a project folder first.'); return; }
  const raw = prompt('New page slug, lowercase with hyphens.', 'untitled-drop');
  if (!raw) return;
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return;
  const pagesDir = await state.rootHandle.getDirectoryHandle('pages', { create: true });
  const pageDir = await pagesDir.getDirectoryHandle(slug, { create: true });
  await getOrCreateDir(pageDir, 'assets');
  const data = defaultPageData(slug);
  await writeFile(pageDir, 'page.json', JSON.stringify(data, null, 2));
  // Stub at /<slug>.html if missing.
  if (!await fileExists(state.rootHandle, `${slug}.html`)) {
    await writeFile(state.rootHandle, `${slug}.html`, publishedStub(slug));
  }
  await loadProject();
  await loadPage(slug);
}

// ─── Save ──────────────────────────────────────────────────────────

function scheduleSave() {
  if (!state.currentSlug) return;
  setSaveState('dirty');
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE);
}
async function saveNow() {
  if (!state.currentSlug || !state.rootHandle || !state.pageData) return;
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  setSaveState('saving');
  try {
    state.pageData.updatedAt = new Date().toISOString();
    const pagesDir = await state.rootHandle.getDirectoryHandle('pages', { create: true });
    const pageDir = await pagesDir.getDirectoryHandle(state.currentSlug, { create: true });
    await writeFile(pageDir, 'page.json', JSON.stringify(state.pageData, null, 2));
    if (!await fileExists(state.rootHandle, `${state.currentSlug}.html`)) {
      await writeFile(state.rootHandle, `${state.currentSlug}.html`, publishedStub(state.currentSlug));
    }
    setSaveState('saved');
  } catch (e) {
    console.error('Save failed', e);
    setSaveState('error');
  }
}

// ─── History ───────────────────────────────────────────────────────

function commitHistory() {
  if (!state.pageData) return;
  // Truncate forward redo
  state.history = state.history.slice(0, state.historyIdx + 1);
  state.history.push(clone(state.pageData));
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.historyIdx = state.history.length - 1;
  scheduleSave();
}
function undo() {
  if (state.historyIdx <= 0) return;
  state.historyIdx--;
  state.pageData = clone(state.history[state.historyIdx]);
  scheduleSave();
  rerender(); renderInspector(); renderLayers();
}
function redo() {
  if (state.historyIdx >= state.history.length - 1) return;
  state.historyIdx++;
  state.pageData = clone(state.history[state.historyIdx]);
  scheduleSave();
  rerender(); renderInspector(); renderLayers();
}

// ─── Render orchestration ──────────────────────────────────────────

function scheduleRerender() {
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(rerender, RENDER_DEBOUNCE);
}

async function rerender() {
  if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
  if (!state.pageData) return;
  els.pageRoot.innerHTML = '';
  await renderPage(state.pageData, els.pageRoot, state.mode, {
    onElementClick: (data, ev) => {
      ev.stopPropagation();
      // Shift / Cmd / Meta extends the selection. Otherwise replace.
      const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
      selectElement(data.id, additive ? 'toggle' : 'replace');
    }
  });
  attachContenteditableHooks();
  await refreshSelectionChrome();
}

// Serialize a contenteditable text node back to its source format,
// stripping out anything the renderer planted inside it that does NOT
// belong in source content. Specifically: inline-image floats live as
// `<figure class="rkk-image-inline rkk-float">` children of paragraphs
// (so text wraps around them); they are SEPARATE elements in page.json,
// not part of the text content. If we naively grab innerHTML, those
// figures get baked into the text content, get re-rendered next pass,
// duplicate themselves, and quickly grow into a recursive base64 mess.
// This helper clones the node, removes those figures, then serializes.
function serializeTextContent(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  // Strip any planted floats (image-inline figures, paragraph guides,
  // editor chrome remnants).
  clone.querySelectorAll('.rkk-float, .rkk-image-inline, .studio-paragraph-guide, .rkk-image-deco-fig').forEach(n => n.remove());
  // Strip any data-element-id / data-hooked attrs from surviving nodes
  // so the source content stays clean and idempotent.
  clone.querySelectorAll('[data-element-id], [data-hooked], [contenteditable]').forEach(n => {
    n.removeAttribute('data-element-id');
    n.removeAttribute('data-element-type');
    n.removeAttribute('data-hooked');
    n.removeAttribute('contenteditable');
  });
  const paras = clone.querySelectorAll(':scope > .rkk-p');
  if (paras.length) {
    return Array.from(paras).map(p => p.innerHTML.trim()).filter(Boolean).join('\n\n');
  }
  return clone.innerHTML.trim();
}

// Hook focusin/focusout on text contenteditables and figcaptions so we
// can: (a) track which text element is being edited (for the Split UI),
// (b) write caption inline edits back to element.caption.content,
// (c) write text inline edits back to element.content.
//
// Convention (Figma/Keynote/PowerPoint/Adobe/Canva): single click on a
// text element selects it (handles + ring); double-click enters edit mode
// (caret in text). The renderer paints contenteditable=true on text and
// captions in edit mode; we OVERRIDE that here, defaulting everything to
// contenteditable=false. Edit mode is opt-in via dblclick → enterTextEditMode.
function attachContenteditableHooks() {
  if (state.mode !== 'edit') return;
  // Text blocks (the .rkk-text wrapper carries data-element-id).
  // Match regardless of the value the renderer set — we will override.
  const textNodes = els.pageRoot.querySelectorAll('.rkk-text[contenteditable]');
  textNodes.forEach(node => {
    const id = node.getAttribute('data-element-id');
    // Default to non-editable. Preserve edit state across rerenders so a
    // mid-typing rerender doesn't yank the user out.
    if (state.editingTextId === id) {
      node.contentEditable = 'true';
    } else {
      node.contentEditable = 'false';
    }
    if (node.dataset.hooked === '1') return; // double-attach guard
    node.dataset.hooked = '1';
    node.addEventListener('focusin', () => {
      // Only enter edit-tracking if we explicitly put the node into
      // edit mode (contentEditable=true). A focus event on a non-editable
      // node shouldn't flip us into edit tracking. (Keep the selection
      // call as a safety net — idempotent.)
      if (node.contentEditable === 'true') {
        state.editingTextId = id;
        if (state.selectedId !== id) selectElement(id);
        else renderInspector();
      }
    });
    node.addEventListener('focusout', () => {
      // Defer so a click on Split inside the inspector still fires.
      setTimeout(() => {
        if (state.editingTextId === id) {
          const elData = state.pageData?.elements?.find(x => x.id === id);
          if (elData) {
            const next = serializeTextContent(node);
            if (next !== elData.content) {
              elData.content = next;
              commitHistory();
            }
          }
          state.editingTextId = null;
          renderInspector();
        }
      }, 120);
    });
    // Double-click → enter edit mode at click point.
    node.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      enterTextEditMode(node, e.clientX, e.clientY);
    });
  });
  // Captions.
  const caps = els.pageRoot.querySelectorAll('figcaption.rkk-caption[contenteditable]');
  caps.forEach(node => {
    const fullId = node.getAttribute('data-element-id') || '';
    if (state.editingTextId === fullId) {
      node.contentEditable = 'true';
    } else {
      node.contentEditable = 'false';
    }
    if (node.dataset.hooked === '1') return;
    node.dataset.hooked = '1';
    node.addEventListener('focusout', () => {
      const id = fullId.replace(/-caption$/, '');
      const elData = state.pageData?.elements?.find(x => x.id === id);
      if (elData && elData.caption) {
        elData.caption.content = node.innerText.trim();
        commitHistory();
      }
    });
    node.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      enterTextEditMode(node, e.clientX, e.clientY);
    });
  });
}

// Enter inline edit mode for a text or caption node. Places the caret at
// (x, y) and ensures the parent element is selected so handles remain.
function enterTextEditMode(node, x, y) {
  if (!node) return;
  const fullId = node.getAttribute('data-element-id') || '';
  // Captions carry "<elementId>-caption" — strip suffix for selection.
  const isCaption = node.matches?.('figcaption.rkk-caption');
  const elementId = isCaption ? fullId.replace(/-caption$/, '') : fullId;
  if (!elementId) return;
  // Make sure the parent element is selected (handles will be visible).
  if (state.selectedId !== elementId) selectElement(elementId);
  // Flip to editable and track which node is editing.
  node.contentEditable = 'true';
  state.editingTextId = fullId; // bare id for text, "<id>-caption" for caption
  // Hide handles while editing (CSS toggles via .studio-editing).
  if (els.overlay) els.overlay.classList.add('studio-editing');
  // Floating formatting toolbar next to the sprite.
  showTextToolbar(node);
  // Focus and place caret at the click point.
  try {
    node.focus({ preventScroll: true });
    let range = null;
    if (typeof document.caretRangeFromPoint === 'function') {
      range = document.caretRangeFromPoint(x, y);
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range) {
      // Ensure the caret is inside the editable node.
      if (node.contains(range.startContainer)) {
        range.collapse(true);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      }
    }
  } catch (_) { /* swallow — focus alone is enough */ }
  renderInspector();
}

// Leave inline edit mode. The element remains selected with handles visible;
// the focusout writeback already wired in attachContenteditableHooks
// will commit any changes back to JSON.
function exitTextEditMode() {
  const fullId = state.editingTextId;
  if (!fullId) return;
  // Find the editing node — text blocks use the bare id, captions use the
  // "-caption" suffix; both selectors are routed through findRenderedNode
  // (which queries by data-element-id directly).
  const node = els.pageRoot.querySelector(`[data-element-id="${CSS.escape(fullId)}"]`);
  // Do the writeback INLINE (not deferred via focusout) so we can clear
  // state.editingTextId synchronously — without that, a quick second
  // click-outside would re-enter this function instead of falling through
  // to deselect. The focusout listener's deferred check keys off
  // editingTextId === id, so once we clear it the deferred handler is a
  // no-op for this exit path.
  if (node) {
    const isCaption = node.matches?.('figcaption.rkk-caption');
    if (isCaption) {
      const id = fullId.replace(/-caption$/, '');
      const elData = state.pageData?.elements?.find(x => x.id === id);
      if (elData && elData.caption) {
        const next = node.innerText.trim();
        if (next !== elData.caption.content) {
          elData.caption.content = next;
          commitHistory();
        }
      }
    } else {
      const elData = state.pageData?.elements?.find(x => x.id === fullId);
      if (elData) {
        const next = serializeTextContent(node);
        if (next !== elData.content) {
          elData.content = next;
          commitHistory();
        }
      }
    }
    if (document.activeElement === node) node.blur();
    node.contentEditable = 'false';
  }
  state.editingTextId = null;
  if (els.overlay) els.overlay.classList.remove('studio-editing');
  hideTextToolbar();
  refreshSelectionChrome();
  renderInspector();
}

// ─── Floating text-editing toolbar ─────────────────────────────────
//
// Shown next to a text element while it's in contenteditable mode.
// Buttons apply formatting to the current Selection within the element.
// We use a custom wrapSelection helper rather than execCommand for color
// so the markup matches the brand convention (<span class="red">…</span>)
// instead of inline style attributes.

function showTextToolbar(node) {
  hideTextToolbar();
  if (!node) return;
  const r = node.getBoundingClientRect();
  const bar = document.createElement('div');
  bar.id = 'studio-text-toolbar';
  bar.className = 'studio-text-toolbar';
  // Anchor to the right of the sprite if there's room, else above.
  const viewportW = window.innerWidth;
  const preferRight = r.right + 200 < viewportW - 16;
  if (preferRight) {
    bar.style.left = `${r.right + 10}px`;
    bar.style.top  = `${Math.max(8, r.top)}px`;
  } else {
    bar.style.left = `${Math.max(8, r.left)}px`;
    bar.style.top  = `${Math.max(8, r.top - 44)}px`;
  }

  // mousedown preventDefault keeps the contenteditable focused — without
  // this, clicking a button blurs the text and the selection is lost
  // before our handler can read it.
  function makeButton(label, title, onActivate, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'studio-text-tb-btn' + (opts.extraClass ? ' ' + opts.extraClass : '');
    b.title = title;
    b.textContent = label;
    if (opts.color) b.style.color = opts.color;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onActivate();
      // Re-focus the editing node so subsequent typing goes there.
      const editingNode = state.editingTextId
        ? els.pageRoot.querySelector(`[data-element-id="${CSS.escape(state.editingTextId)}"]`)
        : null;
      editingNode?.focus?.({ preventScroll: true });
    });
    return b;
  }

  bar.appendChild(makeButton('B', 'Bold', () => execFormatCommand('bold'), { extraClass: 'is-bold' }));
  bar.appendChild(makeButton('I', 'Italic', () => execFormatCommand('italic'), { extraClass: 'is-italic' }));
  bar.appendChild(makeButton('U', 'Underline', () => execFormatCommand('underline'), { extraClass: 'is-under' }));

  const sep = document.createElement('span'); sep.className = 'studio-text-tb-sep'; bar.appendChild(sep);

  bar.appendChild(makeButton('●', 'Red',   () => wrapSelectionWith('span', { class: 'red' }), { color: 'var(--red)' }));
  bar.appendChild(makeButton('●', 'Ink',   () => wrapSelectionWith('span', { style: 'color: var(--ink)' }), { color: 'var(--ink)' }));
  bar.appendChild(makeButton('●', 'Paper', () => wrapSelectionWith('span', { style: 'color: var(--paper); background: var(--ink); padding: 0 2px;' }), { color: '#bbb' }));
  bar.appendChild(makeButton('×', 'Clear formatting on selection', () => clearSelectionFormatting()));

  document.body.appendChild(bar);
}

function hideTextToolbar() {
  document.getElementById('studio-text-toolbar')?.remove();
}

// Re-position the toolbar when scrolling/rotating/resizing — the
// contenteditable node may have moved on screen.
function repositionTextToolbar() {
  if (!state.editingTextId) return;
  const node = els.pageRoot.querySelector(`[data-element-id="${CSS.escape(state.editingTextId)}"]`);
  if (!node) return;
  const bar = document.getElementById('studio-text-toolbar');
  if (!bar) return;
  const r = node.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const preferRight = r.right + 200 < viewportW - 16;
  if (preferRight) {
    bar.style.left = `${r.right + 10}px`;
    bar.style.top  = `${Math.max(8, r.top)}px`;
  } else {
    bar.style.left = `${Math.max(8, r.left)}px`;
    bar.style.top  = `${Math.max(8, r.top - 44)}px`;
  }
}

function execFormatCommand(cmd) {
  // execCommand is deprecated but remains the cleanest cross-browser way to
  // toggle bold/italic/underline on a selection inside contenteditable.
  // The deprecation has not actually removed the API in any browser.
  try { document.execCommand(cmd, false, null); } catch (e) { /* ignore */ }
  // Persist the change: serialize and write back to the element.
  saveEditingTextState();
}

function wrapSelectionWith(tag, attrs) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;
  const wrapper = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) wrapper.setAttribute(k, v);
  try {
    range.surroundContents(wrapper);
  } catch (e) {
    // Selection crosses element boundaries — extract + wrap + reinsert.
    const contents = range.extractContents();
    wrapper.appendChild(contents);
    range.insertNode(wrapper);
  }
  // Reselect the wrapped content so the user can stack more formatting.
  sel.removeAllRanges();
  const fresh = document.createRange();
  fresh.selectNodeContents(wrapper);
  sel.addRange(fresh);
  saveEditingTextState();
}

// Strip <strong>/<b>/<em>/<i>/<u>/<span> wrappers from the current selection.
// Doesn't touch text outside the selection.
function clearSelectionFormatting() {
  try {
    document.execCommand('removeFormat', false, null);
  } catch (e) { /* ignore */ }
  // removeFormat doesn't remove our class spans; do that manually.
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const frag = range.cloneContents();
    // Replace any <span class="red"> or color spans with their text.
    const tmp = document.createElement('div');
    tmp.appendChild(frag);
    tmp.querySelectorAll('span').forEach(s => {
      while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s);
      s.remove();
    });
    range.deleteContents();
    range.insertNode(tmp.firstChild ? document.createTextNode(tmp.textContent) : document.createTextNode(''));
  }
  saveEditingTextState();
}

// Push the editing node's current HTML back into pageData so changes
// survive rerenders and undo. Equivalent to what focusout does but
// triggered immediately by toolbar actions.
function saveEditingTextState() {
  const fullId = state.editingTextId;
  if (!fullId) return;
  const node = els.pageRoot.querySelector(`[data-element-id="${CSS.escape(fullId)}"]`);
  if (!node) return;
  const isCaption = node.matches?.('figcaption.rkk-caption');
  if (isCaption) {
    const id = fullId.replace(/-caption$/, '');
    const elData = state.pageData?.elements?.find(x => x.id === id);
    if (elData?.caption) {
      const next = node.innerText.trim();
      if (next !== elData.caption.content) {
        elData.caption.content = next;
        commitHistory();
      }
    }
  } else {
    const elData = state.pageData?.elements?.find(x => x.id === fullId);
    if (elData) {
      const next = serializeTextContent(node);
      if (next !== elData.content) {
        elData.content = next;
        commitHistory();
      }
    }
  }
}

// ─── Selection ─────────────────────────────────────────────────────

// Selection model:
// - state.selectedId is the PRIMARY selected element (the one the inspector
//   targets when one isn't multi-selected).
// - state.selectedIds is the full set of selected ids; always contains
//   state.selectedId when one is set. Group drag/copy/delete operates on
//   the full set.
//
// mode arg:
//   'replace' (default) — clear previous, select this.
//   'add'               — add to selection if not already; primary unchanged.
//   'toggle'            — toggle this id in the set; primary updates to
//                          this id when adding, falls back when removing.

function selectElement(id, mode = 'replace') {
  if (!id) return;
  state.selectedSectionId = null;
  if (mode === 'replace' || !state.selectedIds.length) {
    state.selectedId = id;
    state.selectedIds = [id];
  } else if (mode === 'add') {
    if (!state.selectedIds.includes(id)) state.selectedIds.push(id);
    state.selectedId = id;
  } else if (mode === 'toggle') {
    if (state.selectedIds.includes(id)) {
      state.selectedIds = state.selectedIds.filter(x => x !== id);
      state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null;
    } else {
      state.selectedIds.push(id);
      state.selectedId = id;
    }
  }
  // Focus the section containing the primary selection so new elements
  // and paste land where the user is looking.
  const sel = getSelected();
  if (sel?.sectionId) state.focusedSectionId = sel.sectionId;
  refreshSelectionChrome();
  renderInspector();
  renderLayers();
}

function deselect() {
  state.selectedId = null;
  state.selectedIds = [];
  state.selectedSectionId = null;
  state.editingTextId = null;
  if (els.overlay) els.overlay.classList.remove('studio-editing');
  refreshSelectionChrome();
  renderInspector();
  renderLayers();
}

function getSelected() {
  if (!state.selectedId || !state.pageData) return null;
  return state.pageData.elements.find(e => e.id === state.selectedId) || null;
}

function getSelectedAll() {
  if (!state.pageData) return [];
  const ids = new Set(state.selectedIds);
  return state.pageData.elements.filter(e => ids.has(e.id));
}

function findRenderedNode(id) {
  if (!id) return null;
  return els.pageRoot.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
}

async function refreshSelectionChrome() {
  els.overlay.innerHTML = '';
  if (state.mode !== 'edit') return;
  if (state.crop) return; // crop mode owns the overlay

  // Always draw section dividers in edit mode (independent of element selection).
  renderSectionOverlay();

  if (!state.selectedId && state.selectedIds.length === 0) return;

  // Secondary selections: simple ring on each non-primary selected element.
  const secondaryIds = state.selectedIds.filter(id => id !== state.selectedId);
  for (const id of secondaryIds) {
    drawSimpleRing(id);
  }
  // Group union box (dashed): if 2+ selected, draw a union over all.
  if (state.selectedIds.length >= 2) {
    drawGroupBox();
  }

  if (!state.selectedId) return;
  const sel = getSelected();
  const node = findRenderedNode(state.selectedId);
  if (!sel || !node) return;
  const container = els.stageScroll;
  const cRect = container.getBoundingClientRect();
  // For images with caption, the figure wraps both image and caption;
  // selection chrome should hug the image only. Find the inner img.
  const isImage = sel.type === 'image-inline' || sel.type === 'image-decorative' || sel.type === 'hero-artifact';
  const measureNode = isImage ? (node.tagName === 'IMG' ? node : node.querySelector('img') || node) : node;
  const nRect = measureNode.getBoundingClientRect();
  let x = nRect.left - cRect.left + container.scrollLeft;
  let y = nRect.top - cRect.top + container.scrollTop;
  let w = nRect.width, h = nRect.height;

  // Tight bbox: when a crop is active, the visible image IS the crop
  // rectangle — bypass alpha-bounds (which reads the original/uncropped
  // image) and use the crop directly. clip-path is purely visual so the
  // measured rect is the original; we have to inset it ourselves.
  if (isImage) {
    const c = sel.crop || null;
    const hasCrop = !!c && (c.left || c.top || c.right || c.bottom);
    if (hasCrop) {
      // Note: when render uses a baked (cropped) visualSrc, the rendered
      // <img> rect is already the cropped pixels — in that case the
      // measured nRect IS the visible image and no inset is needed.
      // We detect that case by checking if the renderer applied
      // clip-path inline (rkk-cropped class).
      const baked = !measureNode.classList?.contains('rkk-cropped');
      if (!baked) {
        x = nRect.left - cRect.left + container.scrollLeft + nRect.width  * ((c.left  || 0) / 100);
        y = nRect.top  - cRect.top  + container.scrollTop  + nRect.height * ((c.top   || 0) / 100);
        w = nRect.width  * (1 - ((c.left || 0) + (c.right  || 0)) / 100);
        h = nRect.height * (1 - ((c.top  || 0) + (c.bottom || 0)) / 100);
      }
      // baked path: leave x/y/w/h as the measured rect — that already IS
      // the cropped pixel box.
    } else if ((sel.cutSrc || sel.src) && !state.dragging) {
      // Skip the alpha-bounds tighten during an active drag — the async
      // await would create per-frame promises that resolve out of order
      // and stall the ring. Fall back to the rect bbox while dragging.
      try {
        const ab = await getAlphaBounds(sel.cutSrc || sel.src, 0.1);
        if (ab && (ab.w < 99.5 || ab.h < 99.5 || ab.x > 0.5 || ab.y > 0.5)) {
          x = nRect.left - cRect.left + container.scrollLeft + nRect.width * (ab.x / 100);
          y = nRect.top  - cRect.top  + container.scrollTop  + nRect.height * (ab.y / 100);
          w = nRect.width  * (ab.w / 100);
          h = nRect.height * (ab.h / 100);
        }
      } catch (e) { /* fall back to rect bbox */ }
    }
  }

  // Rotated chrome support: if the element is rotated, the measured rect
  // (getBoundingClientRect) is the axis-aligned bbox of the rotated shape,
  // which is larger than the element. To draw a ring that hugs the element,
  // we use the element's UNROTATED dimensions (offsetWidth/Height) centered
  // on the measured center, then apply the same rotation transform to the
  // ring/handles so the chrome visually rotates with the element.
  const rot = Number(sel.rotation) || 0;
  const isRotated = rot !== 0 && (
    sel.type === 'image-decorative' || sel.type === 'hero-artifact' ||
    (sel.type === 'text' && sel.mode === 'decorative') ||
    sel.positioned
  );
  if (isRotated) {
    const cxScreen = (nRect.left + nRect.right) / 2 - cRect.left + container.scrollLeft;
    const cyScreen = (nRect.top  + nRect.bottom) / 2 - cRect.top  + container.scrollTop;
    const ow = measureNode.offsetWidth  || nRect.width;
    const oh = measureNode.offsetHeight || nRect.height;
    x = cxScreen - ow / 2;
    y = cyScreen - oh / 2;
    w = ow;
    h = oh;
  }

  // For rotated elements, pivot all chrome around the element's center so
  // the ring/handles/rotation handle visually rotate with the sprite.
  const pivotCx = x + w / 2;
  const pivotCy = y + h / 2;
  const rotateChrome = (node) => {
    if (!isRotated) return;
    // Read the current left/top, compute the offset from the pivot, set
    // transform-origin in pixel terms so rotation pivots around the
    // element's center regardless of the node's own position.
    const left = parseFloat(node.style.left);
    const top  = parseFloat(node.style.top);
    node.style.transformOrigin = `${pivotCx - left}px ${pivotCy - top}px`;
    node.style.transform = `${node.style.transform || ''} rotate(${rot}deg)`.trim();
  };

  const ring = document.createElement('div');
  ring.className = 'studio-sel-ring';
  ring.style.left = `${x}px`; ring.style.top = `${y}px`;
  ring.style.width = `${w}px`; ring.style.height = `${h}px`;
  rotateChrome(ring);
  els.overlay.appendChild(ring);

  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  for (const h2 of handles) {
    const node2 = document.createElement('div');
    node2.className = 'studio-handle';
    node2.dataset.handle = h2;
    const hx = h2.includes('w') ? x : h2.includes('e') ? x + w : x + w / 2;
    const hy = h2.includes('n') ? y : h2.includes('s') ? y + h : y + h / 2;
    node2.style.left = `${hx}px`;
    node2.style.top = `${hy}px`;
    rotateChrome(node2);
    node2.addEventListener('pointerdown', (e) => beginResize(e, h2));
    els.overlay.appendChild(node2);
  }
  // Rotation stem & handle (pivot at element center, sticks out above)
  const stem = document.createElement('div');
  stem.className = 'studio-rotation-stem';
  stem.style.left = `${x + w / 2}px`;
  stem.style.top = `${y - 22}px`;
  stem.style.height = '22px';
  rotateChrome(stem);
  els.overlay.appendChild(stem);
  const rotH = document.createElement('div');
  rotH.className = 'studio-rotation-handle';
  rotH.style.left = `${x + w / 2}px`;
  rotH.style.top = `${y - 28}px`;
  rotateChrome(rotH);
  rotH.addEventListener('pointerdown', beginRotate);
  els.overlay.appendChild(rotH);

  // Body drag for move (excluding handles)
  ring.style.pointerEvents = 'auto';
  ring.addEventListener('pointerdown', beginMove);
  // Double-click on the ring of a selected image enters crop mode.
  // Text contenteditables swallow dblclick for word selection; the ring
  // sits above the element so the dblclick lands here first.
  if (isImage) {
    ring.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      enterCropMode();
    });
  } else if (sel.type === 'text') {
    // Forward ring dblclick to the underlying text node — the ring sits
    // above the .rkk-text and would otherwise eat the gesture.
    ring.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      enterTextEditMode(node, ev.clientX, ev.clientY);
    });
  }
}

// ─── Selection chrome helpers ──────────────────────────────────────

// Simple ring around any element (used for non-primary multi-selections).
// No handles, no tight image bbox.
function drawSimpleRing(id) {
  const node = findRenderedNode(id);
  if (!node) return;
  const container = els.stageScroll;
  const cRect = container.getBoundingClientRect();
  const measureNode = (node.tagName === 'IMG' ? node : node.querySelector('img') || node);
  const r = measureNode.getBoundingClientRect();
  const x = r.left - cRect.left + container.scrollLeft;
  const y = r.top  - cRect.top  + container.scrollTop;
  const ring = document.createElement('div');
  ring.className = 'studio-sel-ring studio-sel-ring-secondary';
  ring.style.left = `${x}px`; ring.style.top = `${y}px`;
  ring.style.width = `${r.width}px`; ring.style.height = `${r.height}px`;
  ring.style.pointerEvents = 'auto';
  ring.addEventListener('pointerdown', beginMove);
  els.overlay.appendChild(ring);
}

// Dashed bounding box around the full selection set.
function drawGroupBox() {
  const container = els.stageScroll;
  const cRect = container.getBoundingClientRect();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of state.selectedIds) {
    const node = findRenderedNode(id);
    if (!node) continue;
    const r = node.getBoundingClientRect();
    const x = r.left - cRect.left + container.scrollLeft;
    const y = r.top  - cRect.top  + container.scrollTop;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + r.width  > maxX) maxX = x + r.width;
    if (y + r.height > maxY) maxY = y + r.height;
  }
  if (!Number.isFinite(minX)) return;
  const box = document.createElement('div');
  box.className = 'studio-group-box';
  box.style.left = `${minX - 6}px`;
  box.style.top  = `${minY - 6}px`;
  box.style.width  = `${maxX - minX + 12}px`;
  box.style.height = `${maxY - minY + 12}px`;
  els.overlay.appendChild(box);
}

// Section dividers in the overlay (edit mode). Each divider gets:
//  - a horizontal drag-bar that resizes the section above it
//  - a "+ SECTION BELOW" button (and persistent "+ SECTION AT END" after the last section)
//  - a label "§ NN · {height}vh"
function renderSectionOverlay() {
  if (!state.pageData?.sections?.length) return;
  const container = els.stageScroll;
  const cRect = container.getBoundingClientRect();
  const sections = els.pageRoot.querySelectorAll('.rkk-section');
  let idx = 0;
  for (const node of sections) {
    const r = node.getBoundingClientRect();
    const x = r.left - cRect.left + container.scrollLeft;
    const y = r.top  - cRect.top  + container.scrollTop;
    const w = r.width, h = r.height;
    const secId = node.dataset.sectionId;
    const secData = state.pageData.sections.find(s => s.id === secId);
    const isFocused = state.focusedSectionId === secId;
    const isSelected = state.selectedSectionId === secId;
    idx++;

    // Faint section pill (label) at top-left of section, edit only.
    const pill = document.createElement('div');
    pill.className = 'studio-section-pill';
    if (isFocused) pill.classList.add('is-focused');
    if (isSelected) pill.classList.add('is-selected');
    pill.style.left = `${x + 8}px`;
    pill.style.top  = `${y + 8}px`;
    pill.textContent = `§ ${String(idx).padStart(2, '0')} · ${secData?.height ?? '?'}vh`;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      state.selectedSectionId = secId;
      state.focusedSectionId = secId;
      state.selectedId = null;
      state.selectedIds = [];
      refreshSelectionChrome();
      renderInspector();
    });
    els.overlay.appendChild(pill);

    // Resize bar at the BOTTOM of this section (drag = resize this section).
    const bar = document.createElement('div');
    bar.className = 'studio-section-bar';
    bar.style.left = `${x}px`;
    bar.style.top = `${y + h - 6}px`;
    bar.style.width = `${w}px`;
    bar.addEventListener('pointerdown', (e) => beginSectionResize(e, secId));
    els.overlay.appendChild(bar);

    // "+ section below" anchored to the bar's right side.
    const addBelow = document.createElement('button');
    addBelow.type = 'button';
    addBelow.className = 'studio-section-add';
    addBelow.textContent = '+ SECTION BELOW';
    addBelow.style.left = `${x + w - 168}px`;
    addBelow.style.top  = `${y + h - 14}px`;
    addBelow.addEventListener('click', (e) => {
      e.stopPropagation();
      addSectionAfter(secId);
    });
    els.overlay.appendChild(addBelow);
  }

  // Persistent "+ section at end" affordance below the last section.
  const lastSec = sections[sections.length - 1];
  if (lastSec) {
    const r = lastSec.getBoundingClientRect();
    const x = r.left - cRect.left + container.scrollLeft;
    const y = r.top  - cRect.top  + container.scrollTop + r.height;
    const tail = document.createElement('button');
    tail.type = 'button';
    tail.className = 'studio-section-tail-add';
    tail.textContent = '+ SECTION AT END';
    tail.style.left = `${x + r.width / 2 - 100}px`;
    tail.style.top  = `${y + 12}px`;
    tail.addEventListener('click', (e) => {
      e.stopPropagation();
      addSectionAfter(state.pageData.sections[state.pageData.sections.length - 1].id);
    });
    els.overlay.appendChild(tail);
  }
}

// Recompute on scroll/resize
window.addEventListener('resize', () => { refreshSelectionChrome(); repositionTextToolbar(); });
els.stageScroll.addEventListener('scroll', () => { refreshSelectionChrome(); repositionTextToolbar(); }, { passive: true });

// ─── Sections: add / delete / resize ──────────────────────────────

function addSectionAfter(refId) {
  if (!state.pageData) return;
  const arr = state.pageData.sections;
  const idx = arr.findIndex(s => s.id === refId);
  const newSec = { id: uid('sec'), height: SECTION_DEFAULT_HEIGHT, bg: 'inherit' };
  if (idx === -1) arr.push(newSec);
  else arr.splice(idx + 1, 0, newSec);
  state.focusedSectionId = newSec.id;
  commitHistory();
  rerender();
}

function deleteSection(secId) {
  if (!state.pageData) return;
  const arr = state.pageData.sections;
  if (arr.length <= 1) {
    alert('A page must have at least one section.');
    return;
  }
  const idx = arr.findIndex(s => s.id === secId);
  if (idx === -1) return;
  const hasElements = state.pageData.elements.some(e => e.sectionId === secId);
  if (hasElements) {
    const choice = confirm(
      `This section has elements inside it.\n\n` +
      `OK   = delete the section AND its elements\n` +
      `Cancel = keep the section`
    );
    if (!choice) return;
    const deletedIds = new Set(
      state.pageData.elements.filter(e => e.sectionId === secId).map(e => e.id)
    );
    state.pageData.elements = state.pageData.elements.filter(e => e.sectionId !== secId);
    // Drop any deleted ids from the selection so the inspector doesn't try
    // to render a vanished element.
    state.selectedIds = state.selectedIds.filter(id => !deletedIds.has(id));
    if (deletedIds.has(state.selectedId)) state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null;
  }
  arr.splice(idx, 1);
  if (state.focusedSectionId === secId) {
    state.focusedSectionId = arr[Math.min(idx, arr.length - 1)].id;
  }
  state.selectedSectionId = null;
  commitHistory();
  rerender();
  renderInspector();
}

function moveSection(secId, dir /* -1 up, +1 down */) {
  const arr = state.pageData.sections;
  const idx = arr.findIndex(s => s.id === secId);
  if (idx === -1) return;
  const target = idx + dir;
  if (target < 0 || target >= arr.length) return;
  const [moved] = arr.splice(idx, 1);
  arr.splice(target, 0, moved);
  commitHistory();
  rerender();
}

function beginSectionResize(ev, secId) {
  ev.preventDefault(); ev.stopPropagation();
  const sec = state.pageData.sections.find(s => s.id === secId);
  if (!sec) return;
  const startY = ev.clientY;
  const orig = sec.height;
  // 1 vh in px
  const vhPx = window.innerHeight / 100;
  document.body.style.cursor = 'ns-resize';
  function move(e) {
    const dyPx = e.clientY - startY;
    const dyVh = dyPx / vhPx;
    sec.height = Math.max(SECTION_MIN_HEIGHT, Math.min(SECTION_MAX_HEIGHT, orig + dyVh));
    // Live-update the rendered section node so the user sees the resize.
    // Height is a minimum so flow content can still push the section taller.
    const node = els.pageRoot.querySelector(`.rkk-section[data-section-id="${CSS.escape(secId)}"]`);
    if (node) node.style.minHeight = `${sec.height}vh`;
    refreshSelectionChrome();
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
    sec.height = Math.round(sec.height);
    rerender();
    commitHistory();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ─── Drag / move / resize / rotate ────────────────────────────────

function pageWidthPx() {
  const root = els.pageRoot.querySelector('.rkk-canvas') || els.pageRoot;
  return root.getBoundingClientRect().width || 1;
}

// Return the rendered section node for an element. Falls back to canvas.
function sectionNodeForElement(elData) {
  if (!elData?.sectionId) return els.pageRoot.querySelector('.rkk-section') || els.pageRoot;
  return els.pageRoot.querySelector(`.rkk-section[data-section-id="${CSS.escape(elData.sectionId)}"]`) || els.pageRoot;
}

// Which section (if any) contains the screen point (clientX, clientY)?
// Returns the section's id, or null.
function findSectionAtPoint(clientX, clientY) {
  const sections = els.pageRoot.querySelectorAll('.rkk-section');
  for (const sec of sections) {
    const r = sec.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right &&
        clientY >= r.top  && clientY <= r.bottom) {
      return sec.dataset.sectionId;
    }
  }
  return null;
}

// During a cross-section drag, sections need overflow: visible so the
// dragged element is visible past section boundaries. We save the inline
// style values and restore them on release.
function suspendSectionClipping() {
  const saved = new Map();
  for (const sec of els.pageRoot.querySelectorAll('.rkk-section')) {
    saved.set(sec, sec.style.overflow);
    sec.style.overflow = 'visible';
  }
  return saved;
}
function restoreSectionClipping(saved) {
  for (const [sec, prev] of saved) {
    sec.style.overflow = prev || '';
  }
}

// Convert an element to "absolutely positioned within its section" by
// computing its current x/y based on the rendered position. Used to
// promote a flow element on first drag.
//
// We OVERWRITE x/y here even if they were previously set. Reason: legacy
// flow text has x: 0, y: 0 defaults from makeElement that have no spatial
// meaning while the element is in flow. Without overwrite, the first drag
// would teleport the element to (0,0) before applying the drag delta.
function promoteToAbsolute(sel) {
  if (sel.positioned) return; // already absolute
  if (sel.type === 'image-decorative') return; // already absolute by type
  if (sel.type === 'text' && sel.mode === 'decorative') return;
  const node = findRenderedNode(sel.id);
  const sec = sectionNodeForElement(sel);
  if (!node || !sec) return;
  const nr = node.getBoundingClientRect();
  const sr = sec.getBoundingClientRect();
  sel.x = ((nr.left - sr.left) / sr.width) * 100;
  sel.y = ((nr.top  - sr.top)  / sr.height) * 100;
  if (sel.w == null && sel.width == null) sel.w = (nr.width / sr.width) * 100;
  sel.positioned = true;
}

// Pixel threshold for alignment snapping. Converted to section-% per axis
// at drag start so behavior is resolution-independent.
const SNAP_THRESHOLD_PX = 6;

// Build snap targets for one section. Returns { xs: [{at, kind, ofId?}], ys: [...] }
// where `at` is in % of section width (xs) or section height (ys).
function buildSnapTargetsForSection(secNode, secData, excludeIds) {
  const xs = [
    { at: 0,   kind: 'section-left'    },
    { at: 50,  kind: 'section-hcenter' },
    { at: 100, kind: 'section-right'   },
  ];
  const ys = [
    { at: 0,   kind: 'section-top'     },
    { at: 50,  kind: 'section-vcenter' },
    { at: 100, kind: 'section-bottom'  },
  ];
  // Look at every element rendered inside this section. Use the DOM to find
  // them so we naturally handle decoratives, flow, floats. We exclude the
  // currently-dragged ids and elements without data-element-id.
  const sr = secNode.getBoundingClientRect();
  if (sr.width <= 0 || sr.height <= 0) return { xs, ys };
  const items = secNode.querySelectorAll('[data-element-id]');
  for (const item of items) {
    const id = item.dataset.elementId;
    if (!id || excludeIds.has(id)) continue;
    const r = item.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const left   = ((r.left  - sr.left) / sr.width)  * 100;
    const right  = ((r.right - sr.left) / sr.width)  * 100;
    const hCent  = (left + right) / 2;
    const top    = ((r.top    - sr.top) / sr.height) * 100;
    const bot    = ((r.bottom - sr.top) / sr.height) * 100;
    const vCent  = (top + bot) / 2;
    xs.push({ at: left,  kind: 'el-left',    ofId: id });
    xs.push({ at: hCent, kind: 'el-hcenter', ofId: id });
    xs.push({ at: right, kind: 'el-right',   ofId: id });
    ys.push({ at: top,   kind: 'el-top',     ofId: id });
    ys.push({ at: vCent, kind: 'el-vcenter', ofId: id });
    ys.push({ at: bot,   kind: 'el-bottom',  ofId: id });
  }
  return { xs, ys };
}

// Find the closest target to a value within threshold. Returns null if none.
function findClosestSnap(value, targets, thresholdPct) {
  let best = null;
  let bestDist = Infinity;
  for (const t of targets) {
    const d = Math.abs(value - t.at);
    if (d <= thresholdPct && d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

// Try to snap the element's six anchors (left/hcenter/right; top/vcenter/
// bottom) to the section's targets. Returns { x, y, guides[] }, where guides
// are { axis: 'x'|'y', atPercent } for drawing.
function applyAlignmentSnap(rawX, rawY, widthPct, heightPct, targets, thresholdXPct, thresholdYPct) {
  const xAnchors = [
    { pos: rawX,                   anchor: 'left'    },
    { pos: rawX + widthPct / 2,    anchor: 'hcenter' },
    { pos: rawX + widthPct,        anchor: 'right'   },
  ];
  const yAnchors = [
    { pos: rawY,                   anchor: 'top'     },
    { pos: rawY + heightPct / 2,   anchor: 'vcenter' },
    { pos: rawY + heightPct,       anchor: 'bottom'  },
  ];
  // Pick the closest snapping anchor on each axis.
  let xAdjust = 0, ySnap = 0;
  let xGuide = null, yGuide = null;
  let xBestDist = Infinity, yBestDist = Infinity;
  for (const a of xAnchors) {
    const t = findClosestSnap(a.pos, targets.xs, thresholdXPct);
    if (t) {
      const dist = Math.abs(t.at - a.pos);
      if (dist < xBestDist) {
        xBestDist = dist;
        xAdjust = t.at - a.pos;
        xGuide = { axis: 'x', atPercent: t.at, kind: t.kind, ofId: t.ofId };
      }
    }
  }
  for (const a of yAnchors) {
    const t = findClosestSnap(a.pos, targets.ys, thresholdYPct);
    if (t) {
      const dist = Math.abs(t.at - a.pos);
      if (dist < yBestDist) {
        yBestDist = dist;
        ySnap = t.at - a.pos;
        yGuide = { axis: 'y', atPercent: t.at, kind: t.kind, ofId: t.ofId };
      }
    }
  }
  return {
    x: rawX + xAdjust,
    y: rawY + ySnap,
    guides: [xGuide, yGuide].filter(Boolean),
  };
}

// Draw snap guide lines in the overlay. `guides` is what applyAlignmentSnap
// returned. Section context tells us which section's coords the guides are
// in (so we can position them on screen).
function drawSnapGuides(guides, secNode) {
  // Remove any previous guides.
  els.overlay.querySelectorAll('.studio-snap-guide').forEach(n => n.remove());
  if (!guides.length || !secNode) return;
  const container = els.stageScroll;
  const cRect = container.getBoundingClientRect();
  const sr = secNode.getBoundingClientRect();
  const sx = sr.left - cRect.left + container.scrollLeft;
  const sy = sr.top  - cRect.top  + container.scrollTop;
  for (const g of guides) {
    const line = document.createElement('div');
    line.className = 'studio-snap-guide';
    if (g.axis === 'x') {
      // Vertical line at x% of section width.
      const x = sx + sr.width * (g.atPercent / 100);
      line.style.left = `${x - 0.5}px`;
      line.style.top  = `${sy}px`;
      line.style.width = '1px';
      line.style.height = `${sr.height}px`;
    } else {
      // Horizontal line at y% of section height.
      const y = sy + sr.height * (g.atPercent / 100);
      line.style.top  = `${y - 0.5}px`;
      line.style.left = `${sx}px`;
      line.style.width = `${sr.width}px`;
      line.style.height = '1px';
    }
    els.overlay.appendChild(line);
  }
}

function beginMove(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const all = getSelectedAll();
  if (!all.length) return;
  // Locked elements are immovable; if every selected element is locked,
  // bail entirely. Otherwise we just skip the locked ones in the loop.
  if (all.every(e => e.locked)) return;

  const startX = ev.clientX, startY = ev.clientY;
  const wPx = pageWidthPx();

  // For each selected element: capture original position, find section
  // box, and prepare its live node.
  const movables = [];
  const excludeIds = new Set(all.map(e => e.id));
  for (const sel of all) {
    if (sel.locked) continue;
    // image-inline is anchored by paragraph; we keep its old behavior
    // (paragraph guide) ONLY when it is the lone selection. In a group
    // drag we promote it to absolute.
    if (sel.type === 'image-inline' && all.length === 1 && !sel.positioned) {
      // Fall through to legacy single-image-inline anchor behavior below.
      return beginMoveImageInlineAnchor(ev, sel);
    }
    promoteToAbsolute(sel);
    const sec = sectionNodeForElement(sel);
    const secRect = sec.getBoundingClientRect();
    const liveNode = findRenderedNode(sel.id);
    const lr = liveNode ? liveNode.getBoundingClientRect() : { width: 0, height: 0 };
    movables.push({
      sel,
      orig: clone(sel),
      liveNode,
      secNode: sec,
      secW: secRect.width || wPx,
      secH: secRect.height || 1,
      // Width/height of the rendered element in % of section coords, for
      // computing anchor positions in snap math.
      widthPct:  secRect.width  ? (lr.width  / secRect.width)  * 100 : (sel.w ?? sel.width ?? 0),
      heightPct: secRect.height ? (lr.height / secRect.height) * 100 : 0,
    });
  }
  if (!movables.length) return;

  // Suspend section overflow clipping so the dragged element is visible
  // when crossing section boundaries.
  const savedOverflow = suspendSectionClipping();
  // Mark dragging so the selection-chrome refresh skips the async alpha-
  // bounds path (it'd queue per-frame promises and stall the ring).
  state.dragging = true;

  // Build snap targets only for single-element drag (group snap is a
  // separate, more involved feature). Targets are computed per-section so
  // a sibling in section 2 doesn't pull section 1's drag.
  const isSingle = movables.length === 1;
  const snapTargetsBySection = new Map();
  if (isSingle) {
    const m0 = movables[0];
    const sd = state.pageData.sections.find(s => s.id === m0.sel.sectionId);
    snapTargetsBySection.set(m0.sel.sectionId,
      buildSnapTargetsForSection(m0.secNode, sd, excludeIds));
  }

  function move(e) {
    let dx = e.clientX - startX;
    let dy = e.clientY - startY;
    // Alt/Option = free drag (no snap, no grid). Shift = 8px grid (only
    // when Alt is not held). Otherwise = alignment snap (single-element).
    const freeMode = e.altKey;
    if (!freeMode && e.shiftKey) {
      dx = Math.round(dx / 8) * 8;
      dy = Math.round(dy / 8) * 8;
    }

    for (const m of movables) {
      const dxPctX = (dx / m.secW) * 100;
      const dyPctY = (dy / m.secH) * 100;
      let nx = (m.orig.x ?? 0) + dxPctX;
      let ny = (m.orig.y ?? 0) + dyPctY;

      // Alignment snap: only for single-element drag, only when no modifier.
      let guides = [];
      if (isSingle && !freeMode && !e.shiftKey) {
        const targets = snapTargetsBySection.get(m.sel.sectionId);
        if (targets) {
          // Threshold in % of section dimensions.
          const tx = (SNAP_THRESHOLD_PX / m.secW) * 100;
          const ty = (SNAP_THRESHOLD_PX / m.secH) * 100;
          const snapped = applyAlignmentSnap(nx, ny, m.widthPct, m.heightPct, targets, tx, ty);
          nx = snapped.x;
          ny = snapped.y;
          guides = snapped.guides;
        }
      }
      m.sel.x = nx;
      m.sel.y = ny;
      if (m.liveNode) {
        m.liveNode.style.position = 'absolute';
        m.liveNode.style.left = `${m.sel.x}%`;
        m.liveNode.style.top  = `${m.sel.y}%`;
      }
      // Guides for single drag only.
      if (isSingle) drawSnapGuides(guides, m.secNode);
    }
    // Selection ring + handles need to follow the element. Skip alpha-
    // bounds (state.dragging guards refreshSelectionChrome).
    refreshSelectionChrome();
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    state.dragging = false;
    // Clean up drag UI.
    els.overlay.querySelectorAll('.studio-snap-guide').forEach(n => n.remove());
    restoreSectionClipping(savedOverflow);

    // Cross-section reassignment: for each moved element, find which
    // section its CENTER now sits in. If different from its current
    // sectionId, reassign and recompute x/y as % of new section coords.
    for (const m of movables) {
      const node = m.liveNode;
      if (!node) continue;
      const r = node.getBoundingClientRect();
      const cx = r.left + r.width  / 2;
      const cy = r.top  + r.height / 2;
      const newSecId = findSectionAtPoint(cx, cy);
      if (newSecId && newSecId !== m.sel.sectionId) {
        const newSec = els.pageRoot.querySelector(`.rkk-section[data-section-id="${CSS.escape(newSecId)}"]`);
        if (newSec) {
          const sr = newSec.getBoundingClientRect();
          // Element's top-left re-expressed in the new section's % coords.
          m.sel.x = ((r.left - sr.left) / sr.width)  * 100;
          m.sel.y = ((r.top  - sr.top)  / sr.height) * 100;
          m.sel.sectionId = newSecId;
          state.focusedSectionId = newSecId;
        }
      }
    }
    rerender();
    commitHistory();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Legacy image-inline single-selection move: shows a paragraph anchor
// guide and updates anchor.afterParagraph rather than x/y. Preserved so
// existing inline-image-in-text behavior keeps working.
function beginMoveImageInlineAnchor(ev, sel) {
  ev.preventDefault(); ev.stopPropagation();
  const startX = ev.clientX, startY = ev.clientY;
  const orig = clone(sel);
  const guide = document.createElement('div');
  guide.className = 'studio-paragraph-guide';
  let usingGuide = false;
  function move(e) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const para = target?.closest?.('.rkk-p');
    if (para) {
      const idx = parseInt(para.dataset.paraIndex || '0', 10);
      sel.anchor = sel.anchor || {};
      sel.anchor.afterParagraph = idx;
      const cRect = els.stageScroll.getBoundingClientRect();
      const pRect = para.getBoundingClientRect();
      guide.style.left = `${pRect.left - cRect.left + els.stageScroll.scrollLeft}px`;
      guide.style.top = `${pRect.top - cRect.top + els.stageScroll.scrollTop}px`;
      guide.style.width = `${pRect.width}px`;
      if (!usingGuide) { els.overlay.appendChild(guide); usingGuide = true; }
    }
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (usingGuide) guide.remove();
    rerender();
    commitHistory();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function beginResize(ev, dir) {
  ev.preventDefault(); ev.stopPropagation();
  const sel = getSelected(); if (!sel) return;
  if (sel.locked) return;
  const startX = ev.clientX;
  const wPx = pageWidthPx();
  const orig = clone(sel);
  const liveNode = findRenderedNode(sel.id);
  state.dragging = true;
  // For text elements: corner handles (NW/NE/SE/SW) scale the FONT
  // proportionally to the width change, so the bounding box grows in
  // both dimensions — the Photoshop / Illustrator convention. Side
  // handles (N/S/E/W) keep the existing width-only behavior so you can
  // still reflow text without scaling its size. Refresh selection chrome
  // each frame so the ring tracks the visibly growing element.
  const isCornerOnText = sel.type === 'text' && /^(nw|ne|sw|se)$/.test(dir);
  function move(e) {
    const dx = e.clientX - startX;
    const dxPct = (dx / wPx) * 100;
    let widthField = null;
    if (sel.type === 'image-inline' || sel.type === 'marquee' || sel.type === 'spec-sheet' || sel.type === 'single-field') widthField = 'width';
    else if (sel.type === 'image-decorative' || sel.type === 'hero-artifact' || sel.type === 'text') widthField = 'w';
    if (!widthField) return;
    const baseWidth = orig[widthField] != null ? orig[widthField] : (sel.type === 'hero-artifact' ? 60 : sel.type === 'image-inline' ? 38 : 40);
    let delta = 0;
    if (dir.includes('e')) delta = dxPct;
    else if (dir.includes('w')) delta = -dxPct;
    else delta = dxPct;
    let newWidth = Math.max(4, Math.min(120, baseWidth + delta));
    if (e.shiftKey && (sel.type === 'image-decorative' || sel.type === 'hero-artifact' || sel.type === 'image-inline')) {
      // aspect: width-only is already aspect-preserving since height is auto.
    }
    sel[widthField] = Math.round(newWidth * 10) / 10;
    const textIsDeco = sel.type === 'text' && sel.mode === 'decorative';
    if ((sel.type === 'image-decorative' || textIsDeco) && dir.includes('w')) {
      sel.x = (orig.x ?? 0) - delta;
    }
    // Cheap direct DOM update — avoid full rerender mid-drag.
    if (liveNode) {
      liveNode.style.width = `${sel[widthField]}%`;
      if ((sel.type === 'image-decorative' || textIsDeco) && dir.includes('w')) {
        liveNode.style.left = `${sel.x}%`;
      }
    }
    // Text + corner: scale font size proportionally with the width change.
    if (isCornerOnText && liveNode) {
      sel.style = sel.style || {};
      const baseSize = orig.style?.size ?? 1.2;
      // Ratio of new width to original width drives the font scale. Clamp
      // so we never go below 0.3 (unreadably small) or above 80 (insane).
      const ratio = baseWidth > 0 ? newWidth / baseWidth : 1;
      const newSize = Math.max(0.3, Math.min(80, baseSize * ratio));
      sel.style.size = Math.round(newSize * 100) / 100;
      // Apply the new font size live so the user sees the bounding box grow.
      liveNode.style.fontSize = `clamp(1rem, ${sel.style.size}vw, ${sel.style.size * 1.15}rem)`;
    }
    // Refresh the selection ring each frame so it tracks the growing box.
    // (Cheap: just measures one rect and redraws the overlay.)
    refreshSelectionChrome();
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    state.dragging = false;
    rerender();
    commitHistory();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Generation counter: bumped on every rotate-drag start so stale bake
// promises that resolve after the user has moved on (or released) can
// be cheaply ignored.
let rotateGeneration = 0;

function beginRotate(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const sel = getSelected(); if (!sel) return;
  if (sel.locked) return;
  const node = findRenderedNode(sel.id);
  if (!node) return;
  const r = node.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const startAng = Math.atan2(ev.clientY - cy, ev.clientX - cx);
  const orig = Number(sel.rotation) || 0;
  const readout = document.createElement('div');
  readout.className = 'studio-rotation-readout';
  document.body.appendChild(readout);
  let lastBakeAt = 0;
  const myGen = ++rotateGeneration;
  state.dragging = true;
  // Cache the live img so we don't re-query every move.
  const liveImg = node.querySelector?.('img') || (node.tagName === 'IMG' ? node : null);
  // NOT async — we never await in the hot path. Fire-and-forget the bake.
  function move(e) {
    if (myGen !== rotateGeneration) return; // a newer rotate has started
    const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
    let deg = orig + (ang - startAng) * 180 / Math.PI;
    deg = Math.round(deg);
    sel.rotation = deg;
    readout.textContent = `${deg}°`;
    readout.style.left = `${e.clientX + 12}px`;
    readout.style.top = `${e.clientY + 12}px`;
    // Cheap visual rotation on the live element so it tracks the cursor
    // immediately. We do NOT rebuild the selection chrome on every move;
    // we rotate the existing ring/handles via CSS transform around the
    // element's center so they appear to follow.
    if (sel.type === 'image-inline') {
      // Inline images live in flow; rotate just the figure visually.
      node.style.transformOrigin = 'center center';
      node.style.transform = `rotate(${deg}deg)`;
    } else if (sel.type === 'image-decorative' || sel.type === 'hero-artifact' || (sel.type === 'text' && sel.mode === 'decorative')) {
      // These already use transform for placement (decoratives keep
      // transform-origin top-left; replace just the rotation portion).
      node.style.transform = `rotate(${deg}deg)`;
    }
    // For inline images, also live-bake shape-outside so text wrap follows.
    // Throttle to 50ms (heavier than 32ms; queues fewer bakes). Fire-and-
    // forget; ignore the result if a newer drag has begun.
    if (sel.type === 'image-inline' && sel.cutSrc) {
      const now = performance.now();
      if (now - lastBakeAt > 50) {
        lastBakeAt = now;
        const bakeGen = myGen;
        const bakeDeg = deg;
        bakeAlphaMask(sel.cutSrc, bakeDeg).then((url) => {
          // Stale guard: another drag has started, or this is an old promise.
          if (bakeGen !== rotateGeneration) return;
          // Also ignore if the angle has moved on substantially since.
          if (Math.abs((sel.rotation || 0) - bakeDeg) > 4) return;
          node.style.shapeOutside = `url("${url}")`;
          if (liveImg) liveImg.src = url;
        }).catch(() => {});
      }
    }
    // Rotate the selection chrome too so the ring and handles follow the
    // element. refreshSelectionChrome reads sel.rotation and applies the
    // rotation transform to the ring/handles around the element's center.
    // state.dragging is set, so the async alpha-bounds path is skipped.
    refreshSelectionChrome();
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    readout.remove();
    state.dragging = false;
    // Bump generation again so any in-flight bakes resolving after this
    // point are dropped silently.
    rotateGeneration++;
    rerender().then(() => {
      // ONE chrome refresh after release.
      refreshSelectionChrome();
    });
    commitHistory();
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ─── Drop / image insert ───────────────────────────────────────────

els.stage.addEventListener('dragover', (e) => {
  if (!e.dataTransfer) return;
  const hasFile = Array.from(e.dataTransfer.items || []).some(i => i.kind === 'file');
  const hasBank = Array.from(e.dataTransfer.types || []).includes('application/x-rkk-bank');
  if (hasFile || hasBank) {
    e.preventDefault();
    if (hasFile) els.stage.classList.add('is-dropping');
  }
});
els.stage.addEventListener('dragleave', () => els.stage.classList.remove('is-dropping'));
els.stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.stage.classList.remove('is-dropping');
  const files = Array.from(e.dataTransfer.files || []).filter(f => /^image\/(png|jpe?g)$/i.test(f.type));
  if (!files.length) return;
  if (!state.rootHandle || !state.currentSlug) { alert('Connect a project folder and pick a page first.'); return; }
  let lastId = null;
  let cascadeIdx = 0;
  for (const file of files) {
    try {
      const id = await ingestImage(file, { cascadeIdx });
      if (id) { lastId = id; cascadeIdx++; }
    } catch (err) { console.warn('ingestImage failed for', file.name, err); }
  }
  if (lastId) selectElement(lastId);
  if (files.length) showStudioToast(`Imported ${files.length} file${files.length === 1 ? '' : 's'}`);
  // Auto-refresh page bank after every multi-file drop. Use the safe
  // wrapper so old object URLs are revoked first (otherwise each drop
  // leaks the previous tile blobs).
  await refreshBankPageSafe();
});

// Ingest one file. Returns the new element id or null.
async function ingestImage(file, opts = {}) {
  if (!state.rootHandle || !state.currentSlug) return null;
  const buf = await file.arrayBuffer();
  const hex = (await sha256Hex(buf)).slice(0, 12);
  const ext = (file.type === 'image/jpeg' ? 'jpg' : 'png');
  const pagesDir = await state.rootHandle.getDirectoryHandle('pages', { create: true });
  const pageDir = await pagesDir.getDirectoryHandle(state.currentSlug, { create: true });
  const assets = await getOrCreateDir(pageDir, 'assets');
  const origName = `${hex}.${ext}`;
  const cutName = `${hex}.cut.png`;
  if (!await fileExists(assets, origName)) {
    await writeFile(assets, origName, new Blob([buf], { type: file.type }));
  }
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: file.type }));
  let cutDataUrl;
  try { cutDataUrl = await knockBackground(blobUrl); }
  catch (e) { console.warn('knockBackground failed', e); cutDataUrl = blobUrl; }
  const cutBlob = cutDataUrl.startsWith('data:') ? dataUrlToBlob(cutDataUrl) : new Blob([buf], { type: file.type });
  if (!await fileExists(assets, cutName)) {
    await writeFile(assets, cutName, cutBlob);
  }
  URL.revokeObjectURL(blobUrl);

  const cascade = opts.cascadeIdx || 0;
  // Cascade: bump anchor.afterParagraph by 1 per file so they don't pile.
  const newEl = {
    id: uid('img'),
    type: 'image-inline',
    z: nextZ(),
    locked: false, hidden: false,
    sectionId: state.focusedSectionId || state.pageData.sections?.[0]?.id || null,
    src: `/pages/${state.currentSlug}/assets/${origName}`,
    cutSrc: `/pages/${state.currentSlug}/assets/${cutName}`,
    side: 'right',
    anchor: { afterParagraph: 1 + cascade },
    width: 38,
    rotation: 0,
    shapeMargin: 18,
    shapeThreshold: 0.35,
    specimen: false,
  };
  state.pageData.elements.push(newEl);
  commitHistory();
  await rerender();
  return newEl.id;
}

function showStudioToast(msg) {
  const t = document.createElement('div');
  t.className = 'studio-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
}

// ─── Add element buttons ───────────────────────────────────────────

function nextZ() {
  if (!state.pageData?.elements?.length) return 1;
  return Math.max(...state.pageData.elements.map(e => e.z || 0)) + 1;
}

function makeElement(type) {
  const secId = state.focusedSectionId || state.pageData?.sections?.[0]?.id || null;
  const base = { id: uid(type === 'asterism' ? 'ast' : type.slice(0, 3)), type, z: nextZ(), locked: false, hidden: false, sectionId: secId };
  switch (type) {
    case 'text':
      return { ...base, x: 0, y: 0, w: 100,
        content: 'Type here. Two newlines makes a new paragraph.',
        style: { family: 'serif', size: 1.2, weight: 380, leading: 1.55, align: 'left', italic: false, transform: 'none', dropCap: false },
        rotation: 0, wrapNeighbours: true };
    case 'marquee':
      return { ...base, y: 0, content: 'NEW DROP · ', background: 'ink', color: 'paper', speed: 38, direction: 'left' };
    case 'hero-artifact':
      return { ...base, src: '', w: 60, idleMotion: 'none', specimen: false, caption: '' };
    case 'spec-sheet':
      return { ...base, rows: [{ label: 'MEDIUM', value: '' }, { label: 'YEAR', value: '' }] };
    case 'single-field':
      return { ...base, placeholder: 'your.email@studio', buttonLabel: 'JOIN THE DISPATCH',
        action: { type: 'mailto', to: 'studio@raghavakk.com' } };
    case 'asterism':
      return { ...base };
  }
  return null;
}

function addElement(type) {
  if (!state.pageData) return;
  const e = makeElement(type);
  if (!e) return;
  // Always drop new elements into the LAST section so there's one predictable
  // place to find them. The user can then drag the element into whatever
  // section they want it in.
  const lastSec = state.pageData.sections[state.pageData.sections.length - 1];
  if (lastSec) e.sectionId = lastSec.id;
  state.pageData.elements.push(e);
  commitHistory();
  rerender();
  selectElement(e.id);
  // Scroll the new element into view so the user actually sees it.
  setTimeout(() => {
    const node = findRenderedNode(e.id);
    node?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, 32);
}

// ─── Inspector ─────────────────────────────────────────────────────

function inspectorChange() {
  scheduleRerender();
  if (state.inspectorCommitTimer) clearTimeout(state.inspectorCommitTimer);
  state.inspectorCommitTimer = setTimeout(() => commitHistory(), INSPECTOR_COMMIT_DEBOUNCE);
}

function field(label, inputNode, helper) {
  const w = document.createElement('div'); w.className = 'studio-field';
  const l = document.createElement('label'); l.className = 'studio-field-label'; l.textContent = label;
  w.appendChild(l); w.appendChild(inputNode);
  if (helper) {
    const h = document.createElement('div'); h.className = 'studio-helper'; h.textContent = helper;
    w.appendChild(h);
  }
  return w;
}
function input(value, onChange, type = 'text') {
  const i = document.createElement('input');
  i.className = 'studio-input';
  i.type = type;
  if (type === 'number') {
    // Allow decimal increments. Without this the spinner steps by 1, which
    // is too coarse for things like font size (1.2 → 2.2 → 3.2 jumps), and
    // some browsers reject "1.5" as invalid against the default integer step.
    i.step = 'any';
  }
  i.value = value == null ? '' : value;
  i.addEventListener('input', () => onChange(type === 'number' ? Number(i.value) : i.value));
  return i;
}
function select(value, options, onChange) {
  const s = document.createElement('select');
  s.className = 'studio-select';
  for (const o of options) {
    const opt = document.createElement('option');
    if (typeof o === 'string') { opt.value = o; opt.textContent = o.toUpperCase(); }
    else { opt.value = o.value; opt.textContent = (o.label || String(o.value)).toUpperCase(); }
    if (opt.value === String(value)) opt.selected = true;
    s.appendChild(opt);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function textarea(value, onChange) {
  const t = document.createElement('textarea');
  t.className = 'studio-textarea';
  t.value = value == null ? '' : value;
  t.addEventListener('input', () => onChange(t.value));
  return t;
}
function toggle(label, value, onChange) {
  const w = document.createElement('label'); w.className = 'studio-toggle';
  const i = document.createElement('input'); i.type = 'checkbox'; i.checked = !!value;
  i.addEventListener('change', () => onChange(i.checked));
  const sw = document.createElement('span'); sw.className = 'studio-switch';
  const lab = document.createElement('span'); lab.className = 'studio-toggle-label'; lab.textContent = label;
  w.appendChild(i); w.appendChild(sw); w.appendChild(lab);
  return w;
}
function row(...children) { const r = document.createElement('div'); r.className = 'studio-row'; for (const c of children) r.appendChild(c); return r; }
function section(title, ...children) {
  const w = document.createElement('div'); w.className = 'studio-section';
  if (title) { const h = document.createElement('div'); h.className = 'studio-section-head'; h.textContent = title; w.appendChild(h); }
  for (const c of children) w.appendChild(c);
  return w;
}
function btn(label, onClick, opts = {}) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'studio-btn';
  if (opts.danger) b.classList.add('danger');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderInspector() {
  els.inspectorBody.innerHTML = '';
  // 1) Section inspector wins if a section is currently selected.
  if (state.selectedSectionId) {
    els.inspectorTitle.textContent = 'SECTION';
    renderSectionInspector();
    return;
  }
  const sel = getSelected();
  if (!sel) { els.inspectorTitle.textContent = 'PAGE'; renderPageInspector(); return; }
  // Multi-select indicator in title.
  if (state.selectedIds.length > 1) {
    els.inspectorTitle.textContent = `${state.selectedIds.length} SELECTED`;
  } else {
    els.inspectorTitle.textContent = sel.type.replace(/-/g, ' ').toUpperCase();
  }
  const ins = (n) => els.inspectorBody.appendChild(n);
  // Multi-select: show only the group-ops summary, not the per-type editor.
  if (state.selectedIds.length > 1) {
    renderMultiSelectInspector(ins);
    return;
  }
  switch (sel.type) {
    case 'text': renderTextInspector(sel, ins); break;
    case 'image-inline': renderImageInlineInspector(sel, ins); break;
    case 'image-decorative': renderImageDecorativeInspector(sel, ins); break;
    case 'marquee': renderMarqueeInspector(sel, ins); break;
    case 'hero-artifact': renderHeroInspector(sel, ins); break;
    case 'spec-sheet': renderSpecInspector(sel, ins); break;
    case 'single-field': renderFieldInspector(sel, ins); break;
    case 'asterism': renderAsterismInspector(sel, ins); break;
  }
  // Common: delete button
  ins(section('', btn('DELETE ELEMENT', () => {
    const idx = state.pageData.elements.findIndex(e => e.id === sel.id);
    if (idx >= 0) {
      state.pageData.elements.splice(idx, 1);
      state.selectedId = null;
      commitHistory(); rerender(); renderInspector(); renderLayers();
    }
  }, { danger: true })));
}

function renderPageInspector() {
  const p = state.pageData;
  if (!p) {
    const m = document.createElement('div'); m.className = 'studio-helper';
    m.textContent = 'Connect a project folder and pick a page.';
    els.inspectorBody.appendChild(m);
    return;
  }
  const ins = (n) => els.inspectorBody.appendChild(n);
  ins(section('PAGE',
    field('Title', input(p.title, v => { p.title = v; inspectorChange(); })),
    field('Drop number.', input(p.dropNumber, v => { p.dropNumber = v; inspectorChange(); })),
    field('Section.', input(p.section, v => { p.section = v; inspectorChange(); })),
    field('Slug.', (() => { const i = input(p.slug, () => {}); i.disabled = true; return i; })()),
  ));
  ins(section('CANVAS',
    field('Background.', select(p.canvas?.background || 'paper', ['paper', 'paper-2', 'paper-3', 'ink'], v => { p.canvas = p.canvas || {}; p.canvas.background = v; inspectorChange(); })),
    field('Cursor.', select(p.cursor || 'default', ['default', 'paint', 'crosshair', 'red-dot'], v => { p.cursor = v; inspectorChange(); })),
    field('Signature.', select(p.signature || 'none', ['none', 'draggable-stickers', 'paint-trail'], v => { p.signature = v; inspectorChange(); })),
  ));

  // Section list at the bottom of the page inspector. Click a row to
  // open its section inspector; the row also exposes quick reorder/delete.
  const secList = document.createElement('div');
  secList.className = 'studio-section-list';
  (p.sections || []).forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'studio-section-row';
    if (state.focusedSectionId === s.id) row.classList.add('is-focused');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'studio-section-row-label';
    label.textContent = `§ ${String(i + 1).padStart(2, '0')} · ${s.height}vh · ${s.bg || 'inherit'}`;
    label.addEventListener('click', () => {
      state.selectedSectionId = s.id;
      state.focusedSectionId = s.id;
      state.selectedId = null;
      state.selectedIds = [];
      refreshSelectionChrome();
      renderInspector();
    });
    row.appendChild(label);

    const up = document.createElement('button');
    up.type = 'button'; up.className = 'studio-icon-btn'; up.textContent = '↑';
    up.disabled = i === 0;
    up.addEventListener('click', () => moveSection(s.id, -1));
    row.appendChild(up);

    const down = document.createElement('button');
    down.type = 'button'; down.className = 'studio-icon-btn'; down.textContent = '↓';
    down.disabled = i === p.sections.length - 1;
    down.addEventListener('click', () => moveSection(s.id, +1));
    row.appendChild(down);

    secList.appendChild(row);
  });
  ins(section('SECTIONS', secList,
    btn('+ ADD SECTION AT END', () => addSectionAfter(p.sections[p.sections.length - 1].id))
  ));
}

// Section inspector — shown when the user clicks a section pill or a
// section row in the page inspector. Edits live; commits to history.
function renderSectionInspector() {
  const p = state.pageData;
  const sec = p?.sections?.find(s => s.id === state.selectedSectionId);
  if (!sec) {
    state.selectedSectionId = null;
    renderInspector();
    return;
  }
  const ins = (n) => els.inspectorBody.appendChild(n);
  const idx = p.sections.indexOf(sec);
  ins(section(`§ ${String(idx + 1).padStart(2, '0')}`,
    field('Label (optional).', input(sec.label || '', v => { sec.label = v || null; inspectorChange(); })),
    field(`Height (vh). Min ${SECTION_MIN_HEIGHT}, max ${SECTION_MAX_HEIGHT}.`,
      input(sec.height, v => {
        const n = Number(v);
        if (Number.isFinite(n)) {
          sec.height = Math.max(SECTION_MIN_HEIGHT, Math.min(SECTION_MAX_HEIGHT, n));
          inspectorChange();
        }
      }, 'number')),
    toggle('Clip overflow (off = section grows with content).',
      sec.clip !== false, v => { sec.clip = v; inspectorChange(); }),
  ));
  ins(section('BACKGROUND',
    field('Preset.', select(sec.bg || 'inherit', SECTION_BG_OPTIONS, v => { sec.bg = v; inspectorChange(); })),
    field('Custom color (overrides preset).',
      input(sec.bgColor || '', v => { sec.bgColor = v || null; inspectorChange(); })),
    field('Image URL (overrides color).',
      input(sec.bgImage || '', v => { sec.bgImage = v || null; inspectorChange(); })),
  ));
  ins(section('ORDER',
    row(
      btn('↑ MOVE UP', () => moveSection(sec.id, -1)),
      btn('↓ MOVE DOWN', () => moveSection(sec.id, +1)),
    )
  ));
  ins(section('',
    btn('DELETE SECTION', () => deleteSection(sec.id), { danger: true }),
    btn('CLOSE SECTION INSPECTOR', () => {
      state.selectedSectionId = null;
      refreshSelectionChrome();
      renderInspector();
    }),
  ));
}

// Multi-select inspector — quick group ops without the per-element editor.
function renderMultiSelectInspector(ins) {
  const all = getSelectedAll();
  ins(section('GROUP',
    (() => {
      const m = document.createElement('div');
      m.className = 'studio-helper';
      m.textContent = `${all.length} elements selected. Drag any one to move the group. ` +
        `Cmd+C to copy, Cmd+V to paste, Delete to remove.`;
      return m;
    })(),
    row(
      btn('DUPLICATE GROUP', () => duplicateSelected()),
      btn('DELETE GROUP', () => deleteSelection(), { danger: true }),
    ),
  ));
}

function renderTextInspector(sel, ins) {
  sel.style = sel.style || {};
  const isDeco = sel.mode === 'decorative';

  ins(section('TEXT',
    field('Content. Use <span class=\'red\'>…</span> for the red word.', textarea(sel.content, v => { sel.content = v; inspectorChange(); })),
  ));

  // Mode toggle (Flow / Free) + page anchor (visible only in flow mode).
  const modeSeg = segmented(['flow', 'decorative'], isDeco ? 'decorative' : 'flow', v => {
    if (v === 'decorative' && !isDeco) {
      sel.mode = 'decorative';
      // Stash the flow width so we can restore it on toggle back.
      if (sel.w != null) sel._flowW = sel.w;
      // Free-placed text needs its own sensible bounds, NOT the inherited
      // flow width (which is the column width, e.g. 87.9% — far too wide
      // for a free block and likely to overflow the canvas).
      sel.x = 10;
      sel.y = 10;
      sel.w = 36;
      sel.rotation = sel.rotation ?? 0;
      // pageAnchor irrelevant in decorative mode.
      delete sel.pageAnchor;
    } else if (v === 'flow' && isDeco) {
      sel.mode = 'flow';
      delete sel.x; delete sel.y; delete sel.rotation;
      // Restore the prior flow width if we stashed one; otherwise drop w
      // entirely so the text fills the column naturally.
      if (sel._flowW != null) { sel.w = sel._flowW; delete sel._flowW; }
      else delete sel.w;
    }
    commitHistory(); rerender(); renderInspector();
  }, [{ value: 'flow', label: 'FLOW' }, { value: 'decorative', label: 'FREE' }]);

  const placement = section('PLACEMENT', field('Mode.', modeSeg));
  if (!isDeco) {
    const cur = sel.pageAnchor || 'none';
    const anchorSeg = segmented(['none', 'left', 'center', 'right'], cur, v => {
      if (v === 'none') delete sel.pageAnchor;
      else sel.pageAnchor = v;
      inspectorChange();
    }, [
      { value: 'none', label: 'NONE' },
      { value: 'left', label: '←' },
      { value: 'center', label: 'CENTER' },
      { value: 'right', label: '→' },
    ]);
    placement.appendChild(field('Page anchor.', anchorSeg));
  }
  ins(placement);

  ins(section('TYPE',
    field('Family.', select(sel.style.family || 'serif', ['display', 'serif', 'mono'], v => { sel.style.family = v; inspectorChange(); })),
    row(
      field('Size (vw). Drag a corner to scale visually.',
        input(sel.style.size ?? 1.2, v => { sel.style.size = v; inspectorChange(); }, 'number')),
      field('Weight',
        input(sel.style.weight ?? 400, v => { sel.style.weight = v; inspectorChange(); }, 'number')),
    ),
    row(
      field('Leading', input(sel.style.leading ?? 1.5, v => { sel.style.leading = v; inspectorChange(); }, 'number')),
      field('Align', select(sel.style.align || 'left', ['left', 'right', 'center'], v => { sel.style.align = v; inspectorChange(); })),
    ),
    field('Transform.', select(sel.style.transform || 'none', ['none', 'uppercase'], v => { sel.style.transform = v; inspectorChange(); })),
    toggle('Italic', sel.style.italic, v => { sel.style.italic = v; inspectorChange(); }),
    toggle('Drop cap', sel.style.dropCap, v => { sel.style.dropCap = v; inspectorChange(); }),
  ));

  if (isDeco) {
    ins(section('LAYOUT',
      row(
        field('X %', input(sel.x ?? 20, v => { sel.x = v; inspectorChange(); }, 'number')),
        field('Y %', input(sel.y ?? 20, v => { sel.y = v; inspectorChange(); }, 'number')),
      ),
      row(
        field('W %', input(sel.w ?? 30, v => { sel.w = v; inspectorChange(); }, 'number')),
        field('Rotation°', input(sel.rotation ?? 0, v => { sel.rotation = v; inspectorChange(); }, 'number')),
      ),
    ));
  } else {
    ins(section('LAYOUT',
      field('Width % (max).', input(sel.w ?? 100, v => { sel.w = v; inspectorChange(); }, 'number')),
      toggle('Wrap neighbours', sel.wrapNeighbours, v => { sel.wrapNeighbours = v; inspectorChange(); }),
    ));
  }

  // Split button (visible while editing).
  if (state.editingTextId === sel.id) {
    ins(section('', btn('SPLIT AT CURSOR', () => splitTextAtCursor())));
  }
}

// Build a small segmented control. options: array of strings or {value,label}.
function segmented(values, current, onChange, options) {
  const wrap = document.createElement('div');
  wrap.className = 'studio-segmented';
  const opts = options || values.map(v => ({ value: v, label: String(v).toUpperCase() }));
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    if (String(o.value) === String(current)) b.classList.add('active');
    b.addEventListener('click', () => onChange(o.value));
    wrap.appendChild(b);
  }
  return wrap;
}

function renderImageInlineInspector(sel, ins) {
  if (state.crop && state.crop.id === sel.id) {
    renderCropInspector(sel, ins);
    return;
  }
  ins(section('PLACEMENT',
    field('Side.', select(sel.side || 'right', ['left', 'right'], v => { sel.side = v; inspectorChange(); })),
    field('Anchor after paragraph.', input(sel.anchor?.afterParagraph ?? 0, v => { sel.anchor = sel.anchor || {}; sel.anchor.afterParagraph = Math.max(0, Math.round(v)); inspectorChange(); }, 'number')),
  ));
  ins(section('SHAPE',
    row(
      field('Width %', input(sel.width ?? 38, v => { sel.width = v; inspectorChange(); }, 'number')),
      field('Rotation°', input(sel.rotation ?? 0, v => { sel.rotation = v; inspectorChange(); }, 'number')),
    ),
    row(
      field('Shape margin', input(sel.shapeMargin ?? 18, v => { sel.shapeMargin = v; inspectorChange(); }, 'number')),
      field('Threshold', input(sel.shapeThreshold ?? 0.35, v => { sel.shapeThreshold = v; inspectorChange(); }, 'number')),
    ),
    toggle('Specimen frame', sel.specimen, v => { sel.specimen = v; inspectorChange(); }),
  ));
  ins(section('', btn('CROP', () => enterCropMode())));
  renderCaptionEditor(sel, ins);
  ins(section('', btn('SWITCH TO DECORATIVE', () => switchImageType(sel, 'image-decorative'))));
}

function renderImageDecorativeInspector(sel, ins) {
  if (state.crop && state.crop.id === sel.id) {
    renderCropInspector(sel, ins);
    return;
  }
  ins(section('PLACEMENT',
    row(
      field('X %', input(sel.x ?? 20, v => { sel.x = v; inspectorChange(); }, 'number')),
      field('Y %', input(sel.y ?? 20, v => { sel.y = v; inspectorChange(); }, 'number')),
    ),
    row(
      field('W %', input(sel.w ?? 22, v => { sel.w = v; inspectorChange(); }, 'number')),
      field('Rotation°', input(sel.rotation ?? 0, v => { sel.rotation = v; inspectorChange(); }, 'number')),
    ),
    field('Opacity', input(sel.opacity ?? 1, v => { sel.opacity = v; inspectorChange(); }, 'number')),
  ));
  ins(section('BEHAVIOUR',
    field('Idle motion.', select(sel.idleMotion || 'none', ['none', 'float', 'wobble', 'spin-slow', 'parallax-mouse'], v => { sel.idleMotion = v; inspectorChange(); })),
    toggle('Draggable on the live page', sel.draggableAtRuntime, v => { sel.draggableAtRuntime = v; inspectorChange(); }),
  ));
  ins(section('', btn('CROP', () => enterCropMode())));
  renderCaptionEditor(sel, ins);
  ins(section('', btn('SWITCH TO INLINE', () => switchImageType(sel, 'image-inline'))));
}

// Caption editor (image-inline + image-decorative). Hero keeps its
// existing string caption and is not duplicated here.
function renderCaptionEditor(sel, ins) {
  if (sel.caption == null) {
    ins(section('CAPTION', btn('+ ADD CAPTION', () => {
      sel.caption = { content: 'CAPTION', style: { family: 'mono', size: 0.85, transform: 'uppercase', align: 'center' } };
      commitHistory(); rerender(); renderInspector();
    })));
    return;
  }
  sel.caption.style = sel.caption.style || {};
  const cap = sel.caption;
  ins(section('CAPTION',
    field('Content.', textarea(cap.content || '', v => { cap.content = v; inspectorChange(); })),
    row(
      field('Family.', select(cap.style.family || 'mono', ['mono', 'serif', 'display'], v => { cap.style.family = v; inspectorChange(); })),
      field('Size %', input(cap.style.size ?? 0.85, v => { cap.style.size = v; inspectorChange(); }, 'number')),
    ),
    row(
      field('Transform.', select(cap.style.transform || 'uppercase', ['none', 'uppercase'], v => { cap.style.transform = v; inspectorChange(); })),
      field('Align.', select(cap.style.align || 'center', ['left', 'center', 'right'], v => { cap.style.align = v; inspectorChange(); })),
    ),
    btn('REMOVE CAPTION', () => {
      sel.caption = null;
      commitHistory(); rerender(); renderInspector();
    }, { danger: true }),
  ));
}

// Crop-mode-only inspector. All other sections in the inspector body are
// dimmed via CSS (.crop-mode .studio-section:not(.crop-active)).
function renderCropInspector(sel, ins) {
  const sec = section('CROP',
    field('Crop in %', (() => {
      const w = document.createElement('div'); w.className = 'studio-helper';
      w.textContent = 'Drag the red bars to set the crop. Apply to commit, Cancel to revert. Esc cancels, Return applies.';
      return w;
    })()),
    row(
      btn('APPLY', () => exitCropMode(true)),
      btn('CANCEL', () => exitCropMode(false), { danger: true }),
    ),
    btn('RESET', () => resetCrop()),
  );
  sec.classList.add('crop-active');
  ins(sec);
}

function switchImageType(sel, newType) {
  const keep = {
    src: sel.src, cutSrc: sel.cutSrc, rotation: sel.rotation || 0,
    opacity: sel.opacity ?? 1,
    id: sel.id, z: sel.z, locked: sel.locked, hidden: sel.hidden,
    crop: sel.crop ?? null, caption: sel.caption ?? null,
  };
  for (const k of Object.keys(sel)) delete sel[k];
  Object.assign(sel, keep);
  sel.type = newType;
  if (newType === 'image-decorative') {
    sel.x = 20; sel.y = 20; sel.w = 22; sel.idleMotion = 'none'; sel.draggableAtRuntime = false;
  } else {
    sel.side = 'right'; sel.anchor = { afterParagraph: 1 }; sel.width = 30; sel.shapeMargin = 18; sel.shapeThreshold = 0.35; sel.specimen = false;
  }
  commitHistory(); rerender(); renderInspector(); renderLayers();
}

function renderMarqueeInspector(sel, ins) {
  ins(section('CONTENT',
    field('Content.', textarea(sel.content, v => { sel.content = v; inspectorChange(); })),
  ));
  ins(section('STYLE',
    row(
      field('Background.', select(sel.background || 'ink', ['ink', 'red', 'paper-2', 'transparent'], v => { sel.background = v; inspectorChange(); })),
      field('Color.', select(sel.color || 'paper', ['paper', 'ink', 'red'], v => { sel.color = v; inspectorChange(); })),
    ),
    row(
      field('Speed (s)', input(sel.speed ?? 38, v => { sel.speed = v; inspectorChange(); }, 'number')),
      field('Direction.', select(sel.direction || 'left', ['left', 'right'], v => { sel.direction = v; inspectorChange(); })),
    ),
    field('Y %', input(sel.y ?? 0, v => { sel.y = v; inspectorChange(); }, 'number')),
  ));
}

function renderHeroInspector(sel, ins) {
  ins(section('SOURCE',
    field('Image src.', input(sel.src, v => { sel.src = v; inspectorChange(); })),
    field('Caption.', input(sel.caption, v => { sel.caption = v; inspectorChange(); })),
  ));
  ins(section('STYLE',
    field('W %', input(sel.w ?? 60, v => { sel.w = v; inspectorChange(); }, 'number')),
    field('Idle motion.', select(sel.idleMotion || 'none', ['none', 'float', 'wobble', 'spin-slow', 'parallax-mouse'], v => { sel.idleMotion = v; inspectorChange(); })),
    toggle('Specimen frame', sel.specimen, v => { sel.specimen = v; inspectorChange(); }),
  ));
}

function renderSpecInspector(sel, ins) {
  sel.rows = sel.rows || [];
  const list = section('ROWS');
  ins(list);
  function rebuild() {
    while (list.children.length > 1) list.lastChild.remove();
    sel.rows.forEach((r, i) => {
      const wrap = document.createElement('div'); wrap.className = 'studio-spec-row';
      const lab = input(r.label, v => { r.label = v; inspectorChange(); });
      const val = input(r.value, v => { r.value = v; inspectorChange(); });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'studio-icon-btn'; del.textContent = '×';
      del.addEventListener('click', () => { sel.rows.splice(i, 1); commitHistory(); rerender(); rebuild(); });
      wrap.appendChild(lab); wrap.appendChild(val); wrap.appendChild(del);
      list.appendChild(wrap);
    });
    const add = btn('+ ADD ROW', () => { sel.rows.push({ label: 'LABEL', value: '' }); commitHistory(); rerender(); rebuild(); });
    list.appendChild(add);
  }
  rebuild();
}

function renderFieldInspector(sel, ins) {
  sel.action = sel.action || { type: 'mailto', to: '' };
  ins(section('FIELD',
    field('Placeholder.', input(sel.placeholder, v => { sel.placeholder = v; inspectorChange(); })),
    field('Button label.', input(sel.buttonLabel, v => { sel.buttonLabel = v; inspectorChange(); })),
  ));
  ins(section('ACTION',
    field('Action type.', select(sel.action.type || 'mailto', ['mailto', 'external', 'copy'], v => { sel.action.type = v; inspectorChange(); })),
    field('To / URL / Value.', input(sel.action.to || sel.action.url || sel.action.value || '', v => {
      const t = sel.action.type;
      if (t === 'mailto') sel.action.to = v;
      else if (t === 'external') sel.action.url = v;
      else if (t === 'copy') sel.action.value = v;
      inspectorChange();
    })),
  ));
}

function renderAsterismInspector(sel, ins) {
  const m = document.createElement('div'); m.className = 'studio-helper';
  m.textContent = 'A typographic break. No fields.';
  ins(m);
}

// ─── Layers panel ──────────────────────────────────────────────────

function renderLayers() {
  els.layersList.innerHTML = '';
  if (!state.pageData?.elements?.length) {
    const e = document.createElement('div'); e.className = 'studio-empty';
    e.textContent = 'No elements yet. Drop a PNG, or add one from the toolbar.';
    els.layersList.appendChild(e);
    return;
  }
  // Sort by z descending
  const sorted = [...state.pageData.elements].sort((a, b) => (b.z || 0) - (a.z || 0));
  for (const el of sorted) {
    const li = document.createElement('li');
    li.className = 'studio-layer-row';
    if (el.id === state.selectedId) li.classList.add('selected');
    if (el.hidden) li.classList.add('hidden');
    if (el.locked) li.classList.add('locked');
    // NOTE: row itself is NOT draggable. A single click on a draggable
    // element can fire `dragstart` instead of `click` (Chrome quirk),
    // which silently breaks selection. We add a dedicated drag handle.
    li.dataset.id = el.id;
    const drag = document.createElement('span');
    drag.className = 'studio-layer-drag';
    drag.textContent = '⠿';
    drag.title = 'Drag to reorder';
    drag.draggable = true;
    const glyph = document.createElement('span'); glyph.className = 'studio-layer-glyph';
    glyph.textContent = glyphFor(el.type);
    const lab = document.createElement('span'); lab.className = 'studio-layer-label';
    lab.textContent = labelFor(el).slice(0, 18);
    const eye = document.createElement('button'); eye.type = 'button'; eye.className = 'studio-layer-toggle' + (el.hidden ? '' : ' active');
    eye.textContent = el.hidden ? '·' : '◉'; eye.title = el.hidden ? 'Show' : 'Hide';
    eye.addEventListener('click', (ev) => { ev.stopPropagation(); el.hidden = !el.hidden; commitHistory(); rerender(); renderLayers(); });
    const lock = document.createElement('button'); lock.type = 'button'; lock.className = 'studio-layer-toggle' + (el.locked ? ' active' : '');
    lock.textContent = el.locked ? '⌧' : '○'; lock.title = el.locked ? 'Unlock' : 'Lock';
    lock.addEventListener('click', (ev) => { ev.stopPropagation(); el.locked = !el.locked; commitHistory(); renderLayers(); });
    li.appendChild(drag); li.appendChild(glyph); li.appendChild(lab); li.appendChild(eye); li.appendChild(lock);
    // Click anywhere on the row (except eye/lock/drag handle) selects.
    li.addEventListener('click', (ev) => {
      ev.stopPropagation();
      selectElement(el.id);
    });
    // Drag-and-drop reorder lives on the drag handle only.
    drag.addEventListener('dragstart', (ev) => {
      ev.stopPropagation();
      ev.dataTransfer.setData('text/plain', el.id);
      ev.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragover', (ev) => { ev.preventDefault(); li.classList.add('drag-over'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (ev) => {
      ev.preventDefault(); li.classList.remove('drag-over');
      const fromId = ev.dataTransfer.getData('text/plain');
      if (!fromId || fromId === el.id) return;
      reorderLayer(fromId, el.id);
    });
    els.layersList.appendChild(li);
  }
}
function glyphFor(t) {
  return ({ 'text': 'T', 'image-inline': 'I', 'image-decorative': 'D', 'marquee': 'M', 'hero-artifact': 'H', 'spec-sheet': 'S', 'single-field': 'F', 'asterism': '·' })[t] || '?';
}
function labelFor(el) {
  if (el.type === 'text') return (el.content || 'Text').replace(/<[^>]+>/g, '').slice(0, 18);
  if (el.type === 'image-inline' || el.type === 'image-decorative' || el.type === 'hero-artifact') return (el.src || '').split('/').pop() || el.type;
  if (el.type === 'marquee') return el.content || 'Marquee';
  if (el.type === 'spec-sheet') return `Spec, ${el.rows?.length || 0} rows`;
  if (el.type === 'single-field') return el.buttonLabel || 'Field';
  if (el.type === 'asterism') return 'Asterism';
  return el.type;
}
function reorderLayer(fromId, toId) {
  const a = state.pageData.elements.find(e => e.id === fromId);
  const b = state.pageData.elements.find(e => e.id === toId);
  if (!a || !b) return;
  const tmp = a.z; a.z = b.z; b.z = tmp;
  commitHistory(); rerender(); renderLayers();
}

// ─── Bank panel ────────────────────────────────────────────────────

function revokeBankUrls() {
  for (const u of state.bankObjectUrls) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  state.bankObjectUrls = [];
}

async function listImagesInDir(dirHandle, opts = {}) {
  // Returns [{ name, url, isCut }]. Walks the immediate dir entries only.
  const items = [];
  if (!dirHandle) return items;
  for await (const entry of dirHandle.values()) {
    if (entry.kind !== 'file') continue;
    const name = entry.name;
    if (!/\.(png|jpe?g)$/i.test(name)) continue;
    const isCut = /\.cut\.png$/i.test(name);
    if (opts.cutOnly && !isCut) continue;
    if (opts.preferCut) {
      // Filter out the original if a cut variant exists; we'll do a second pass.
    }
    try {
      const file = await entry.getFile();
      const url = URL.createObjectURL(file);
      state.bankObjectUrls.push(url);
      items.push({ name, url, isCut });
    } catch (e) { console.warn('bank listFile failed', name, e); }
  }
  return items;
}

async function refreshBankPage() {
  if (!els.bankGridPage) return;
  els.bankGridPage.innerHTML = '';
  if (!state.rootHandle || !state.currentSlug) {
    els.bankGridPage.appendChild(emptyBank('Pick a page to see its assets.'));
    return;
  }
  try {
    const pagesDir = await state.rootHandle.getDirectoryHandle('pages');
    const pageDir = await pagesDir.getDirectoryHandle(state.currentSlug);
    const assets = await pageDir.getDirectoryHandle('assets', { create: true });
    const all = await listImagesInDir(assets);
    // Prefer .cut.png variants; if a base hash has a cut, hide the original.
    const cutHashes = new Set(all.filter(a => a.isCut).map(a => a.name.replace(/\.cut\.png$/i, '')));
    const display = all.filter(a => {
      if (a.isCut) return true;
      const base = a.name.replace(/\.(png|jpe?g)$/i, '');
      return !cutHashes.has(base);
    });
    if (!display.length) {
      els.bankGridPage.appendChild(emptyBank('No assets yet. Drop a PNG to begin.'));
      return;
    }
    for (const item of display) {
      els.bankGridPage.appendChild(makeBankTile(item, 'page'));
    }
  } catch (e) {
    console.warn('refreshBankPage failed', e);
    els.bankGridPage.appendChild(emptyBank('Unable to read page assets.'));
  }
}

async function refreshBankStudio() {
  if (!els.bankGridStudio) return;
  els.bankGridStudio.innerHTML = '';
  if (!state.rootHandle) {
    els.bankGridStudio.appendChild(emptyBank('Connect a folder to read the studio bank.'));
    return;
  }
  try {
    const assetsDir = await state.rootHandle.getDirectoryHandle('assets', { create: true });
    const bankDir = await assetsDir.getDirectoryHandle('_bank', { create: true });
    const items = await listImagesInDir(bankDir);
    if (!items.length) {
      els.bankGridStudio.appendChild(emptyBank('Drop PNGs into assets/_bank/ from Finder. They appear here.'));
      return;
    }
    for (const item of items) {
      els.bankGridStudio.appendChild(makeBankTile(item, 'studio'));
    }
  } catch (e) {
    console.warn('refreshBankStudio failed', e);
    els.bankGridStudio.appendChild(emptyBank('Unable to read studio bank.'));
  }
}

async function refreshBank() {
  revokeBankUrls();
  await refreshBankPage(true);   // skip own revoke — refreshBank already did it
  await refreshBankStudio(true);
}

// Per-section refresh entry points used after multi-file drops etc.
// They must revoke their own URLs before rescanning, otherwise every
// drop leaks the previous tile blobs.
async function refreshBankPageSafe() {
  revokeBankUrls();
  await refreshBankPage(true);
  await refreshBankStudio(true);  // rebuild studio tiles too since revoke killed them
}

function emptyBank(msg) {
  const e = document.createElement('div');
  e.className = 'studio-bank-empty';
  e.textContent = msg;
  return e;
}

function makeBankTile(item, source) {
  const tile = document.createElement('div');
  tile.className = 'studio-bank-tile';
  tile.draggable = true;
  const img = document.createElement('img');
  img.className = 'studio-bank-tile-img';
  img.src = item.url;
  img.alt = item.name;
  const lab = document.createElement('div');
  lab.className = 'studio-bank-tile-name';
  const baseName = item.name.replace(/\.(cut\.png|png|jpe?g)$/i, '');
  lab.textContent = baseName.slice(0, 14);
  tile.appendChild(img);
  tile.appendChild(lab);
  tile.title = item.name;
  // Drag payload: encode source + filename so we can resolve the asset path on drop.
  tile.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.effectAllowed = 'copy';
    const payload = JSON.stringify({ source, name: item.name, alt: ev.altKey });
    ev.dataTransfer.setData('application/x-rkk-bank', payload);
    ev.dataTransfer.setData('text/plain', payload);
    tile._dragAlt = ev.altKey;
  });
  return tile;
}

// Stage drop: also handle bank-tile drags (insert by reference).
els.stage.addEventListener('drop', async (e) => {
  // The earlier drop listener handles file drops. This one handles bank.
  // We must not double-insert: bank drags carry no files.
  if (e.dataTransfer.files && e.dataTransfer.files.length) return;
  const data = e.dataTransfer.getData('application/x-rkk-bank') || e.dataTransfer.getData('text/plain');
  if (!data || !data.startsWith('{')) return;
  e.preventDefault();
  els.stage.classList.remove('is-dropping');
  let payload; try { payload = JSON.parse(data); } catch { return; }
  if (!payload || !payload.name) return;
  const isAlt = e.altKey || payload.alt;
  await insertFromBank(payload, { decorative: isAlt, dropX: e.clientX, dropY: e.clientY });
});

async function insertFromBank(payload, opts) {
  if (!state.pageData) { alert('Pick a page first.'); return; }
  // Resolve asset path. PAGE source: /pages/<slug>/assets/<name>; STUDIO: /assets/_bank/<name>.
  let src, cutSrc;
  if (payload.source === 'page') {
    const dir = `/pages/${state.currentSlug}/assets`;
    if (/\.cut\.png$/i.test(payload.name)) {
      cutSrc = `${dir}/${payload.name}`;
      const base = payload.name.replace(/\.cut\.png$/i, '');
      // Prefer .png as original; fall back to .jpg.
      src = `${dir}/${base}.png`;
    } else {
      src = `${dir}/${payload.name}`;
      cutSrc = src;
    }
  } else {
    src = `/assets/_bank/${payload.name}`;
    cutSrc = src;
  }
  let newEl;
  if (opts.decorative) {
    // Compute relative drop position vs. canvas.
    const canvas = els.pageRoot.querySelector('.rkk-canvas') || els.pageRoot;
    const cRect = canvas.getBoundingClientRect();
    const xPct = Math.max(0, Math.min(95, ((opts.dropX - cRect.left) / cRect.width) * 100));
    const yPct = Math.max(0, Math.min(95, ((opts.dropY - cRect.top)  / cRect.width) * 100));
    newEl = {
      id: uid('dec'), type: 'image-decorative', z: nextZ(),
      locked: false, hidden: false,
      sectionId: state.focusedSectionId || state.pageData.sections?.[0]?.id || null,
      src, cutSrc,
      x: Math.round(xPct * 10) / 10, y: Math.round(yPct * 10) / 10,
      w: 22, rotation: 0, opacity: 1,
      draggableAtRuntime: false, idleMotion: 'none',
      crop: null, caption: null,
    };
  } else {
    newEl = {
      id: uid('img'), type: 'image-inline', z: nextZ(),
      locked: false, hidden: false,
      sectionId: state.focusedSectionId || state.pageData.sections?.[0]?.id || null,
      src, cutSrc,
      side: 'right', anchor: { afterParagraph: 1 },
      width: 38, rotation: 0, shapeMargin: 18, shapeThreshold: 0.35,
      specimen: false, crop: null, caption: null,
    };
  }
  state.pageData.elements.push(newEl);
  commitHistory();
  await rerender();
  selectElement(newEl.id);
}

// ─── Section library ──────────────────────────────────────────────

function openSectionPicker() {
  if (!els.sectionPicker || !els.sectionPickerGrid) return;
  els.sectionPickerGrid.innerHTML = '';
  for (const sec of SECTIONS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'studio-section-card';
    const lab = document.createElement('div');
    lab.className = 'studio-section-card-label';
    lab.textContent = sec.label;
    const desc = document.createElement('div');
    desc.className = 'studio-section-card-desc';
    desc.textContent = sec.description;
    const prev = document.createElement('div');
    prev.className = 'studio-section-card-preview';
    prev.textContent = sec.preview || '';
    card.appendChild(lab); card.appendChild(desc); card.appendChild(prev);
    card.addEventListener('click', () => insertSection(sec));
    els.sectionPickerGrid.appendChild(card);
  }
  els.sectionPicker.hidden = false;
  els.sectionPicker.setAttribute('aria-hidden', 'false');
}
function closeSectionPicker() {
  if (!els.sectionPicker) return;
  els.sectionPicker.hidden = true;
  els.sectionPicker.setAttribute('aria-hidden', 'true');
}

function insertSection(sec) {
  if (!state.pageData) { alert('Pick a page first.'); closeSectionPicker(); return; }
  const built = sec.build();
  if (!Array.isArray(built) || !built.length) { closeSectionPicker(); return; }
  // Cascade: offset y so successive sections don't pile. Compute baseline
  // from existing decoratives to find a free slot.
  const existingDecoYs = state.pageData.elements
    .filter(e => e.type === 'image-decorative' || (e.type === 'text' && e.mode === 'decorative'))
    .map(e => Number(e.y) || 0);
  const baseY = existingDecoYs.length ? Math.max(...existingDecoYs) + 32 : 0;
  let firstId = null;
  let z = nextZ();
  const targetSection = state.focusedSectionId || state.pageData.sections[state.pageData.sections.length - 1].id;
  for (const elDef of built) {
    elDef.id = uid(elDef.type === 'asterism' ? 'ast' : elDef.type.slice(0, 3));
    elDef.z = z++;
    elDef.sectionId = targetSection;
    if (elDef.y != null && (elDef.type === 'image-decorative' || (elDef.type === 'text' && elDef.mode === 'decorative'))) {
      elDef.y = (Number(elDef.y) || 0) + baseY;
    }
    state.pageData.elements.push(elDef);
    if (!firstId) firstId = elDef.id;
  }
  commitHistory();
  rerender();
  closeSectionPicker();
  if (firstId) selectElement(firstId);
}

// ─── Crop tool ─────────────────────────────────────────────────────

function enterCropMode() {
  const sel = getSelected();
  if (!sel) return;
  if (sel.type !== 'image-inline' && sel.type !== 'image-decorative' && sel.type !== 'hero-artifact') return;
  const entry = sel.crop ? clone(sel.crop) : { left: 0, top: 0, right: 0, bottom: 0 };
  state.crop = { id: sel.id, entryCrop: entry, currentCrop: clone(entry) };
  document.body.classList.add('crop-mode');
  drawCropOverlay();
  renderInspector();
}

function exitCropMode(commit) {
  const sel = state.pageData?.elements?.find(x => x.id === state.crop?.id);
  if (sel) {
    if (commit) {
      const c = state.crop.currentCrop;
      if (c.left || c.top || c.right || c.bottom) sel.crop = c;
      else sel.crop = null;
      // Clear cached alpha/mask so the chrome reflects the new crop.
      try { clearCache(sel.cutSrc); } catch {}
      try { clearCache(sel.src); } catch {}
      commitHistory();
    } else {
      sel.crop = state.crop.entryCrop && (state.crop.entryCrop.left || state.crop.entryCrop.top || state.crop.entryCrop.right || state.crop.entryCrop.bottom)
        ? state.crop.entryCrop : null;
    }
  }
  state.crop = null;
  document.body.classList.remove('crop-mode');
  els.overlay.innerHTML = '';
  // Rerender (async) and refresh chrome AFTER the new DOM is in place so
  // the bounding box snaps to the cropped rectangle immediately.
  rerender().then(() => refreshSelectionChrome());
  renderInspector();
}

function resetCrop() {
  if (!state.crop) return;
  state.crop.currentCrop = { left: 0, top: 0, right: 0, bottom: 0 };
  drawCropOverlay();
}

function drawCropOverlay() {
  els.overlay.innerHTML = '';
  if (!state.crop) return;
  const sel = state.pageData?.elements?.find(x => x.id === state.crop.id);
  if (!sel) return;
  const node = findRenderedNode(sel.id);
  if (!node) return;
  const measureNode = node.tagName === 'IMG' ? node : (node.querySelector('img') || node);
  const cRect = els.stageScroll.getBoundingClientRect();
  const r = measureNode.getBoundingClientRect();
  const x = r.left - cRect.left + els.stageScroll.scrollLeft;
  const y = r.top  - cRect.top  + els.stageScroll.scrollTop;
  const w = r.width, h = r.height;
  const c = state.crop.currentCrop;
  const cx = x + w * (c.left / 100);
  const cy = y + h * (c.top / 100);
  const cw = w * (1 - (c.left + c.right) / 100);
  const ch = h * (1 - (c.top + c.bottom) / 100);

  const wrap = document.createElement('div');
  wrap.className = 'studio-crop-overlay';
  // Mask: 4 rectangles around the crop area.
  const masks = [
    { left: x, top: y, width: w, height: cy - y },                 // top
    { left: x, top: cy + ch, width: w, height: (y + h) - (cy + ch) }, // bottom
    { left: x, top: cy, width: cx - x, height: ch },               // left
    { left: cx + cw, top: cy, width: (x + w) - (cx + cw), height: ch }, // right
  ];
  for (const m of masks) {
    const d = document.createElement('div');
    d.className = 'studio-crop-mask';
    d.style.left = `${m.left}px`; d.style.top = `${m.top}px`;
    d.style.width = `${Math.max(0, m.width)}px`;
    d.style.height = `${Math.max(0, m.height)}px`;
    wrap.appendChild(d);
  }
  // Frame (dashed paper-color line).
  const frame = document.createElement('div');
  frame.className = 'studio-crop-frame';
  frame.style.left = `${cx}px`; frame.style.top = `${cy}px`;
  frame.style.width = `${cw}px`; frame.style.height = `${ch}px`;
  wrap.appendChild(frame);
  // Edge bars.
  const bars = [
    { side: 'top',    cls: 'h', left: cx, top: cy, width: cw, height: 2 },
    { side: 'bottom', cls: 'h', left: cx, top: cy + ch - 2, width: cw, height: 2 },
    { side: 'left',   cls: 'v', left: cx, top: cy, width: 2, height: ch },
    { side: 'right',  cls: 'v', left: cx + cw - 2, top: cy, width: 2, height: ch },
  ];
  for (const b of bars) {
    const d = document.createElement('div');
    d.className = `studio-crop-bar ${b.cls}`;
    d.style.left = `${b.left}px`; d.style.top = `${b.top}px`;
    d.style.width = `${b.width}px`; d.style.height = `${b.height}px`;
    d.dataset.side = b.side;
    d.addEventListener('pointerdown', (ev) => beginCropDrag(ev, b.side, x, y, w, h));
    wrap.appendChild(d);
  }
  // Mid-handles.
  const mids = [
    { side: 'top',    cls: 't', left: cx + cw / 2, top: cy },
    { side: 'bottom', cls: 'b', left: cx + cw / 2, top: cy + ch },
    { side: 'left',   cls: 'l', left: cx,          top: cy + ch / 2 },
    { side: 'right',  cls: 'r', left: cx + cw,     top: cy + ch / 2 },
  ];
  for (const m of mids) {
    const d = document.createElement('div');
    d.className = `studio-crop-handle ${m.cls}`;
    d.style.left = `${m.left}px`; d.style.top = `${m.top}px`;
    d.addEventListener('pointerdown', (ev) => beginCropDrag(ev, m.side, x, y, w, h));
    wrap.appendChild(d);
  }
  els.overlay.appendChild(wrap);
}

function beginCropDrag(ev, side, x, y, w, h) {
  ev.preventDefault();
  const startX = ev.clientX, startY = ev.clientY;
  const startCrop = clone(state.crop.currentCrop);
  function move(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dxPct = (dx / w) * 100;
    const dyPct = (dy / h) * 100;
    const c = clone(startCrop);
    if (side === 'left')   c.left   = Math.max(0, Math.min(100 - c.right - 1,  c.left   + dxPct));
    if (side === 'right')  c.right  = Math.max(0, Math.min(100 - c.left  - 1,  c.right  - dxPct));
    if (side === 'top')    c.top    = Math.max(0, Math.min(100 - c.bottom - 1, c.top    + dyPct));
    if (side === 'bottom') c.bottom = Math.max(0, Math.min(100 - c.top    - 1, c.bottom - dyPct));
    state.crop.currentCrop = c;
    drawCropOverlay();
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ─── Split text block at cursor ──────────────────────────────────

function splitTextAtCursor() {
  const sel = getSelected();
  if (!sel || sel.type !== 'text') return;
  const node = findRenderedNode(sel.id);
  if (!node) return;
  // Locate cursor (range start) within node.
  const win = window.getSelection();
  if (!win || win.rangeCount === 0) return;
  const range = win.getRangeAt(0);
  if (!node.contains(range.startContainer)) return;
  // Build before/after HTML by snapshotting innerHTML and slicing at the range.
  // We use a simple text-offset model: walk text nodes, split where the range starts.
  const beforeRange = document.createRange();
  beforeRange.setStart(node, 0);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = document.createRange();
  afterRange.setStart(range.startContainer, range.startOffset);
  afterRange.setEnd(node, node.childNodes.length);

  const beforeFrag = beforeRange.cloneContents();
  const afterFrag  = afterRange.cloneContents();
  const tmpA = document.createElement('div'); tmpA.appendChild(beforeFrag);
  const tmpB = document.createElement('div'); tmpB.appendChild(afterFrag);
  // Strip any planted floats so they don't get baked into the split halves.
  for (const tmp of [tmpA, tmpB]) {
    tmp.querySelectorAll('.rkk-float, .rkk-image-inline, .studio-paragraph-guide, .rkk-image-deco-fig').forEach(n => n.remove());
  }

  // Reconstruct paragraph-source format from each fragment.
  function fragToSource(div) {
    const paras = div.querySelectorAll(':scope > .rkk-p');
    if (paras.length) return Array.from(paras).map(p => p.innerHTML.trim()).filter(Boolean).join('\n\n');
    return div.innerHTML.trim();
  }
  const beforeContent = fragToSource(tmpA);
  const afterContent  = fragToSource(tmpB);
  if (!beforeContent && !afterContent) return;

  sel.content = beforeContent || ' ';
  // Clone for second block.
  const second = clone(sel);
  second.id = uid('txt');
  second.content = afterContent || ' ';
  second.z = nextZ();
  if (second.mode === 'decorative') {
    second.y = (Number(second.y) || 0) + 5;
  }
  // Insert at index N+1 of pageData.elements.
  const idx = state.pageData.elements.findIndex(x => x.id === sel.id);
  if (idx < 0) state.pageData.elements.push(second);
  else state.pageData.elements.splice(idx + 1, 0, second);
  // Pre-set editingTextId so attachContenteditableHooks (which runs during
  // rerender) preserves edit mode on the new block instead of flipping it
  // back to non-editable.
  state.editingTextId = second.id;
  commitHistory();
  rerender().then(() => {
    selectElement(second.id);
    // Auto-focus the new element.
    setTimeout(() => {
      const newNode = findRenderedNode(second.id);
      if (newNode) {
        newNode.contentEditable = 'true';
        newNode.focus?.();
        if (els.overlay) els.overlay.classList.add('studio-editing');
        // Place caret at start.
        const r = document.createRange();
        r.setStart(newNode, 0); r.collapse(true);
        const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r);
        state.editingTextId = second.id;
        renderInspector();
      }
    }, 16);
  });
}

// ─── Keyboard ──────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Allow typing in inputs
  const tag = (e.target.tagName || '').toLowerCase();
  const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  const meta = e.metaKey || e.ctrlKey;

  // Crop mode bindings (highest priority).
  if (state.crop) {
    if (e.key === 'Escape') { e.preventDefault(); exitCropMode(false); return; }
    if (e.key === 'Enter')  { e.preventDefault(); exitCropMode(true); return; }
    return;
  }

  // Cmd+Enter on a contenteditable text element triggers split.
  if (meta && e.key === 'Enter' && e.target.isContentEditable) {
    const sel = getSelected();
    if (sel && sel.type === 'text') {
      e.preventDefault();
      splitTextAtCursor();
      return;
    }
  }

  if (meta && e.key === 's') { e.preventDefault(); saveNow(); return; }
  if (meta && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (meta && ((e.key === 'z' || e.key === 'Z') && e.shiftKey || e.key === 'y')) { e.preventDefault(); redo(); return; }
  if (meta && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); return; }
  if (meta && (e.key === 'c' || e.key === 'C')) {
    // Don't intercept when copying selected text inside contenteditable.
    if (e.target.isContentEditable) return;
    e.preventDefault(); copySelection(); return;
  }
  if (meta && (e.key === 'x' || e.key === 'X')) {
    if (e.target.isContentEditable) return;
    e.preventDefault(); copySelection(); deleteSelection(); return;
  }
  if (meta && (e.key === 'v' || e.key === 'V')) {
    if (e.target.isContentEditable) return;
    e.preventDefault(); pasteClipboard(); return;
  }
  if (meta && (e.key === 'a' || e.key === 'A')) {
    if (e.target.isContentEditable) return;
    e.preventDefault(); selectAllInFocusedSection(); return;
  }
  // Escape inside an editable text/caption: exit edit mode but stay selected.
  // Checked BEFORE the inField guard so it fires while the contenteditable
  // node has focus.
  if (e.key === 'Escape' && state.editingTextId) {
    e.preventDefault();
    exitTextEditMode();
    return;
  }
  if (inField) return;
  if (e.key === 'Escape') {
    if (els.sectionPicker && !els.sectionPicker.hidden) { closeSectionPicker(); return; }
    deselect(); return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedIds.length) {
      e.preventDefault();
      deleteSelection();
    }
    return;
  }
  if (e.key.startsWith('Arrow')) {
    const all = getSelectedAll();
    if (!all.length) return;
    const step = e.shiftKey ? 5 : 0.5;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    if (e.key === 'ArrowRight') dx = step;
    if (e.key === 'ArrowUp') dy = -step;
    if (e.key === 'ArrowDown') dy = step;
    let moved = false;
    for (const sel of all) {
      if (sel.locked) continue;
      // Promote flow elements on first keyboard nudge.
      promoteToAbsolute(sel);
      if (sel.x != null || sel.y != null || sel.type === 'image-decorative' ||
          (sel.type === 'text' && sel.mode === 'decorative') || sel.positioned) {
        sel.x = (sel.x ?? 0) + dx;
        sel.y = (sel.y ?? 0) + dy;
        moved = true;
      }
    }
    if (moved) {
      e.preventDefault();
      scheduleRerender(); commitHistory();
    }
  }
});

// ─── Clipboard / duplicate / delete (group-aware) ─────────────────

function duplicateSelected() {
  const all = getSelectedAll();
  if (!all.length) return;
  const newIds = [];
  for (const sel of all) {
    const copy = clone(sel);
    copy.id = uid(sel.type.slice(0, 3));
    copy.z = nextZ();
    if (copy.x != null) copy.x += 2;
    if (copy.y != null) copy.y += 2;
    state.pageData.elements.push(copy);
    newIds.push(copy.id);
  }
  state.selectedId = newIds[newIds.length - 1] || null;
  state.selectedIds = newIds;
  commitHistory(); rerender(); refreshSelectionChrome(); renderInspector(); renderLayers();
}

function copySelection() {
  const all = getSelectedAll();
  if (!all.length) return;
  state.clipboard = { elements: all.map(clone) };
  showStudioToast(`Copied ${all.length} element${all.length === 1 ? '' : 's'}`);
}

function pasteClipboard() {
  if (!state.clipboard?.elements?.length) return;
  const targetSection = state.focusedSectionId ||
    state.pageData.sections[state.pageData.sections.length - 1].id;
  const newIds = [];
  for (const src of state.clipboard.elements) {
    const copy = clone(src);
    copy.id = uid(src.type.slice(0, 3));
    copy.z = nextZ();
    copy.sectionId = targetSection;
    if (copy.x != null) copy.x += 2;
    if (copy.y != null) copy.y += 2;
    state.pageData.elements.push(copy);
    newIds.push(copy.id);
  }
  state.selectedId = newIds[newIds.length - 1] || null;
  state.selectedIds = newIds;
  commitHistory(); rerender(); refreshSelectionChrome(); renderInspector(); renderLayers();
}

function deleteSelection() {
  if (!state.selectedIds.length) return;
  const ids = new Set(state.selectedIds);
  state.pageData.elements = state.pageData.elements.filter(e => !ids.has(e.id));
  state.selectedId = null;
  state.selectedIds = [];
  commitHistory(); rerender(); renderInspector(); renderLayers();
}

function selectAllInFocusedSection() {
  if (!state.pageData) return;
  const sid = state.focusedSectionId || state.pageData.sections[0].id;
  const ids = state.pageData.elements.filter(e => e.sectionId === sid).map(e => e.id);
  if (!ids.length) return;
  state.selectedIds = ids;
  state.selectedId = ids[ids.length - 1];
  refreshSelectionChrome();
  renderInspector();
  renderLayers();
}

// ─── Click-on-empty deselect ───────────────────────────────────────

// Click anywhere in the stage that doesn't land on a rendered element
// (no [data-element-id] ancestor) deselects. The overlay is
// pointer-events: none on the container, so transparent regions of the
// chrome pass through to whatever is below; only the handles/ring/rotation
// are interactive.
els.stageScroll.addEventListener('click', (e) => {
  // Don't deselect when the click was on an interactive piece of the
  // selection chrome — handles, ring, rotation handle, paragraph guide.
  // Also: don't deselect when interacting with section UI (pill, bar, add).
  if (e.target.closest && (
      e.target.closest('.studio-handle') ||
      e.target.closest('.studio-rotation-handle') ||
      e.target.closest('.studio-sel-ring') ||
      e.target.closest('.studio-crop-bar') ||
      e.target.closest('.studio-crop-handle') ||
      e.target.closest('.studio-section-pill') ||
      e.target.closest('.studio-section-bar') ||
      e.target.closest('.studio-section-add') ||
      e.target.closest('.studio-section-tail-add') ||
      e.target.closest('.studio-group-box')
    )) return;
  // If we're currently editing text, the FIRST click outside the editing
  // node exits edit mode but keeps the element selected. The second click
  // outside (now state.editingTextId is null) falls through to deselect.
  if (state.editingTextId) {
    const editingNode = els.pageRoot.querySelector(
      `[data-element-id="${CSS.escape(state.editingTextId)}"]`
    );
    if (!editingNode || !e.target.closest || !editingNode.contains(e.target)) {
      exitTextEditMode();
      return;
    }
  }
  if (!e.target.closest || !e.target.closest('[data-element-id]')) {
    deselect();
  }
});

// ─── Toolbar wiring ────────────────────────────────────────────────

els.btnConnect.addEventListener('click', async () => {
  try {
    state.rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbSet('rootHandle', state.rootHandle);
    await loadProject();
    if (state.pages.length) await loadPage(state.pages[0].slug);
  } catch (e) { console.warn('Folder picker cancelled', e); }
});

els.btnNewPage.addEventListener('click', () => createNewPage());

els.pagePicker.addEventListener('change', () => {
  const slug = els.pagePicker.value;
  if (slug) loadPage(slug);
});

for (const b of els.addControls.querySelectorAll('[data-add]')) {
  b.addEventListener('click', () => addElement(b.dataset.add));
}

els.btnUndo.addEventListener('click', undo);
els.btnRedo.addEventListener('click', redo);

els.btnView.addEventListener('click', () => {
  const isPreview = document.body.classList.toggle('preview-mode');
  state.mode = isPreview ? 'view' : 'edit';
  els.btnView.setAttribute('aria-pressed', isPreview ? 'true' : 'false');
  els.btnView.textContent = isPreview ? 'EDIT' : 'PREVIEW';
  rerender();
});

// Viewport preview toggle: constrains the stage's max-width so the user
// can verify how a composition reflows at each breakpoint (phone /
// tablet / desktop) without resizing the browser window. The CSS rules
// in render.css are already viewport-aware (3 breakpoints); this just
// triggers them in-studio. After switching, selection chrome is refreshed
// because rendered element rects have moved.
for (const id of ['btn-vp-desktop', 'btn-vp-tablet', 'btn-vp-phone']) {
  const b = document.getElementById(id);
  if (!b) continue;
  b.addEventListener('click', () => {
    const vp = b.dataset.vp;
    document.querySelectorAll('.studio-vp-btn').forEach(x => x.classList.toggle('is-active', x === b));
    els.stage.classList.remove('vp-desktop', 'vp-tablet', 'vp-phone');
    els.stage.classList.add('vp-' + vp);
    refreshSelectionChrome();
  });
}

els.btnLayersToggle?.addEventListener('click', () => {
  state.layersCollapsed = !state.layersCollapsed;
  els.shell.classList.toggle('layers-collapsed', state.layersCollapsed);
  els.btnLayersToggle.textContent = state.layersCollapsed ? '›' : '‹';
});

// Bank refresh buttons.
els.btnBankRefreshPage?.addEventListener('click', () => { revokeBankUrls(); refreshBank(); });
els.btnBankRefreshStudio?.addEventListener('click', () => { revokeBankUrls(); refreshBank(); });

// Section picker.
els.btnSection?.addEventListener('click', () => {
  if (els.sectionPicker.hidden) openSectionPicker();
  else closeSectionPicker();
});
els.btnSectionPickerClose?.addEventListener('click', () => closeSectionPicker());
// Click outside the picker closes it.
document.addEventListener('mousedown', (e) => {
  if (!els.sectionPicker || els.sectionPicker.hidden) return;
  if (els.sectionPicker.contains(e.target)) return;
  if (els.btnSection && els.btnSection.contains(e.target)) return;
  closeSectionPicker();
});

// ─── Boot ──────────────────────────────────────────────────────────

(async function boot() {
  setSaveState('idle');
  // Try to restore folder handle
  try {
    const handle = await idbGet('rootHandle');
    if (handle) {
      state.rootHandle = handle;
      const ok = await ensurePermission(handle);
      if (ok) {
        await loadProject();
        if (state.pages.length) await loadPage(state.pages[0].slug);
      }
    }
  } catch (e) { console.warn('Restore handle failed', e); }
  if (!state.pageData) {
    renderInspector();
    renderLayers();
  }
})();
