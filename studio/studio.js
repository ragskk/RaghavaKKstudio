// ───────────────────────────────────────────────────────────────────
// RKK Studio · Editor · v2
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
  selectedId: null,
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
  return {
    version: 1,
    slug,
    title: slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    dropNumber: '00',
    section: '',
    canvas: { background: 'paper', maxWidth: 1480, minHeight: 100 },
    cursor: 'default',
    signature: 'none',
    elements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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
      selectElement(data.id);
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
  refreshSelectionChrome();
  renderInspector();
}

// ─── Selection ─────────────────────────────────────────────────────

function selectElement(id) {
  state.selectedId = id;
  refreshSelectionChrome();
  renderInspector();
  renderLayers();
}

function deselect() {
  state.selectedId = null;
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

function findRenderedNode(id) {
  if (!id) return null;
  return els.pageRoot.querySelector(`[data-element-id="${CSS.escape(id)}"]`);
}

async function refreshSelectionChrome() {
  els.overlay.innerHTML = '';
  if (state.mode !== 'edit' || !state.selectedId) return;
  if (state.crop) return; // crop mode owns the overlay
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
    } else if (sel.cutSrc || sel.src) {
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

  const ring = document.createElement('div');
  ring.className = 'studio-sel-ring';
  ring.style.left = `${x}px`; ring.style.top = `${y}px`;
  ring.style.width = `${w}px`; ring.style.height = `${h}px`;
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
    node2.addEventListener('pointerdown', (e) => beginResize(e, h2));
    els.overlay.appendChild(node2);
  }
  // Rotation stem & handle
  const stem = document.createElement('div');
  stem.className = 'studio-rotation-stem';
  stem.style.left = `${x + w / 2}px`;
  stem.style.top = `${y - 22}px`;
  stem.style.height = '22px';
  els.overlay.appendChild(stem);
  const rotH = document.createElement('div');
  rotH.className = 'studio-rotation-handle';
  rotH.style.left = `${x + w / 2}px`;
  rotH.style.top = `${y - 28}px`;
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

// Recompute on scroll/resize
window.addEventListener('resize', () => { refreshSelectionChrome(); });
els.stageScroll.addEventListener('scroll', () => { refreshSelectionChrome(); }, { passive: true });

// ─── Drag / move / resize / rotate ────────────────────────────────

function pageWidthPx() {
  const root = els.pageRoot.querySelector('.rkk-canvas') || els.pageRoot;
  return root.getBoundingClientRect().width || 1;
}

function beginMove(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const sel = getSelected(); if (!sel) return;
  if (sel.locked) return;
  const startX = ev.clientX, startY = ev.clientY;
  const wPx = pageWidthPx();
  const orig = clone(sel);
  const liveNode = findRenderedNode(sel.id);
  const guide = document.createElement('div');
  guide.className = 'studio-paragraph-guide';
  let usingGuide = false;
  function move(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dxPct = (dx / wPx) * 100;
    const dyPct = (dy / wPx) * 100;
    const textIsDeco = sel.type === 'text' && sel.mode === 'decorative';
    if (sel.type === 'image-decorative' || textIsDeco) {
      sel.x = (orig.x ?? 0) + dxPct;
      sel.y = (orig.y ?? 0) + dyPct;
      // Cheap direct DOM update — avoid full rerender during drag.
      if (liveNode) {
        liveNode.style.left = `${sel.x}%`;
        liveNode.style.top = `${sel.y}%`;
      }
    } else if (sel.type === 'image-inline') {
      // Drop guide based on which paragraph the cursor is over.
      // Anchor change is recorded in JSON now, but we DON'T rerender mid-drag —
      // floats are anchored in flow and can only commit on release.
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const para = target?.closest?.('.rkk-p');
      if (para) {
        const idx = parseInt(para.dataset.paraIndex || '0', 10);
        sel.anchor = sel.anchor || {};
        sel.anchor.afterParagraph = idx;
        // Show guide
        const cRect = els.stageScroll.getBoundingClientRect();
        const pRect = para.getBoundingClientRect();
        guide.style.left = `${pRect.left - cRect.left + els.stageScroll.scrollLeft}px`;
        guide.style.top = `${pRect.top - cRect.top + els.stageScroll.scrollTop}px`;
        guide.style.width = `${pRect.width}px`;
        if (!usingGuide) { els.overlay.appendChild(guide); usingGuide = true; }
      }
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
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
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
    // No refreshSelectionChrome here — too expensive at 60+ Hz.
  }
  function up() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    readout.remove();
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
  const base = { id: uid(type === 'asterism' ? 'ast' : type.slice(0, 3)), type, z: nextZ(), locked: false, hidden: false };
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
  state.pageData.elements.push(e);
  commitHistory();
  rerender();
  selectElement(e.id);
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
  const sel = getSelected();
  if (!sel) { els.inspectorTitle.textContent = 'PAGE'; renderPageInspector(); return; }
  els.inspectorTitle.textContent = sel.type.replace(/-/g, ' ').toUpperCase();
  const ins = (n) => els.inspectorBody.appendChild(n);
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
      field('Size %', input(sel.style.size ?? 1.2, v => { sel.style.size = v; inspectorChange(); }, 'number')),
      field('Weight', input(sel.style.weight ?? 400, v => { sel.style.weight = v; inspectorChange(); }, 'number')),
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
  for (const elDef of built) {
    elDef.id = uid(elDef.type === 'asterism' ? 'ast' : elDef.type.slice(0, 3));
    elDef.z = z++;
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
    const sel = getSelected();
    if (sel) {
      const idx = state.pageData.elements.findIndex(x => x.id === sel.id);
      if (idx >= 0) {
        state.pageData.elements.splice(idx, 1);
        state.selectedId = null;
        commitHistory(); rerender(); renderInspector(); renderLayers();
      }
    }
  }
  if (e.key.startsWith('Arrow')) {
    const sel = getSelected();
    if (!sel) return;
    const step = e.shiftKey ? 5 : 0.5;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step;
    if (e.key === 'ArrowRight') dx = step;
    if (e.key === 'ArrowUp') dy = -step;
    if (e.key === 'ArrowDown') dy = step;
    const textIsDeco = sel.type === 'text' && sel.mode === 'decorative';
    if (sel.type === 'image-decorative' || textIsDeco) {
      sel.x = (sel.x ?? 0) + dx;
      sel.y = (sel.y ?? 0) + dy;
      e.preventDefault();
      scheduleRerender(); commitHistory();
    }
  }
});

function duplicateSelected() {
  const sel = getSelected(); if (!sel) return;
  const copy = clone(sel);
  copy.id = uid(sel.type.slice(0, 3));
  copy.z = nextZ();
  if (copy.x != null) copy.x += 2;
  if (copy.y != null) copy.y += 2;
  state.pageData.elements.push(copy);
  commitHistory(); rerender(); selectElement(copy.id);
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
  if (e.target.closest && (
      e.target.closest('.studio-handle') ||
      e.target.closest('.studio-rotation-handle') ||
      e.target.closest('.studio-sel-ring') ||
      e.target.closest('.studio-crop-bar') ||
      e.target.closest('.studio-crop-handle')
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
