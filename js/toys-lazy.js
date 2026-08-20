/* ────────────────────────────────────────────────────────────────
   toys-lazy.js  →  window.RaghavaToysShelf
   Toys shelf — visual + interaction twin of library-shelf.js,
   adapted to host <model-viewer> tiles instead of book covers.

   Public API
     window.RaghavaToysShelf.init({
       container,        // DOM element to render into (required)
       rows,             // [{ label, note, toys: [toy,...] }, ...]
       toys,             // alternative: flat list, wrapped into 1 row
       compact: false,   // smaller tiles + shorter stage (lab embed)
       limit:   null,    // cap on total toys rendered (null = no cap)
       hideHead: false,  // suppress per-row label/note row
     })
     → returns { destroy, pause, resume }

   What it does
     1. For each row builds the same DOM library-shelf.js builds:
        a head with mono-caps label + display-italic note, a stage,
        a canvas, and absolutely-positioned tiles resting on the
        shelf at bottom: baseFloor.
     2. Draws (per rAF) a hand-drawn graphite SHELF BOARD with
        thickness, jittered top/bottom edges, a cream-darker band
        between, a drop-shadow band below, contact shadows under
        each toy, and red synaptic pulses traveling along the
        top edge between adjacent toys.
     3. Per-tile physics: baseAngle ±2.5° deterministic lean,
        breathing sway ±0.4°, hover lifts ~8px (compact ~6px) and
        rights to 0°.
     4. Lazy-mounts <model-viewer> only when a tile enters the
        viewport (IntersectionObserver, rootMargin 200px). Caps
        simultaneous viewers at 6; oldest gets unmounted.
     5. Disables zoom on the model-viewer (drag still orbits).
     6. Hover caption "Title · Year" appears ABOVE each tile in
        mono caps, identical to library tiles.
     7. file:// graceful degradation: render the shelves without 3D,
        plus an explanatory banner above the container.
   ──────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Static config ────────────────────────────────────────────────
  // Phones get a tighter cap so a low-memory device doesn't try to keep
  // six Draco-decoded scenes alive simultaneously. The cap is set once
  // at load — orientation change is a rare enough event that we don't
  // re-evaluate at runtime.
  const IS_PHONE = typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(max-width: 640px)').matches;
  const ACTIVE_CAP         = IS_PHONE ? 2 : 6;
  const ROOT_MARGIN        = '200px 0px';
  const ROTATION_DEG_PER_S = 5;
  const MV_READY_TIMEOUT   = 4000;

  const FULL_CFG = {
    TILE_BASE_PX: 220,
    TILE_GAP_PX:  22,
    LEFT_GUTTER:  14,
    BASE_FLOOR:   24,    // shelf board top, distance above stage bottom
    TILE_LIFT:    6,     // tile sits this many px ABOVE the shelf top —
                         // small intentional elevation so the toy doesn't
                         // read as tangent to the line. Contact shadow
                         // follows the tile foot, not the shelf top.
    STAGE_HEIGHT: 'clamp(280px, 38vh, 340px)',
    HOVER_LIFT:   8,
    BOARD_THICKNESS: 6,
  };
  const COMPACT_CFG = {
    TILE_BASE_PX: 150,
    TILE_GAP_PX:  14,
    LEFT_GUTTER:  10,
    BASE_FLOOR:   20,
    TILE_LIFT:    4,
    STAGE_HEIGHT: 'clamp(200px, 26vh, 230px)',
    HOVER_LIFT:   6,
    BOARD_THICKNESS: 5,
  };

  const REDUCED_MOTION = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IS_FILE_PROTOCOL = (window.location && window.location.protocol === 'file:');
  const isMobileQuery = window.matchMedia('(max-width: 720px)');

  // FIFO of currently-mounted viewers across ALL instances (one cap site-wide)
  const active = [];

  function info(msg) {
    if (window.console && console.debug) console.debug('[toys-shelf] ' + msg);
  }

  function escAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ── Deterministic PRNG (mulberry32 — same as library shelf) ──────

  function strSeed(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }
  function mulberry32(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Tile + row + drawing — shared helpers (closure over cfg) ─────

  function buildInstance(opts) {
    const container = opts.container;
    if (!container) {
      console.error('[toys-shelf] init: container is required');
      return null;
    }
    const compact  = !!opts.compact;
    const hideHead = !!opts.hideHead;
    const cfg      = compact ? COMPACT_CFG : FULL_CFG;

    // Make the container a shelf root
    container.classList.add('toys-shelf');
    if (compact) container.classList.add('toys-shelf--compact');

    // Normalize input → rows[]
    let rows;
    if (Array.isArray(opts.rows) && opts.rows.length) {
      rows = opts.rows.map(r => ({
        label: r.label || '',
        note:  r.note  || '',
        toys:  (r.toys || []).slice(),
      }));
    } else if (Array.isArray(opts.toys) && opts.toys.length) {
      rows = [{ label: opts.label || '', note: opts.note || '', toys: opts.toys.slice() }];
    } else {
      console.error('[toys-shelf] init: need rows or toys');
      return null;
    }

    // Apply limit (truncate total across all rows)
    if (typeof opts.limit === 'number' && opts.limit > 0) {
      let remaining = opts.limit;
      rows = rows.map(r => {
        if (remaining <= 0) return { ...r, toys: [] };
        const slice = r.toys.slice(0, remaining);
        remaining -= slice.length;
        return { ...r, toys: slice };
      }).filter(r => r.toys.length);
    }

    const rowStates = [];

    // ── Build DOM ──
    rows.forEach((rowDef, rowIndex) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'library-row';

      if (!hideHead && (rowDef.label || rowDef.note)) {
        const headEl = document.createElement('div');
        headEl.className = 'library-row__head';
        headEl.innerHTML =
          '<span class="library-row__label">' + escAttr(rowDef.label || ('Row ' + (rowIndex + 1))) + '</span>' +
          '<span class="library-row__note">'  + escAttr(rowDef.note  || '') + '</span>';
        rowEl.appendChild(headEl);
      }

      const stageEl = document.createElement('div');
      stageEl.className = 'library-row__stage';
      stageEl.style.height = cfg.STAGE_HEIGHT;
      rowEl.appendChild(stageEl);

      const canvas = document.createElement('canvas');
      canvas.className = 'library-row__canvas';
      stageEl.appendChild(canvas);

      const tiles = rowDef.toys.map(toy => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toy-tile';
        btn.style.width  = cfg.TILE_BASE_PX + 'px';
        btn.style.height = cfg.TILE_BASE_PX + 'px';
        btn.style.bottom = (cfg.BASE_FLOOR + cfg.TILE_LIFT) + 'px';
        btn.setAttribute('aria-label', toy.title + (toy.year ? (', ' + toy.year) : ''));
        btn.dataset.slug = toy.slug;

        const viewer = document.createElement('div');
        viewer.className = 'toy-viewer';
        viewer.dataset.glb  = toy.glb;
        viewer.dataset.slug = toy.slug;
        if (toy.poster) viewer.dataset.poster = toy.poster;

        const placeholder = document.createElement('div');
        placeholder.className = 'toy-placeholder';
        placeholder.textContent = toy.title || toy.slug;
        viewer.appendChild(placeholder);

        btn.appendChild(viewer);

        const cap = document.createElement('span');
        cap.className = 'tile-caption';
        const yearSuffix = toy.year ? ' · ' + toy.year : '';
        cap.textContent = (toy.title || toy.slug) + yearSuffix;
        btn.appendChild(cap);

        // Deterministic lean + breathing phase
        const r = mulberry32(strSeed('toy-shelf:' + toy.slug + ':' + rowIndex));
        const baseAngle = (r() * 5 - 2.5);
        const phase = r() * Math.PI * 2;

        const tile = {
          el:         btn,
          slug:       toy.slug,
          x:          0,
          slotX:      0,
          width:      cfg.TILE_BASE_PX,
          height:     cfg.TILE_BASE_PX,
          baseAngle:  baseAngle,
          phase:      phase,
          lift:       0,
          liftTarget: 0,
          hover:      false,
        };

        btn.addEventListener('pointerenter', () => { tile.hover = true;  tile.liftTarget = cfg.HOVER_LIFT; });
        btn.addEventListener('pointerleave', () => { tile.hover = false; tile.liftTarget = 0; });
        btn.addEventListener('focus',        () => { tile.hover = true;  tile.liftTarget = cfg.HOVER_LIFT; });
        btn.addEventListener('blur',         () => { tile.hover = false; tile.liftTarget = 0; });
        btn.addEventListener('dragstart', e => e.preventDefault());

        stageEl.appendChild(btn);
        return tile;
      });

      const rowState = {
        rowEl, stageEl, canvas,
        ctx: canvas.getContext('2d'),
        rowIndex,
        tiles,
        cfg,
        contentWidth: 0,
        offset: 0,
        cssWidth: 0,
        cssHeight: 0,
        rng: mulberry32(strSeed('toy-pulses:' + rowIndex + ':' + (rowDef.label || ''))),
        pulses: [],
        nextPulseAt: performance.now() + (1600 + Math.random() * 2200),
      };
      rowStates.push(rowState);
      container.appendChild(rowEl);
    });

    // ── Sizing / layout ──
    function layoutSlots(r) {
      let cx = r.cfg.LEFT_GUTTER + r.offset;
      for (let i = 0; i < r.tiles.length; i++) {
        r.tiles[i].slotX = cx;
        cx += r.tiles[i].width + r.cfg.TILE_GAP_PX;
      }
    }

    function sizeAll() {
      const dpr = window.devicePixelRatio || 1;
      const isMobile = isMobileQuery.matches;
      rowStates.forEach(r => {
        const rect = r.stageEl.getBoundingClientRect();
        r.contentWidth = r.cfg.LEFT_GUTTER +
          r.tiles.reduce((s, t, i) => s + t.width + (i ? r.cfg.TILE_GAP_PX : 0), 0) +
          r.cfg.LEFT_GUTTER;

        const cssWidth  = isMobile ? Math.max(rect.width, r.contentWidth) : rect.width;
        const cssHeight = rect.height;
        r.canvas.style.width  = cssWidth  + 'px';
        r.canvas.style.height = cssHeight + 'px';
        r.canvas.width  = Math.round(cssWidth  * dpr);
        r.canvas.height = Math.round(cssHeight * dpr);
        r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        r.cssWidth  = cssWidth;
        r.cssHeight = cssHeight;
        r.offset = (!isMobile && r.contentWidth < cssWidth)
          ? Math.floor((cssWidth - r.contentWidth) / 2)
          : 0;
        layoutSlots(r);
        r.tiles.forEach(t => { t.x = t.slotX; t.el.style.left = t.x + 'px'; });
      });
    }

    // ── Shelf drawing ──
    function drawShelf(r) {
      const ctx = r.ctx;
      ctx.clearRect(0, 0, r.cssWidth, r.cssHeight);

      const isMobile = isMobileQuery.matches;
      const boardTopY = r.cssHeight - r.cfg.BASE_FLOOR;
      const boardThickness = r.cfg.BOARD_THICKNESS;
      const boardBottomY = boardTopY + boardThickness;
      const xStart = 6;
      const xEnd = (isMobile ? Math.max(r.cssWidth, r.contentWidth) : r.cssWidth) - 6;

      // Contact shadows — anchored to each tile's actual foot (which sits
      // TILE_LIFT pixels above the shelf top after the intentional lift),
      // not to the shelf board. Keeps the toy and its shadow visually
      // together rather than reading as a floating object with a shadow
      // detached on the shelf below.
      const tileFootY = boardTopY - r.cfg.TILE_LIFT;
      ctx.save();
      for (let i = 0; i < r.tiles.length; i++) {
        const t = r.tiles[i];
        const cx = t.x + t.width / 2;
        const yShadow = tileFootY + 0.5;
        const sw = Math.max(t.width * 0.6, 22);
        const sh = 3.5;
        const liftFade = Math.max(0, 1 - t.lift / 12);
        const alpha = 0.22 * liftFade;
        if (alpha < 0.01) continue;
        ctx.beginPath();
        ctx.ellipse(cx, yShadow, sw / 2, sh, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,18,14,' + alpha.toFixed(3) + ')';
        ctx.fill();
      }
      ctx.restore();

      // Polyline points
      const segLen = 14;
      const xs = [];
      for (let x = xStart; x <= xEnd; x += segLen) xs.push(x);
      if (xs[xs.length - 1] !== xEnd) xs.push(xEnd);

      function jitteredLine(seedTag, baseY, amplitude) {
        const r2 = mulberry32(strSeed('toy-shelf:' + seedTag));
        const pts = [];
        for (let i = 0; i < xs.length; i++) {
          pts.push({ x: xs[i], y: baseY + (r2() * 2 - 1) * amplitude });
        }
        return pts;
      }
      const topPts = jitteredLine('top-' + r.rowIndex, boardTopY, 0.55);
      const botPts = jitteredLine('bot-' + r.rowIndex, boardBottomY, 0.7);

      // Board body fill
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(topPts[0].x, topPts[0].y);
      for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
      for (let i = botPts.length - 1; i >= 0; i--) ctx.lineTo(botPts[i].x, botPts[i].y);
      ctx.closePath();
      const bandGrad = ctx.createLinearGradient(0, boardTopY, 0, boardBottomY);
      bandGrad.addColorStop(0,    'rgba(70,65,56,0.07)');
      bandGrad.addColorStop(0.55, 'rgba(70,65,56,0.13)');
      bandGrad.addColorStop(1,    'rgba(70,65,56,0.06)');
      ctx.fillStyle = bandGrad;
      ctx.fill();
      ctx.restore();

      function strokePolyline(pts, color, width) {
        ctx.beginPath();
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
          else         ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      }
      strokePolyline(topPts, 'rgba(20,18,14,0.78)', 1.0);
      strokePolyline(topPts.map(p => ({ x: p.x, y: p.y - 0.5 })), 'rgba(58,52,44,0.18)', 1.0);
      strokePolyline(botPts, 'rgba(20,18,14,0.55)', 1.0);
      strokePolyline(botPts.map(p => ({ x: p.x, y: p.y + 0.5 })), 'rgba(58,52,44,0.16)', 1.0);

      // Drop shadow
      ctx.save();
      const dropGrad = ctx.createLinearGradient(0, boardBottomY, 0, boardBottomY + 12);
      dropGrad.addColorStop(0, 'rgba(20,18,14,0.22)');
      dropGrad.addColorStop(1, 'rgba(20,18,14,0)');
      ctx.fillStyle = dropGrad;
      ctx.fillRect(xStart, boardBottomY + 0.5, xEnd - xStart, 12);
      ctx.restore();

      // Red synaptic pulses
      const now = performance.now();
      for (let i = r.pulses.length - 1; i >= 0; i--) {
        const p = r.pulses[i];
        const t = (now - p.t0) / p.duration;
        if (t >= 1) { r.pulses.splice(i, 1); continue; }
        const ease = 1 - Math.pow(1 - t, 2);
        const px = p.ax + (p.bx - p.ax) * ease;
        const py = boardTopY - 0.5;
        const brightness = Math.sin(t * Math.PI);
        ctx.beginPath();
        ctx.arc(px, py, 1.7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(230,61,34,' + (brightness * 0.95).toFixed(3) + ')';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(230,61,34,' + (brightness * 0.18).toFixed(3) + ')';
        ctx.fill();
      }
    }

    function spawnPulse(r, now) {
      if (r.tiles.length < 2) return;
      const i = Math.floor(r.rng() * (r.tiles.length - 1));
      const a = r.tiles[i], b = r.tiles[i + 1];
      r.pulses.push({
        ax: a.x + a.width / 2,
        bx: b.x + b.width / 2,
        t0: now,
        duration: 760 + Math.random() * 200,
      });
    }

    // ── Per-frame tile physics ──
    function tickTiles(r, now) {
      const breathAmpDeg = REDUCED_MOTION ? 0 : 0.4;
      const breathPeriod = 5200;
      const breathTau = (now / breathPeriod) * Math.PI * 2;

      for (let i = 0; i < r.tiles.length; i++) {
        const t = r.tiles[i];
        const liftEase = t.hover ? 0.18 : 0.12;
        t.lift += (t.liftTarget - t.lift) * liftEase;
        const baseInfluence = t.hover ? 0 : t.baseAngle;
        const breath = Math.sin(breathTau + t.phase) * breathAmpDeg;
        const angle = baseInfluence + breath;
        t.el.style.transform = 'translate(0, ' + (-t.lift).toFixed(2) + 'px) rotate(' + angle.toFixed(3) + 'deg)';
      }
    }

    // ── rAF loop ──
    let running = true;
    let rafId = null;
    function loop() {
      if (!running) return;
      const now = performance.now();
      rowStates.forEach(r => {
        if (!REDUCED_MOTION && now >= r.nextPulseAt) {
          spawnPulse(r, now);
          r.nextPulseAt = now + 1400 + Math.random() * 2200;
        }
        tickTiles(r, now);
        drawShelf(r);
      });
      rafId = requestAnimationFrame(loop);
    }

    // ── Lazy mount / unmount ──

    function evictOldestIfNeeded() {
      while (active.length >= ACTIVE_CAP) {
        const oldest = active.shift();
        if (oldest) unmount(oldest);
      }
    }

    function mount(viewer) {
      if (viewer.dataset.active === '1') return;
      if (!viewer.dataset.glb) return;
      evictOldestIfNeeded();
      const tile = viewer.closest('.toy-tile');
      if (tile) tile.dataset.loading = '1';

      const mv = document.createElement('model-viewer');
      mv.setAttribute('src', './' + viewer.dataset.glb);
      if (viewer.dataset.poster) mv.setAttribute('poster', './' + viewer.dataset.poster);
      mv.setAttribute('alt', viewer.dataset.slug || 'toy');
      mv.setAttribute('camera-controls', '');
      mv.setAttribute('disable-zoom', '');
      mv.setAttribute('disable-pan', '');
      mv.setAttribute('disable-tap', '');
      mv.setAttribute('interaction-prompt', 'none');
      mv.setAttribute('shadow-intensity', '0.55');
      mv.setAttribute('shadow-softness', '0.9');
      mv.setAttribute('exposure', '1.05');
      mv.setAttribute('environment-image', 'neutral');
      // FIXED camera-target — overrides model-viewer's default of
      // auto-targeting each model's bbox center. Combined with the
      // foot-alignment in tools/convert_toys.py (every toy has its
      // bottom at world Y = -0.5), this guarantees that every toy's
      // feet appear at the same screen Y. Without this pin, toys with
      // different bbox shapes get framed at different vertical screen
      // positions and look uneven on the shelf.
      mv.setAttribute('camera-target', '0m 0m 0m');
      mv.setAttribute('camera-orbit', '15deg 78deg 2.6m');
      mv.setAttribute('min-camera-orbit', 'auto 0deg 2.6m');
      mv.setAttribute('max-camera-orbit', 'auto 180deg 2.6m');
      mv.setAttribute('field-of-view', '28deg');
      mv.setAttribute('reveal', 'auto');
      mv.setAttribute('loading', 'eager');
      if (!REDUCED_MOTION) {
        mv.setAttribute('auto-rotate', '');
        mv.setAttribute('auto-rotate-delay', '0');
        mv.setAttribute('rotation-per-second', ROTATION_DEG_PER_S + 'deg');
      }
      mv.addEventListener('load',  () => { if (tile) tile.dataset.loading = '0'; }, { once: true });
      mv.addEventListener('error', () => { if (tile) tile.dataset.loading = '0'; });
      const placeholder = viewer.querySelector('.toy-placeholder');
      if (placeholder) placeholder.remove();
      viewer.appendChild(mv);
      viewer.dataset.active = '1';
      if (tile) tile.dataset.active = '1';
      active.push(viewer);
    }

    function unmount(viewer) {
      if (viewer.dataset.active !== '1') return;
      const tile = viewer.closest('.toy-tile');
      const mv = viewer.querySelector('model-viewer');
      if (mv) mv.remove();
      const ph = document.createElement('div');
      ph.className = 'toy-placeholder';
      ph.textContent = viewer.dataset.slug || 'toy';
      viewer.appendChild(ph);
      viewer.dataset.active = '0';
      if (tile) { tile.dataset.active = '0'; tile.dataset.loading = '0'; }
      const i = active.indexOf(viewer);
      if (i >= 0) active.splice(i, 1);
    }

    let io = null;
    function startObserving() {
      io = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) mount(e.target);
          else                  unmount(e.target);
        });
      }, { root: null, rootMargin: ROOT_MARGIN, threshold: 0.05 });
      container.querySelectorAll('.toy-viewer').forEach(v => io.observe(v));
    }

    // ── file:// banner ──
    function renderFileProtocolBanner() {
      if (compact) return null;  // lab embed stays quiet; the full toys page surfaces the banner
      const b = document.createElement('div');
      b.className = 'toy-file-banner';
      b.innerHTML = `
        <p class="banner-eyebrow">3D models need a local server</p>
        <p class="banner-body">You opened this page directly from disk (<code>file://</code>). Browsers block 3D model loading from local files for security. The shelves below are rendered for reference; the live 3D viewers will not appear.</p>
        <p class="banner-body"><strong>Fix in 10 seconds:</strong> double-click <code>tools/Preview Toys.command</code> in the website folder. It starts a local server and opens the page in your browser at <code>http://localhost:8000/toys2.html</code> where everything works.</p>
        <p class="banner-body banner-alt">Or, from Terminal in the website folder: <code>python3 -m http.server 8000</code> then open <code>http://localhost:8000/toys2.html</code>.</p>
      `;
      return b;
    }

    // ── Boot ──
    sizeAll();

    if (IS_FILE_PROTOCOL) {
      const banner = renderFileProtocolBanner();
      if (banner && container.parentNode) container.parentNode.insertBefore(banner, container);
      container.querySelectorAll('.toy-tile').forEach(t => t.dataset.preview = '1');
      rafId = requestAnimationFrame(loop);
      info('file:// detected — shelves drawn, no 3D mount');
    } else {
      Promise.race([
        customElements.whenDefined('model-viewer'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), MV_READY_TIMEOUT)),
      ]).then(() => {
        startObserving();
        rafId = requestAnimationFrame(loop);
      }).catch(err => {
        console.error('[toys-shelf] model-viewer never defined', err);
      });
    }

    // Resize re-sizes all rows AND repaints their shelf lines (the JS doesn't
    // cache geometry, but the canvas backing buffer needs the new dpr-scaled
    // dimensions).
    let rt;
    function onResize() { clearTimeout(rt); rt = setTimeout(sizeAll, 120); }
    window.addEventListener('resize', onResize);

    // ── Returned controller ──
    return {
      destroy: function () {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener('resize', onResize);
        if (io) io.disconnect();
        // Unmount any active viewers in this instance
        rowStates.forEach(r => r.tiles.forEach(t => {
          const v = t.el.querySelector('.toy-viewer');
          if (v) unmount(v);
        }));
        container.innerHTML = '';
        container.classList.remove('toys-shelf', 'toys-shelf--compact');
      },
      pause:  function () { running = false; if (rafId) cancelAnimationFrame(rafId); rafId = null; },
      resume: function () { if (running) return; running = true; if (!rafId) rafId = requestAnimationFrame(loop); },
      isRunning: function () { return running; },
    };
  }

  window.RaghavaToysShelf = { init: buildInstance };
})();
