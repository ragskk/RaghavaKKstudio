/* ───────────────────────────────────────────────────────────
   RAGHAVA KK · NETWORK FIELD MODULE
   Drifting painting tiles in an elliptical annulus, connected
   by hand-drawn graphite lines. Re-usable across pages.

   Usage:
     const api = window.RaghavaNetwork.init({
       container: '#field',      // selector or element
       works: NETWORK_WORKS,     // optional — defaults to window.NETWORK_WORKS
       thumbPath: './images/studio/_thumbs',  // optional
     });
     api.pause();   api.resume();
     api.resample();
     api.hide();    api.show();
     api.destroy();

   Performance notes:
     - Auto-pauses via IntersectionObserver when off-screen.
     - Auto-pauses via document.visibilitychange when tab hidden.
     - Hidden state fully tears down rAF; zero CPU cost while hidden.
   ─────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const DEFAULTS = {
    works: null,                          // resolved from window.NETWORK_WORKS at init
    thumbPath: './images/studio/_thumbs',
    count: null,                          // if set, exact tile count; overrides countMin/Max/AreaPer
    countMin: 16,
    countMax: 28,
    countAreaPer: 22000,                  // px² per tile target
    maxPerSeries: 3,                      // diversity cap when sampling
    // Default link per kind — function(work) so the URL carries
    // enough state for the target page to open with that work visible.
    kindLinks: {
      painting: (w) => `./studio2.html?work=${encodeURIComponent(w.id)}`,
      toy:      (w) => `./lab2.html?toy=${encodeURIComponent(w.slug)}`
    },
    tileBase: 58,                         // base tile dimension
    tileVariance: [0.85, 1.20],           // size multiplier range
    tileHover: 3.0,                       // hover scale
    neighbours: 2,                        // K nearest neighbours for lines
    speedMax: 0.42,
    speedMin: 0.10,
    cohesionK: 0.0,
    outerRxFrac: 0.84,
    outerRyFrac: 0.80,
    // If set, the LEFT side of the outer ellipse uses this fraction
    // instead of outerRxFrac. Lets pages keep most tiles on the right
    // (e.g., away from a wordmark) while the right side stays wide.
    outerRxFracLeft: null,
    holeRxFrac: 0.18,
    holeRyFrac: 0.18,
    holePushK: 0.055,
    edgePushK: 0.10,
    repulsionR: 70,
    repulsionK: 0.016,
    noiseK: 0.012,
    margin: 28,
    // Click-and-drag push (cursor pushes tiles away in empty space).
    // OFF by default — Raghava wanted drag-an-image-and-pull-others
    // instead. Flip to true to bring the empty-space push back.
    enablePush: false,
    mousePushR: 160,
    mousePushK: 0.42,
    // Drag-pull: grab a tile and drag it — nearby tiles within
    // dragPullR feel a soft attraction toward the grabbed tile and
    // trail along behind it.
    enableDrag: true,
    dragPullR: 220,
    dragPullK: 0.08,
    dragMoveThreshold: 4, // px before a drag suppresses the click navigation
    // Edge fade: tiles fade opacity as they approach the elliptical
    // boundary. Off by default — Raghava asked for 100% opaque tiles.
    edgeFade: false,
    // Synaptic signals: small bright dots periodically travel along the
    // graphite connections between tiles, like neurons firing.
    enableSignals:     true,
    signalColor:       'rgba(230, 61, 34, 1)',   // red — matches site accent (--red)
    signalRadius:      1.7,                       // core dot radius in px (small + opaque)
    signalGlowMul:     1.5,                       // outer glow radius = core × this (subtle halo)
    signalGlowAlpha:   0.18,                      // outer glow opacity multiplier (almost just the core)
    signalDuration:    760,                       // ms to travel between two tiles
    signalMinGap:      90,                        // ms minimum between spawn attempts
    signalSpawnP:      0.80,                      // probability of spawn per allowed tick
    signalMaxInFlight: 9,                         // cap concurrent pulses
    // Stray: a small fraction of tiles are biased to drift further LEFT
    // of the bounding ellipse — a slight asymmetric escape that gives
    // the cluster a feeling of having an off-leash few.
    strayFraction:  0.12,   // ~12% of tiles
    strayOuterMul:  1.6,    // multiplier on outer RX for the left side only
    strayBiasK:     0.010,  // gentle constant leftward force
    strayBiasReach: 0.55,   // bias active until tile is at -55% × outerRX
  };

  /* mulberry32 — deterministic per-seed RNG so jitter is stable */
  function seededRand(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function pairKey(i, j) { return i < j ? (i * 1000 + j) : (j * 1000 + i); }

  function init(opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const container = typeof cfg.container === 'string'
      ? document.querySelector(cfg.container)
      : cfg.container;
    if (!container) throw new Error('RaghavaNetwork.init: container not found');

    const works = cfg.works || window.NETWORK_WORKS || [];
    if (!works.length) {
      console.warn('RaghavaNetwork.init: no works data — was network-works.js loaded?');
    }

    const mqOk = typeof window.matchMedia === 'function';
    const reduceMotion = mqOk ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
    const isCoarse     = mqOk ? window.matchMedia('(pointer: coarse)').matches : false;
    const speedMax = reduceMotion ? Math.min(0.12, cfg.speedMax) : cfg.speedMax;
    const speedMin = reduceMotion ? Math.min(0.04, cfg.speedMin) : cfg.speedMin;
    const noiseK   = reduceMotion ? 0 : cfg.noiseK;

    // --- Build inner DOM ---
    container.innerHTML = '';
    container.classList.add('rk-field');
    const canvas = document.createElement('canvas');
    canvas.className = 'rk-field-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const tileLayer = document.createElement('div');
    tileLayer.className = 'rk-tile-layer';
    container.appendChild(canvas);
    container.appendChild(tileLayer);

    const ctx = canvas.getContext('2d');
    const bounds = { w: 0, h: 0 };
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let tiles = [];
    let raf = 0;
    let lastT = 0;
    let running = true;     // user-facing play/pause
    let inView  = true;     // IntersectionObserver-driven
    let tabVisible = !document.hidden;
    let isHidden = false;   // hide() teardown flag
    let onSampleChange = typeof cfg.onSampleChange === 'function' ? cfg.onSampleChange : null;

    // Mouse-push state: legacy empty-space push (off by default).
    let pushing = false;
    let pushX = 0, pushY = 0;
    // Drag-pull state: the currently grabbed tile (if any) follows the
    // cursor; non-grabbed tiles within dragPullR feel a soft attraction
    // toward it and trail along.
    let grabbedTile = null;
    // Synaptic pulses traveling along connections.
    let pulses = [];           // { aIdx, bIdx, spawnT, duration }
    let lastPulseSpawnT = 0;

    function resizeCanvas() {
      const r = container.getBoundingClientRect();
      bounds.w = r.width;
      bounds.h = r.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width  = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width  = r.width + 'px';
      canvas.style.height = r.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function pickCount() {
      // Explicit count wins; otherwise auto-size by area.
      if (typeof cfg.count === 'number' && cfg.count > 0) {
        return Math.max(1, Math.min((works && works.length) || cfg.count, cfg.count));
      }
      const area = bounds.w * bounds.h;
      const n = Math.round(area / cfg.countAreaPer);
      return Math.max(cfg.countMin, Math.min(cfg.countMax, n));
    }

    function sampleWorks(n) {
      const pool = works.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const out = [];
      const perSeries = new Map();
      for (const w of pool) {
        if (out.length >= n) break;
        const c = perSeries.get(w.slug) || 0;
        if (c >= cfg.maxPerSeries) continue;
        perSeries.set(w.slug, c + 1);
        out.push(w);
      }
      // backfill if cap was hit too early
      let i = 0;
      while (out.length < n && i < pool.length) {
        if (!out.includes(pool[i])) out.push(pool[i]);
        i++;
      }
      return out;
    }

    function buildTiles() {
      tileLayer.innerHTML = '';
      const n = pickCount();
      const picks = sampleWorks(n);
      const cx0 = bounds.w / 2, cy0 = bounds.h / 2;
      const outerRX0 = (bounds.w / 2) * cfg.outerRxFrac;
      const outerRY0 = (bounds.h / 2) * cfg.outerRyFrac;
      const holeRX0  = (bounds.w / 2) * cfg.holeRxFrac;
      // Use X-axis ratio as a single q for unit-disk annulus sampling.
      const q = outerRX0 > 0.01 ? (holeRX0 / outerRX0) : 0;

      tiles = picks.map((work, i) => {
        const sizeMul = cfg.tileVariance[0] + Math.random() * (cfg.tileVariance[1] - cfg.tileVariance[0]);
        const w = Math.round(cfg.tileBase * sizeMul);
        const h = Math.round(cfg.tileBase * sizeMul);

        // Per-work thumb override takes precedence; falls back to convention.
        const thumb = work.thumb || `${cfg.thumbPath}/${work.slug}/${work.id}.jpg`;
        const kind  = work.kind || 'painting';
        // Per-work link override, else per-kind default (function or string), else no link.
        let link = null;
        if (work.link != null) {
          link = work.link;
        } else if (cfg.kindLinks && cfg.kindLinks[kind]) {
          const v = cfg.kindLinks[kind];
          link = (typeof v === 'function') ? v(work) : v;
        }

        // Make the tile root an <a> when there's a link so click navigates.
        let el;
        if (link) {
          el = document.createElement('a');
          el.setAttribute('href', link);
          el.setAttribute('aria-label', `${work.title} — open ${kind === 'toy' ? 'Restless Lab' : 'Studio'}`);
        } else {
          el = document.createElement('div');
        }
        el.className = 'rk-tile';
        el.innerHTML = `
          <div class="rk-tile-frame" style="--w:${w}px;--h:${h}px;--s-hover:${cfg.tileHover}">
            <img alt="${escHtml(work.title)}"
                 src="${thumb}"
                 loading="lazy" decoding="async" />
          </div>
          <div class="rk-tile-cap" style="--h:${h}px;--s-hover:${cfg.tileHover}">
            <span class="rk-id">${escHtml(work.id)} · ${escHtml(work.series)}</span>
            <span class="rk-title">${escHtml(work.title)}</span>
            <span class="rk-meta">${escHtml(work.year)} · <em>${escHtml(kind)}</em></span>
          </div>
        `;

        // Area-uniform initial placement inside the elliptical annulus
        const u  = q * q + (1 - q * q) * Math.random();
        const rU = Math.sqrt(u);
        const a0 = Math.random() * Math.PI * 2;
        const x  = cx0 + Math.cos(a0) * rU * outerRX0;
        const y  = cy0 + Math.sin(a0) * rU * outerRY0;
        const ang = Math.random() * Math.PI * 2;
        const sp  = speedMin + Math.random() * (speedMax - speedMin);

        // A small fraction get the 'stray' flag — they drift further
        // left of the normal bounding ellipse.
        const stray = Math.random() < cfg.strayFraction;

        // Re-bias initial X for non-stray tiles when the left side is
        // asymmetrically narrower, so they don't spawn on top of the
        // wordmark and then drift right.
        let xUse = x, yUse = y;
        if (!stray && cfg.outerRxFracLeft != null) {
          const leftAllow = (bounds.w / 2) * cfg.outerRxFracLeft;
          if (xUse < cx0) {
            const dxLeft = cx0 - xUse;
            xUse = cx0 - Math.min(dxLeft, leftAllow * 0.95);
          }
        }

        const t = {
          work, el,
          x: xUse, y: yUse,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp,
          w, h,
          hovered: false,
          stray,
        };
        el.addEventListener('pointerenter', () => {
          t.hovered = true;
          el.classList.add('is-hovered');
          container.classList.add('rk-has-hover');
          el.style.zIndex = '20';
        });
        el.addEventListener('pointerleave', () => {
          t.hovered = false;
          el.classList.remove('is-hovered');
          el.style.zIndex = '';
          if (!tiles.some(o => o.hovered)) container.classList.remove('rk-has-hover');
        });

        /* Drag-pull: grab this tile, drag it, nearby tiles trail behind.
           Closure-scoped state per tile. */
        let dragStartCX = 0, dragStartCY = 0;
        let dragOffX   = 0, dragOffY   = 0;
        let dragMoved  = false;
        let suppressClick = false;

        el.addEventListener('pointerdown', (e) => {
          if (!cfg.enableDrag) return;
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          e.preventDefault();
          try { el.setPointerCapture(e.pointerId); } catch (_) {}
          const r = container.getBoundingClientRect();
          const mx = e.clientX - r.left;
          const my = e.clientY - r.top;
          t.grabbed = true;
          grabbedTile = t;
          dragOffX = t.x - mx;
          dragOffY = t.y - my;
          dragStartCX = e.clientX;
          dragStartCY = e.clientY;
          dragMoved = false;
          el.style.zIndex = '30';
          el.classList.add('is-grabbed');
        });
        el.addEventListener('pointermove', (e) => {
          if (!t.grabbed) return;
          const r = container.getBoundingClientRect();
          t.x = (e.clientX - r.left) + dragOffX;
          t.y = (e.clientY - r.top) + dragOffY;
          if (Math.abs(e.clientX - dragStartCX) > cfg.dragMoveThreshold ||
              Math.abs(e.clientY - dragStartCY) > cfg.dragMoveThreshold) {
            dragMoved = true;
          }
        });
        function endDrag(e) {
          if (!t.grabbed) return;
          t.grabbed = false;
          if (grabbedTile === t) grabbedTile = null;
          try { el.releasePointerCapture(e.pointerId); } catch (_) {}
          el.style.zIndex = '';
          el.classList.remove('is-grabbed');
          // If the pointer actually moved (>threshold), suppress the
          // synthesized click so the anchor doesn't navigate.
          if (dragMoved) suppressClick = true;
        }
        el.addEventListener('pointerup',     endDrag);
        el.addEventListener('pointercancel', endDrag);
        el.addEventListener('click', (e) => {
          if (suppressClick) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick = false;
          }
        });

        tileLayer.appendChild(el);
        return t;
      });

      if (onSampleChange) onSampleChange(tiles.length);
    }

    function step(dt) {
      const cw = bounds.w, ch = bounds.h;
      const fieldCx = cw / 2, fieldCy = ch / 2;
      const outerRX = (cw / 2) * cfg.outerRxFrac;
      const outerRY = (ch / 2) * cfg.outerRyFrac;
      const holeRX  = (cw / 2) * cfg.holeRxFrac;
      const holeRY  = (ch / 2) * cfg.holeRyFrac;

      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t.hovered) continue;
        // Grabbed tile is driven by the cursor — skip physics entirely.
        if (t.grabbed) continue;

        let ax = 0, ay = 0;
        const dxc = t.x - fieldCx;
        const dyc = t.y - fieldCy;
        const dc  = Math.hypot(dxc, dyc);

        // Drag-pull: soft attraction toward whatever tile is currently
        // grabbed (if any), so nearby tiles trail behind it.
        if (grabbedTile && cfg.enableDrag) {
          const dxg = grabbedTile.x - t.x;
          const dyg = grabbedTile.y - t.y;
          const dg  = Math.hypot(dxg, dyg);
          if (dg < cfg.dragPullR && dg > 0.01) {
            const f = (cfg.dragPullR - dg) / cfg.dragPullR;
            ax += (dxg / dg) * f * cfg.dragPullK;
            ay += (dyg / dg) * f * cfg.dragPullK;
          }
        }
        // Asymmetric left-side handling:
        //   • dxc >= 0 (right of centre): use outerRX (rightward bound).
        //   • dxc < 0  (left of centre):  use outerRxFracLeft when set
        //     (narrower, keeps most tiles off the wordmark area), then
        //     stray tiles get the multiplier on top so a few can still
        //     wander past it.
        let effOuterRX = outerRX;
        if (dxc < 0) {
          if (cfg.outerRxFracLeft != null) {
            effOuterRX = (cw / 2) * cfg.outerRxFracLeft;
          }
          if (t.stray) effOuterRX *= cfg.strayOuterMul;
        }
        const sHole  = Math.hypot(dxc / Math.max(1, holeRX),     dyc / Math.max(1, holeRY));
        const sOuter = Math.hypot(dxc / Math.max(1, effOuterRX), dyc / Math.max(1, outerRY));

        // Gentle leftward bias for stray tiles, active until they've
        // wandered to about -strayBiasReach × outerRX.
        if (t.stray && dxc > -outerRX * cfg.strayBiasReach) {
          ax -= cfg.strayBiasK;
        }

        if (sHole < 1) {
          const f = 1 - sHole;
          if (dc > 0.01) {
            ax += (dxc / dc) * f * cfg.holePushK;
            ay += (dyc / dc) * f * cfg.holePushK;
          } else {
            const a = Math.random() * Math.PI * 2;
            ax += Math.cos(a) * cfg.holePushK;
            ay += Math.sin(a) * cfg.holePushK;
          }
        }
        if (sOuter > 1 && dc > 0.01) {
          const over = sOuter - 1;
          const f = Math.min(1.6, over * (1 + over));
          ax += (-dxc / dc) * f * cfg.edgePushK;
          ay += (-dyc / dc) * f * cfg.edgePushK;
        }

        // soft pairwise repulsion
        for (let j = 0; j < tiles.length; j++) {
          if (i === j) continue;
          const o = tiles[j];
          const dx = t.x - o.x;
          const dy = t.y - o.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < cfg.repulsionR * cfg.repulsionR && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (cfg.repulsionR - d) / cfg.repulsionR;
            ax += (dx / d) * f * cfg.repulsionK;
            ay += (dy / d) * f * cfg.repulsionK;
          }
        }

        ax += (Math.random() - 0.5) * noiseK;
        ay += (Math.random() - 0.5) * noiseK;

        // Mouse push: while dragging inside the field, the cursor radiates
        // an outward force that clears a path through the tiles.
        if (pushing && cfg.enablePush) {
          const dxm = t.x - pushX;
          const dym = t.y - pushY;
          const dm  = Math.hypot(dxm, dym);
          if (dm < cfg.mousePushR && dm > 0.01) {
            const f = (cfg.mousePushR - dm) / cfg.mousePushR;
            ax += (dxm / dm) * f * cfg.mousePushK;
            ay += (dym / dm) * f * cfg.mousePushK;
          }
        }

        t.vx += ax * dt;
        t.vy += ay * dt;
        const sp = Math.hypot(t.vx, t.vy);
        if (sp > speedMax) { t.vx = t.vx / sp * speedMax; t.vy = t.vy / sp * speedMax; }
        if (sp < speedMin * 0.5) {
          const a = Math.random() * Math.PI * 2;
          t.vx += Math.cos(a) * 0.02;
          t.vy += Math.sin(a) * 0.02;
        }
        t.x += t.vx * dt;
        t.y += t.vy * dt;

        // safety wall bounce (the ellipse normally catches everything first)
        if (t.x < cfg.margin)           { t.x = cfg.margin;          t.vx = Math.abs(t.vx); }
        if (t.x > cw - cfg.margin)      { t.x = cw - cfg.margin;     t.vx = -Math.abs(t.vx); }
        if (t.y < cfg.margin)           { t.y = cfg.margin;          t.vy = Math.abs(t.vy); }
        if (t.y > ch - cfg.margin)      { t.y = ch - cfg.margin;     t.vy = -Math.abs(t.vy); }
      }
    }

    function paintTiles() {
      if (cfg.edgeFade) {
        const cw = bounds.w, ch = bounds.h;
        const fieldCx = cw / 2, fieldCy = ch / 2;
        const outerRX = Math.max(1, (cw / 2) * cfg.outerRxFrac);
        const outerRY = Math.max(1, (ch / 2) * cfg.outerRyFrac);
        for (const t of tiles) {
          const dxc = t.x - fieldCx;
          const dyc = t.y - fieldCy;
          const sOuter = Math.hypot(dxc / outerRX, dyc / outerRY);
          let a;
          if (sOuter < 0.78)      a = 1;
          else if (sOuter < 1.12) a = 1 - (sOuter - 0.78) / 0.34 * 0.92;
          else                    a = 0.08;
          t.fadeAlpha = t.hovered ? 1 : Math.max(0.08, Math.min(1, a));
          t.el.style.opacity = t.fadeAlpha === 1 ? '' : String(t.fadeAlpha);
          t.el.style.transform = `translate3d(${t.x}px, ${t.y}px, 0)`;
        }
      } else {
        // 100% opaque mode — tiles never fade. Connecting lines and
        // hand-drawn borders also stay at full alpha (fadeAlpha = 1).
        for (const t of tiles) {
          t.fadeAlpha = 1;
          if (t.el.style.opacity) t.el.style.opacity = '';
          t.el.style.transform = `translate3d(${t.x}px, ${t.y}px, 0)`;
        }
      }
    }

    function drawJitteredSegment(ax, ay, bx, by, segs, rand, amp) {
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      const nx = -dy / len, ny = dx / len;
      ctx.beginPath();
      ctx.moveTo(ax - nx * 0.4, ay - ny * 0.4);
      for (let k = 1; k < segs; k++) {
        const t = k / segs;
        const jx = (rand() - 0.5) * amp * 2;
        const jy = (rand() - 0.5) * amp * 2;
        ctx.lineTo(ax + dx * t + nx * jx, ay + dy * t + ny * jy);
      }
      ctx.lineTo(bx + nx * 0.4, by + ny * 0.4);
      ctx.stroke();
    }

    function drawHandLine(ax, ay, bx, by, key, hot) {
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 4) return;
      const nx = -dy / len, ny = dx / len;
      const segs = Math.max(4, Math.round(len / 22));
      const rand = seededRand(key);
      const amp = Math.min(4.2, len * 0.018);

      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = hot ? 'rgba(20,18,14,0.62)' : 'rgba(70,65,56,0.36)';
      ctx.lineWidth = hot ? 1.1 : 0.85;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      for (let k = 1; k < segs; k++) {
        const t = k / segs;
        const jx = (rand() - 0.5) * amp * 2;
        const jy = (rand() - 0.5) * amp * 2;
        ctx.lineTo(ax + dx * t + nx * jx, ay + dy * t + ny * jy);
      }
      ctx.lineTo(bx, by);
      ctx.stroke();

      if (!hot) {
        ctx.strokeStyle = 'rgba(70,65,56,0.16)';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        const r2 = seededRand(key ^ 0x9E3779B9);
        ctx.moveTo(ax + nx * 0.6, ay + ny * 0.6);
        for (let k = 1; k < segs; k++) {
          const t = k / segs;
          const jx = (r2() - 0.5) * amp * 1.4;
          const jy = (r2() - 0.5) * amp * 1.4;
          ctx.lineTo(ax + dx * t + nx * (jx + 0.6), ay + dy * t + ny * (jy + 0.6));
        }
        ctx.lineTo(bx + nx * 0.6, by + ny * 0.6);
        ctx.stroke();
      }
    }

    function drawHandRect(cx, cy, w, h, key, hot) {
      const pad = 2;
      const x0 = cx - w/2 - pad, y0 = cy - h/2 - pad;
      const x1 = cx + w/2 + pad, y1 = cy + h/2 + pad;
      const segs = 5;
      const amp  = 1.1;
      const rand = seededRand(key | 0x800);

      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = hot ? 'rgba(20,18,14,0.78)' : 'rgba(58,52,44,0.62)';
      ctx.lineWidth   = hot ? 1.25 : 1.0;
      drawJitteredSegment(x0, y0, x1, y0, segs, rand, amp);
      drawJitteredSegment(x1, y0, x1, y1, segs, rand, amp);
      drawJitteredSegment(x1, y1, x0, y1, segs, rand, amp);
      drawJitteredSegment(x0, y1, x0, y0, segs, rand, amp);

      if (!hot) {
        ctx.strokeStyle = 'rgba(58,52,44,0.22)';
        ctx.lineWidth   = 0.7;
        const r2 = seededRand((key | 0x800) ^ 0x9E3779B9);
        const off = 0.7;
        drawJitteredSegment(x0 - off, y0 - off, x1 + off, y0 - off, segs, r2, amp * 0.8);
        drawJitteredSegment(x1 + off, y0 - off, x1 + off, y1 + off, segs, r2, amp * 0.8);
        drawJitteredSegment(x1 + off, y1 + off, x0 - off, y1 + off, segs, r2, amp * 0.8);
        drawJitteredSegment(x0 - off, y1 + off, x0 - off, y0 - off, segs, r2, amp * 0.8);
      }
    }

    function paintLines() {
      ctx.clearRect(0, 0, bounds.w, bounds.h);
      if (tiles.length < 2) return;
      const drawn = new Set();
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const dists = [];
        for (let j = 0; j < tiles.length; j++) {
          if (i === j) continue;
          const o = tiles[j];
          const d = Math.hypot(t.x - o.x, t.y - o.y);
          dists.push({ j, d });
        }
        dists.sort((a, b) => a.d - b.d);
        const links = dists.slice(0, cfg.neighbours);
        for (const { j } of links) {
          const k = pairKey(i, j);
          if (drawn.has(k)) continue;
          drawn.add(k);
          const o = tiles[j];
          const hot = t.hovered || o.hovered;
          // Line fades with the average of its endpoint tiles' alphas
          // so connections to fading tiles also soften smoothly.
          const lineAlpha = ((t.fadeAlpha || 1) + (o.fadeAlpha || 1)) * 0.5;
          if (lineAlpha > 0.02) {
            ctx.save();
            ctx.globalAlpha = lineAlpha;
            drawHandLine(t.x, t.y, o.x, o.y, k, hot);
            ctx.restore();
          }
        }
      }
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (t.hovered) continue;
        const a = t.fadeAlpha || 1;
        if (a < 0.02) continue;
        ctx.save();
        ctx.globalAlpha = a;
        drawHandRect(t.x, t.y, t.w, t.h, i + 1, false);
        ctx.restore();
      }

      // Synaptic pulses — spawn periodically, then draw all in flight.
      if (cfg.enableSignals) {
        const now = performance.now();
        maybeSpawnPulse(now);
        drawPulses(now);
      }
    }

    /* Pick a random tile + one of its nearest neighbors and start a
       pulse traveling between them. Mimics a synaptic firing between
       two paintings that are currently "in conversation". */
    function maybeSpawnPulse(now) {
      if (tiles.length < 2) return;
      if (pulses.length >= cfg.signalMaxInFlight) return;
      if (now - lastPulseSpawnT < cfg.signalMinGap) return;
      if (Math.random() > cfg.signalSpawnP) return;

      const i = Math.floor(Math.random() * tiles.length);
      // Find this tile's nearest neighbor (1-NN keeps pulses on the
      // strongest visual connections, which are the lines being drawn).
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < tiles.length; j++) {
        if (j === i) continue;
        const dx = tiles[i].x - tiles[j].x;
        const dy = tiles[i].y - tiles[j].y;
        const d = dx*dx + dy*dy;
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ < 0) return;
      pulses.push({
        aIdx: i, bIdx: bestJ,
        spawnT: now,
        duration: cfg.signalDuration * (0.85 + Math.random() * 0.4), // jitter ±20%
      });
      lastPulseSpawnT = now;
    }

    function drawPulses(now) {
      if (pulses.length === 0) return;
      const alive = [];
      for (const p of pulses) {
        const tp = (now - p.spawnT) / p.duration;
        if (tp >= 1) continue;
        const a = tiles[p.aIdx];
        const b = tiles[p.bIdx];
        if (!a || !b) continue;
        // Ease-out: bright start, settles into the destination
        const u = 1 - Math.pow(1 - tp, 2.0);
        const px = a.x + (b.x - a.x) * u;
        const py = a.y + (b.y - a.y) * u;
        // Brightness: rises quickly, lingers, fades at the end
        const visAlpha = Math.sin(tp * Math.PI);
        // Fade with the dimmer of the two endpoint alphas so signals
        // also dim when crossing fading tiles (edgeFade mode).
        const tileAlpha = Math.min(a.fadeAlpha || 1, b.fadeAlpha || 1);
        const finalAlpha = visAlpha * tileAlpha;
        if (finalAlpha > 0.02) drawPulseDot(px, py, finalAlpha);
        alive.push(p);
      }
      pulses = alive;
    }

    function drawPulseDot(x, y, alpha) {
      ctx.save();
      // Soft outer glow
      ctx.globalAlpha = alpha * cfg.signalGlowAlpha;
      ctx.fillStyle   = cfg.signalColor;
      ctx.beginPath();
      ctx.arc(x, y, cfg.signalRadius * cfg.signalGlowMul, 0, Math.PI * 2);
      ctx.fill();
      // Bright core
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = cfg.signalColor;
      ctx.beginPath();
      ctx.arc(x, y, cfg.signalRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function loop(now) {
      const dt = Math.min(64, now - lastT);
      lastT = now;
      if (running) step(dt * 0.1);
      paintTiles();
      paintLines();
      raf = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (isHidden) return;
      if (!inView || !tabVisible) return;
      if (raf) return;
      lastT = performance.now();
      raf = requestAnimationFrame(loop);
    }
    function stopLoop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    function boot() {
      resizeCanvas();
      buildTiles();
      stopLoop();
      startLoop();
    }

    // --- Resize observer (also handles initial sizing if container resizes due to fonts loading) ---
    let resizeT = 0;
    const onResize = () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        resizeCanvas();
        for (const t of tiles) {
          t.x = Math.max(cfg.margin, Math.min(bounds.w - cfg.margin, t.x));
          t.y = Math.max(cfg.margin, Math.min(bounds.h - cfg.margin, t.y));
        }
      }, 120);
    };
    window.addEventListener('resize', onResize);

    // --- IntersectionObserver: pause when off-screen ---
    let io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          inView = en.isIntersecting;
          if (inView) startLoop(); else stopLoop();
        }
      }, { rootMargin: '160px 0px', threshold: 0.01 });
      io.observe(container);
    }

    // --- Tab visibility ---
    const onVis = () => {
      tabVisible = !document.hidden;
      if (tabVisible) startLoop(); else stopLoop();
    };
    document.addEventListener('visibilitychange', onVis);

    // --- Mouse push: click-drag inside the field pushes tiles away.
    //     Document-level listeners (not on the container) so the wrapper
    //     can keep pointer-events:none and underlying clickable elements
    //     remain reachable. We just hit-test against the container rect. */
    function inFieldRect(clientX, clientY) {
      const r = container.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right) return null;
      if (clientY < r.top  || clientY > r.bottom) return null;
      return { x: clientX - r.left, y: clientY - r.top };
    }
    const onPointerDown = (e) => {
      if (!cfg.enablePush || isHidden) return;
      if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
      const p = inFieldRect(e.clientX, e.clientY);
      if (!p) return;
      pushing = true;
      pushX = p.x; pushY = p.y;
    };
    const onPointerMove = (e) => {
      if (!pushing) return;
      const p = inFieldRect(e.clientX, e.clientY);
      if (p) { pushX = p.x; pushY = p.y; }
    };
    const onPointerEnd = () => { pushing = false; };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerup',     onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);

    // --- Boot when ready ---
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }

    // --- Public API ---
    return {
      pause()  { running = false; },
      resume() { running = true; },
      isRunning() { return running; },
      resample() { if (!isHidden) boot(); },
      hide()   {
        isHidden = true;
        stopLoop();
        container.style.display = 'none';
      },
      show()   {
        if (!isHidden) return;
        isHidden = false;
        container.style.display = '';
        // re-size after un-hiding (display:none reports 0x0)
        resizeCanvas();
        if (!tiles.length) buildTiles();
        startLoop();
      },
      isHidden() { return isHidden; },
      sampleCount() { return tiles.length; },
      totalCount()  { return works.length; },
      destroy() {
        stopLoop();
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onVis);
        document.removeEventListener('pointerdown',  onPointerDown);
        document.removeEventListener('pointermove',  onPointerMove);
        document.removeEventListener('pointerup',     onPointerEnd);
        document.removeEventListener('pointercancel', onPointerEnd);
        window.removeEventListener('resize', onResize);
        container.innerHTML = '';
        container.classList.remove('rk-field', 'rk-has-hover');
        tiles = [];
      },
    };
  }

  window.RaghavaNetwork = { init };
})();
