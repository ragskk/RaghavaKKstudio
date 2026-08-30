/* ───────────────────────────────────────────────────────────
   RAGHAVA KK · LINEAGE · renderer
   Reads window.LINEAGE (data/lineage.js) and draws the board:
   series plates on a graphite spine, personal events above,
   professional events below, arrows between. Also writes the
   readable ledger under the board. No dependencies.
   ─────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const DATA = window.LINEAGE;
  if (!DATA) return;

  /* ── geometry ── */
  const Y0 = 1984, Y1 = 2027;            // axis span
  // fisheye time: the studio's dense decade gets more room per year
  const SEG = [[1984, 2007, 62], [2007, 2013, 100], [2013, 2027, 168]];
  const PAD_L = 150, PAD_R = 220;
  const H = 900;
  const SPINE_Y = 446;
  const BAND = {                         // event bands, lanes grow away from the spine
    personal:     { from: 304, dir: -1, min: 46 },
    professional: { from: 588, dir: +1, min: 850 },
  };
  const LANE_H = 50;
  const AXIS_Y = 868;

  const xOf = (y) => {
    let x = PAD_L;
    for (const [a, b, px] of SEG) { if (y <= a) break; x += (Math.min(y, b) - a) * px; }
    return x;
  };
  let W = xOf(Y1) + PAD_R;

  /* ── seeded jitter (mulberry32, same family as timeline2 / Field №01) ── */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  /* ── data prep ── */
  const nodes = DATA.nodes.filter(n => n.public !== false);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = DATA.edges.filter(e => byId.has(e.source) && byId.has(e.target));
  const adj = new Map(nodes.map(n => [n.id, { out: [], in: [] }]));
  edges.forEach((e, i) => { e._i = i; adj.get(e.source).out.push(e); adj.get(e.target).in.push(e); });
  // Time rule (Raghava): nothing feeds the past. Every arrow runs earlier → later and touches each
  // node at the moment of contact: the later of the two start years, clamped to the node's living span.
  const start = (n) => n.year || Y0;
  const aliveUntil = (n) => n.yearEnd ? n.yearEnd : (n.kind === 'event' && n.mode === 'formation' ? (n.touchedUntil || n.year) : (n.year || Y0));
  const contactYear = (a, b) => Math.max(start(a), start(b));

  const series = nodes.filter(n => n.kind === 'series').sort((a, b) => (a.sortYear || a.year) - (b.sortYear || b.year) || a.id.localeCompare(b.id));
  const events = nodes.filter(n => n.kind === 'event');

  /* ── layout: series plates along the spine, pushed apart in order ── */
  series.forEach(n => {
    n.w = Math.max(n.thumb ? 92 : 84, Math.min(150, 10 + n.label.length * 6.4)); // frame or caption, whichever is wider
    n.h = n.thumb ? 118 : 96;
    n.x = xOf(n.year);
  });
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < series.length; i++) {
      const a = series[i - 1], b = series[i];
      const minGap = a.w / 2 + b.w / 2 + 18;
      if (b.x - a.x < minGap) b.x = a.x + minGap;
    }
  }
  series.forEach(n => { n.y = SPINE_Y; });
  // plates get pushed off their true year by collision, so the spine has its own year → x map:
  // piecewise-linear between plate positions, so a series' tail lines up with the plates that follow it
  const spineKnots = [];
  series.forEach(n => { if (!spineKnots.length || n.year > spineKnots[spineKnots.length - 1].year) spineKnots.push({ year: n.year, x: n.x }); });
  function spineX(year) {
    if (!spineKnots.length) return xOf(year);
    if (year <= spineKnots[0].year) return xOf(year) + (spineKnots[0].x - xOf(spineKnots[0].year));
    for (let i = 1; i < spineKnots.length; i++) {
      const a = spineKnots[i - 1], b = spineKnots[i];
      if (year <= b.year) return a.x + (b.x - a.x) * (year - a.year) / (b.year - a.year);
    }
    const last = spineKnots[spineKnots.length - 1];
    return last.x + (xOf(year) - xOf(last.year));
  }

  // From here on every year → x goes through the spine's warp, so an event of 2020 sits under the 2020 plates.
  W = Math.max(W, spineX(Y1) + PAD_R);

  /* ── layout: events lane-packed away from the spine ── */
  function labelWidth(n) {
    const chars = n.label.length;
    if (n.mode === 'catalyst') return Math.min(176, 40 + chars * 6.2);
    return Math.min(190, 14 + chars * 6.2);
  }
  ['personal', 'professional'].forEach(sphere => {
    const band = BAND[sphere];
    const list = events.filter(n => n.sphere === sphere);
    // row 0 (nearest the spine): touches a series; otherwise deeper
    list.forEach(n => {
      const touches = adj.get(n.id).out.concat(adj.get(n.id).in).some(e => byId.get(e.source).kind === 'series' || byId.get(e.target).kind === 'series');
      n.depth = touches ? 0 : 1;
      const rnd = mulberry32(hashStr(n.id))();
      n.x = spineX(n.year || Y0) + (rnd - 0.5) * 22;
      n.lw = labelWidth(n);
    });
    // lane packing: depth-0 nodes first, then the rest, each into the first lane that has room
    const lanes = [];
    const order = list.slice().sort((a, b) => a.depth - b.depth || a.x - b.x);
    order.forEach(n => {
      let L = n.depth === 0 ? 0 : 1;
      for (;; L++) {
        if (!lanes[L]) lanes[L] = [];
        const clash = lanes[L].some(m => Math.abs(m.x - n.x) < (m.lw + n.lw) / 2 + 22);
        if (!clash) { lanes[L].push(n); n.lane = L; break; }
        if (L > 12) { lanes[L].push(n); n.lane = L; break; }
      }
    });
    list.forEach(n => {
      const jitter = (mulberry32(hashStr(n.id + 'y'))() - 0.5) * 10;
      n.y = band.from + band.dir * (n.lane * LANE_H + 12) + jitter;
    });
  });

  /* ── DOM ── */
  const stage = document.getElementById('lineageStage');
  const scroller = document.getElementById('lineageScroll');
  const card = document.getElementById('lineageCard');
  if (!stage) return;
  stage.style.width = W + 'px';
  stage.style.height = H + 'px';

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'lin-svg');
  svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  stage.appendChild(svg);

  // markers
  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = ['informs', 'triggers', 'merges', 'in', 'out'].map(k =>
    `<marker id="arr-${k}" class="arr arr-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="${k === 'merges' ? 11 : 8}" markerHeight="${k === 'merges' ? 11 : 8}" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9"/></marker>`
  ).join('');
  svg.appendChild(defs);

  // spine: two jittered passes, like timeline2
  function spinePath(seed, amp) {
    const r = mulberry32(seed); let d = `M ${PAD_L - 60} ${SPINE_Y}`;
    for (let x = PAD_L - 60; x <= W - PAD_R + 80; x += 14) d += ` L ${x} ${(SPINE_Y + (r() - 0.5) * amp).toFixed(1)}`;
    return d;
  }
  const gSpine = document.createElementNS(NS, 'g'); gSpine.setAttribute('class', 'spine');
  gSpine.innerHTML = `<path class="spine-main" d="${spinePath(101, 1.6)}"/><path class="spine-ghost" d="${spinePath(202, 2.4)}" transform="translate(0,2.5)"/>`;
  svg.appendChild(gSpine);

  // axis ticks
  const gAxis = document.createElementNS(NS, 'g'); gAxis.setAttribute('class', 'axis');
  let ax = `<line x1="${PAD_L - 40}" y1="${AXIS_Y}" x2="${W - PAD_R + 60}" y2="${AXIS_Y}"/>`;
  for (let y = 1985; y <= 2026; y++) {
    const x = spineX(y); const big = y % 5 === 0;
    ax += `<line x1="${x}" y1="${AXIS_Y}" x2="${x}" y2="${AXIS_Y - (big ? 10 : 5)}"/>`;
    if (big) ax += `<text x="${x}" y="${AXIS_Y + 16}" text-anchor="middle">${y}</text>`;
  }
  gAxis.innerHTML = ax; svg.appendChild(gAxis);

  // faint year columns through the bands
  const gCols = document.createElementNS(NS, 'g'); gCols.setAttribute('class', 'cols');
  let cols = '';
  for (let y = 1985; y <= 2026; y += 5) cols += `<line x1="${spineX(y)}" y1="40" x2="${spineX(y)}" y2="${AXIS_Y - 14}"/>`;
  gCols.innerHTML = cols; svg.appendChild(gCols);

  const gEdges = document.createElementNS(NS, 'g'); gEdges.setAttribute('class', 'edges'); svg.appendChild(gEdges);
  const gHits = document.createElementNS(NS, 'g'); gHits.setAttribute('class', 'hits'); svg.appendChild(gHits);

  const layer = document.createElement('div'); layer.className = 'lin-nodes'; stage.appendChild(layer);

  /* ── node elements ── */
  const el = new Map();
  // x of a node at a given year: its own position, or along its tail if it lived on
  function xAt(n, year) {
    if (year <= start(n)) return n.x;
    const end = aliveUntil(n);
    if (year > end) return n.tailX != null ? n.tailX : n.x;
    // series plates are pushed off their year by collision; their tails follow the spine's own year map
    return Math.max(n.x, spineX(Math.min(year, end)));
  }
  function anchor(n, year, towardY) {
    const x = xAt(n, year);
    if (n.kind === 'series') {
      const onPlate = x <= n.x + 2;
      if (onPlate) { const dy = towardY < n.y ? -n.h / 2 - 2 : (towardY > n.y ? n.h / 2 - 22 : 0); return { x: n.x, y: n.y + dy }; }
      return { x, y: n.y + (towardY < n.y ? -6 : 6) };   // on the spine tail
    }
    return { x, y: n.y };
  }
  nodes.forEach(n => {
    const d = document.createElement(n.href && n.kind === 'series' ? 'a' : 'div');
    if (n.href && n.kind === 'series') { d.href = n.href; }
    d.className = `lin-node ${n.kind}` + (n.kind === 'event' ? ` ${n.sphere} ${n.mode}` : (n.thumb ? ' plate' : ' specimen'));
    d.dataset.id = n.id;
    d.style.left = n.x + 'px'; d.style.top = n.y + 'px';
    if (n.kind === 'series') {
      const span = n.yearEnd ? `${n.year}→${String(n.yearEnd).slice(2)}` : `${n.year}`;
      d.innerHTML = n.thumb
        ? `<span class="frame"><img src="./${n.thumb}" alt="" loading="lazy" draggable="false"/></span><span class="cap"><i>${esc(n.label)}</i><b>${span}</b></span>`
        : `<span class="frame txt"><i>${esc(n.label)}</i></span><span class="cap"><b>${span}</b></span>`;
      const tilt = ((mulberry32(hashStr(n.id))() - 0.5) * 3).toFixed(2);
      d.style.setProperty('--tilt', tilt + 'deg');
      if (n.thumb) {
        const img = d.querySelector('img');
        img.addEventListener('load', () => {
          const ar = img.naturalWidth / img.naturalHeight || 1;
          const fw = Math.max(64, Math.min(120, Math.round(76 * ar)));
          d.querySelector('.frame').style.width = fw + 'px';
          n.w = fw + 10;
        });
        img.addEventListener('error', () => { d.classList.remove('plate'); d.classList.add('specimen'); d.querySelector('.frame').classList.add('txt'); d.querySelector('.frame').innerHTML = `<i>${esc(n.label)}</i>`; });
      }
    } else {
      const yr = n.yearEnd ? `${n.year}–${String(n.yearEnd).slice(2)}` : `${n.year || ''}`;
      d.innerHTML = n.mode === 'catalyst'
        ? `<span class="slip"><b>${yr}</b><i>${esc(n.label)}</i></span>`
        : `<span class="dot"></span><i class="lab">${esc(n.label)}</i>`;
      if (n.mode === 'catalyst') d.style.setProperty('--tilt', ((mulberry32(hashStr(n.id + 't'))() - 0.5) * 2.4).toFixed(2) + 'deg');
    }
    layer.appendChild(d); el.set(n.id, d);
    // the tail a node lives on: series along the spine to yearEnd; a formation until the last thing that touched it;
    // a catalyst only when it was a period (dot at start + line, his tool's convention)
    const until = aliveUntil(n);
    const tailEnd = n.kind === 'series' ? (n.yearEnd ? spineX(n.yearEnd) : null)
                  : (n.mode === 'formation' ? (until > start(n) ? spineX(until) : null) : (n.yearEnd ? spineX(n.yearEnd) : null));
    if (tailEnd != null && tailEnd > n.x + 8) {
      n.tailX = tailEnd;
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('class', 'tail ' + (n.kind === 'series' ? 'tail-series' : n.mode === 'formation' ? 'tail-idea' : 'tail-period'));
      ln.setAttribute('x1', n.x + (n.kind === 'series' ? n.w / 2 - 6 : 4)); ln.setAttribute('x2', tailEnd);
      ln.setAttribute('y1', n.y + (n.kind === 'series' ? 0 : 0)); ln.setAttribute('y2', n.y);
      gCols.appendChild(ln);
    }
  });

  /* ── edge paths ── */
  function pathFor(e) {
    const a = byId.get(e.source), b = byId.get(e.target);
    const t = contactYear(a, b);
    const p = anchor(a, t, b.y), q = anchor(b, t, a.y);
    const dx = q.x - p.x, dy = q.y - p.y;
    if (a.kind === 'series' && b.kind === 'series') {
      // plate to plate along the spine (a body of work informs a later one): an arc above;
      // the reverse leg of a same-year pair arcs below
      const sx = a.x, tx = b.x, ddx = tx - sx;
      const below = (e.source > e.target) && edges.some(o => o.source === e.target && o.target === e.source);
      const lift = below ? 1 : -1; const amp = Math.min(150, 40 + Math.abs(ddx) * 0.18);
      const y = SPINE_Y + lift * amp + (lift < 0 ? -42 : 30);
      const off = (lift < 0 ? -58 : 34);
      return `M ${sx} ${SPINE_Y + off} C ${sx + ddx * 0.25} ${y}, ${tx - ddx * 0.25} ${y}, ${tx} ${SPINE_Y + off}`;
    }
    if (Math.abs(dy) < 40) {
      // same band, near-horizontal: bow it away from the spine
      const away = (a.kind === 'event' ? (a.sphere === 'personal' ? -1 : 1) : 1);
      const amp = Math.min(90, 24 + Math.abs(dx) * 0.14);
      return `M ${p.x} ${p.y} C ${p.x + dx * 0.3} ${p.y + away * amp}, ${q.x - dx * 0.3} ${q.y + away * amp}, ${q.x} ${q.y}`;
    }
    return `M ${p.x} ${p.y} C ${p.x} ${p.y + dy * 0.42}, ${q.x} ${q.y - dy * 0.42}, ${q.x} ${q.y}`;
  }
  const edgeEl = [];
  edges.forEach(e => {
    const p = document.createElementNS(NS, 'path');
    const web = byId.get(e.source).kind === 'event' && byId.get(e.target).kind === 'event';
    p.setAttribute('class', `edge ${e.kind}` + (web ? ' web' : '') + (e.flipped ? ' flipped' : ''));
    p.setAttribute('d', pathFor(e));
    p.setAttribute('marker-end', `url(#arr-${e.kind})`);
    p.dataset.i = e._i;
    gEdges.appendChild(p);
    const h = document.createElementNS(NS, 'path');
    h.setAttribute('class', 'hit'); h.setAttribute('d', p.getAttribute('d')); h.dataset.i = e._i;
    gHits.appendChild(h);
    edgeEl[e._i] = p;
  });
  // series plates may change width once thumbs load; redraw edges after images settle
  window.addEventListener('load', () => edges.forEach(e => { edgeEl[e._i].setAttribute('d', pathFor(e)); gHits.children[e._i].setAttribute('d', pathFor(e)); }));

  /* ── focus + card ── */
  let pinned = null;
  function egoOf(id) {
    const ids = new Set([id]); const es = new Set();
    adj.get(id).out.forEach(e => { ids.add(e.target); es.add(e._i); });
    adj.get(id).in.forEach(e => { ids.add(e.source); es.add(e._i); });
    return { ids, es };
  }
  function applyFocus(ids, es, centre) {
    stage.classList.add('is-focus');
    el.forEach((d, id) => { d.classList.toggle('on', ids.has(id)); d.classList.toggle('centre', id === centre); });
    edgeEl.forEach((p, i) => {
      const on = es.has(i); p.classList.toggle('on', on);
      const e = edges[i];
      // direction colour, only when a single node is the centre: what fed it in ink, what it fed in red
      const dir = (on && centre) ? (e.target === centre ? 'in' : 'out') : null;
      p.classList.toggle('in', dir === 'in'); p.classList.toggle('out', dir === 'out');
      p.setAttribute('marker-end', dir ? `url(#arr-${dir})` : `url(#arr-${e.kind})`);
    });
  }
  function clearFocus() {
    stage.classList.remove('is-focus');
    el.forEach(d => d.classList.remove('on', 'centre'));
    edgeEl.forEach((p, i) => { p.classList.remove('on', 'in', 'out'); const e = edges[i]; p.setAttribute('marker-end', `url(#arr-${e.kind})`); });
  }
  const KIND = { informs: 'informs', triggers: 'triggers', merges: 'merges into' };
  function chip(n) {
    if (n.kind === 'series') return `<span class="chip">series</span>`;
    return `<span class="chip">${n.sphere}</span><span class="chip">${n.mode}</span>`;
  }
  function edgeLine(e, from) {
    const other = byId.get(from === 'in' ? e.source : e.target);
    return `<li><span class="k ${e.kind}">${from === 'in' ? '' : '→ '}${KIND[e.kind]}${from === 'in' ? ' ←' : ''}</span> <button type="button" class="jump" data-id="${other.id}">${esc(other.label)}</button>${e.sentence ? `<p>${esc(e.sentence)}</p>` : ''}</li>`;
  }
  function showNode(n) {
    const a = adj.get(n.id);
    const yr = n.yearEnd ? `${n.year} to ${n.yearEnd}` : `${n.year || ''}`;
    card.innerHTML = `
      <button type="button" class="close" aria-label="Close">×</button>
      <p class="kick">${chip(n)}<span class="yr">${yr}</span></p>
      <h3>${esc(n.label)}</h3>
      ${n.summary ? `<p class="sum">${esc(n.summary)}</p>` : ''}
      ${a.in.length ? `<h4 class="h-in">Fed by</h4><ul>${a.in.map(e => edgeLine(e, 'in')).join('')}</ul>` : ''}
      ${a.out.length ? `<h4 class="h-out">Fed into</h4><ul>${a.out.map(e => edgeLine(e, 'out')).join('')}</ul>` : ''}
      ${n.href ? `<a class="go" href="${n.href}">Open ↗</a>` : ''}`;
    card.hidden = false;
  }
  function showEdge(e) {
    const a = byId.get(e.source), b = byId.get(e.target);
    card.innerHTML = `
      <button type="button" class="close" aria-label="Close">×</button>
      <p class="kick"><span class="chip">${KIND[e.kind]}</span>${e.via ? `<span class="chip">via ${e.via === 'vishwarupa' ? 'Vishwaroopa' : 'La Liberté'}</span>` : ''}</p>
      <h3><button type="button" class="jump" data-id="${a.id}">${esc(a.label)}</button> <span class="arrow">→</span> <button type="button" class="jump" data-id="${b.id}">${esc(b.label)}</button></h3>
      ${e.sentence ? `<p class="sum">${esc(e.sentence)}</p>` : `<p class="sum muted">${esc(a.summary || '')}</p>`}`;
    card.hidden = false;
  }
  function pinNode(id) {
    const n = byId.get(id); if (!n) return;
    pinned = { type: 'node', id };
    const { ids, es } = egoOf(id); applyFocus(ids, es, id); showNode(n);
    // keep it in view
    const d = el.get(id); const r = d.getBoundingClientRect(); const sr = scroller.getBoundingClientRect();
    if (r.left < sr.left + 80 || r.right > sr.right - 80) scroller.scrollTo({ left: n.x - scroller.clientWidth / 2, behavior: 'smooth' });
  }
  function pinEdge(i) {
    const e = edges[i]; pinned = { type: 'edge', i };
    applyFocus(new Set([e.source, e.target]), new Set([i])); showEdge(e);
  }
  function unpin() { pinned = null; clearFocus(); card.hidden = true; }

  layer.addEventListener('mouseover', ev => {
    const d = ev.target.closest('.lin-node'); if (!d || pinned) return;
    const { ids, es } = egoOf(d.dataset.id); applyFocus(ids, es, d.dataset.id);
  });
  layer.addEventListener('mouseout', ev => { if (!pinned && ev.target.closest('.lin-node')) clearFocus(); });
  layer.addEventListener('click', ev => {
    const d = ev.target.closest('.lin-node'); if (!d) return;
    if (d.tagName === 'A') {
      // series plates link out; first click pins, second follows
      if (!(pinned && pinned.type === 'node' && pinned.id === d.dataset.id)) { ev.preventDefault(); pinNode(d.dataset.id); }
      return;
    }
    if (pinned && pinned.type === 'node' && pinned.id === d.dataset.id) unpin(); else pinNode(d.dataset.id);
  });
  gHits.addEventListener('mouseover', ev => { if (pinned) return; const i = +ev.target.dataset.i; const e = edges[i]; applyFocus(new Set([e.source, e.target]), new Set([i])); });
  gHits.addEventListener('mouseout', () => { if (!pinned) clearFocus(); });
  gHits.addEventListener('click', ev => { const i = +ev.target.dataset.i; if (pinned && pinned.type === 'edge' && pinned.i === i) unpin(); else pinEdge(i); });
  stage.addEventListener('click', ev => { if (ev.target === stage || ev.target === svg || ev.target.closest('.spine, .axis, .cols')) unpin(); });
  card.addEventListener('click', ev => {
    if (ev.target.closest('.close')) { unpin(); return; }
    const j = ev.target.closest('.jump'); if (j) pinNode(j.dataset.id);
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') unpin(); });

  /* ── filters ── */
  const filters = { sphere: 'both', ideas: true };
  function applyFilters() {
    nodes.forEach(n => {
      let hide = false;
      if (n.kind === 'event') {
        if (filters.sphere !== 'both' && n.sphere !== filters.sphere) hide = true;
        if (!filters.ideas && n.mode === 'formation') hide = true;
      }
      n._hidden = hide; el.get(n.id).classList.toggle('hid', hide);
    });
    edges.forEach(e => {
      const hide = byId.get(e.source)._hidden || byId.get(e.target)._hidden;
      edgeEl[e._i].classList.toggle('hid', hide); gHits.children[e._i].classList.toggle('hid', hide);
    });
    document.querySelectorAll('.lin-band').forEach(b => b.classList.toggle('hid', filters.sphere !== 'both' && b.dataset.sphere !== filters.sphere));
    unpin();
  }
  document.querySelectorAll('[data-sphere-filter]').forEach(b => b.addEventListener('click', () => {
    filters.sphere = b.dataset.sphereFilter;
    document.querySelectorAll('[data-sphere-filter]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    applyFilters();
  }));
  const ideasBtn = document.getElementById('ideasBtn');
  if (ideasBtn) ideasBtn.addEventListener('click', () => {
    filters.ideas = !filters.ideas; ideasBtn.setAttribute('aria-pressed', filters.ideas ? 'true' : 'false');
    ideasBtn.querySelector('.label').textContent = filters.ideas ? 'ideas shown' : 'ideas hidden';
    applyFilters();
  });

  // band labels (inside the stage, sticky to the scroller's left edge)
  ['personal', 'professional'].forEach(s => {
    const b = document.createElement('div'); b.className = `lin-band ${s}`; b.dataset.sphere = s;
    b.textContent = s === 'personal' ? 'a life · above the line' : 'a career · below the line';
    b.style.top = (s === 'personal' ? 30 : H - 44) + 'px';
    stage.appendChild(b);
  });

  /* ── counts ── */
  const cnt = document.getElementById('lineageCounts');
  if (cnt) cnt.textContent = `${series.length} series · ${events.length} events · ${edges.length} arrows`;

  /* ── scroll to the present on load (the right end), then let the reader walk back ── */
  requestAnimationFrame(() => { scroller.scrollLeft = Math.max(0, spineX(2013) - 120); });

  /* ── ledger ── */
  const ledger = document.getElementById('lineageLedger');
  if (ledger) {
    ledger.innerHTML = series.map((n, i) => {
      const a = adj.get(n.id);
      const li = (e, dir) => {
        const o = byId.get(dir === 'in' ? e.source : e.target);
        const who = o.kind === 'series' ? 'series' : `${o.sphere} · ${o.mode}`;
        return `<li><span class="k ${e.kind}">${KIND[e.kind]}</span> <span class="who"><i>${esc(o.label)}</i> <small>${who}${o.year ? ' · ' + o.year : ''}</small></span>${e.sentence ? `<p>${esc(e.sentence)}</p>` : (dir === 'in' && o.summary ? `<p>${esc(o.summary)}</p>` : '')}</li>`;
      };
      const num = String(i + 1).padStart(2, '0');
      return `<article class="led" id="led-${n.id}">
        <div class="led-num">№ ${num}</div>
        <div class="led-body">
          <p class="led-meta">${n.year}${n.yearEnd ? ' → ' + n.yearEnd : ''}${n.origin ? ' · begun ' + n.origin : ''}${n.href ? ` · <a href="${n.href}">open ↗</a>` : ''}</p>
          <h3>${esc(n.label)}</h3>
          ${n.summary ? `<p class="led-sum">${esc(n.summary)}</p>` : ''}
          ${a.in.length ? `<h4 class="h-in">Fed by</h4><ul>${a.in.map(e => li(e, 'in')).join('')}</ul>` : ''}
          ${a.out.length ? `<h4 class="h-out">Fed into</h4><ul>${a.out.map(e => li(e, 'out')).join('')}</ul>` : ''}
        </div></article>`;
    }).join('');
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  window.RaghavaLineage = { nodes, edges, pin: pinNode, unpin, spineX, xAt, pathFor };
})();
