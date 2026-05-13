/* ─────────────────────────────────────────────────────
   LIBRARY SHELF — hybrid-physics editorial bookshelf
   Shared module used by library2.html (full) and lab2.html
   (compact, embedded under the ▢ row).

   Drawing language inherited from Field №01: graphite
   jittered shelf line, red synaptic pulses traveling
   between adjacent books. No skeuomorphism — the shelf
   is a hand-drawn line, not a wood plank.

   Physics:
     - Each book rests on the shelf at a fixed x.
     - baseAngle = small lean ±2–4° (deterministic per book).
     - Per-frame breathing sway adds ±0.4°.
     - Events fire every ~6–10s: a random book stretches up,
       slumps another 2° into a neighbor, or swaps places
       with the adjacent book over ~1.2s.
     - Hover lifts a book ~6–8px and rights it to ~0°.

   Mobile (≤720px):
     - Single horizontal scrolling row (the row metaphor
       collapses into one continuous shelf).
     - No events — breathing only. Reduced motion drops
       breathing too.

   Public API:
     window.RaghavaLibraryShelf.init({ container, rows, compact?, dataKey? })
       → returns { destroy, pause, resume }
   ───────────────────────────────────────────────────── */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Deterministic per-string seed → mulberry32 PRNG (same as Field №01)
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

  function init(opts) {
    if (!opts || !opts.container) return null;
    const rows = opts.rows || [];
    const compact = !!opts.compact;
    const container = opts.container;

    container.classList.add('library-shelf');
    if (compact) container.classList.add('compact');

    const isMobile = window.matchMedia('(max-width: 720px)').matches;

    // ── Build the DOM for each row, register each tile object.
    const rowStates = [];

    rows.forEach((rowDef, rowIndex) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'library-row';

      const headEl = document.createElement('div');
      headEl.className = 'library-row__head';
      headEl.innerHTML =
        '<span class="library-row__label">' + escAttr(rowDef.label || ('Row ' + (rowIndex + 1))) + '</span>' +
        '<span class="library-row__note">' + escAttr(rowDef.note || '') + '</span>';
      rowEl.appendChild(headEl);

      const stageEl = document.createElement('div');
      stageEl.className = 'library-row__stage';
      rowEl.appendChild(stageEl);

      const canvas = document.createElement('canvas');
      canvas.className = 'library-row__canvas';
      stageEl.appendChild(canvas);

      // Books: lay out left to right. Cover tiles take the cover's natural
      // aspect (book.aspect, w/h). Spine tiles are narrow rectangles whose
      // width hints at the book's apparent thickness.
      const tiles = [];
      const leftGutter = 14;
      let cursorX = leftGutter;
      const gap = compact ? 6 : 9; // tighter so books read as touching
      const baseFloor = 24;        // px above stage bottom where the shelf board top sits — matches CSS `bottom: 24px` on .book-tile
      const rng = mulberry32(strSeed('library-row:' + rowIndex + ':' + (rowDef.label || '')));

      // Build the row state up front so closures inside the tile-creation
      // loop can reach it (drag handlers need the row reference).
      const rowState = {
        rowEl: rowEl,
        stageEl: stageEl,
        canvas: canvas,
        ctx: canvas.getContext('2d'),
        tiles: tiles,
        order: tiles,        // current visual order — drag mutates this
        contentWidth: 0,     // filled in after the loop
        baseFloor: baseFloor,
        gap: gap,
        leftGutter: leftGutter,
        offset: 0,           // horizontal center offset, set in size()
        rng: mulberry32(strSeed('library-pulses:' + rowIndex)),
        nextEventAt: performance.now() + (6000 + Math.random() * 4000),
        pulses: [],
        nextPulseAt: performance.now() + (1400 + Math.random() * 2200),
        dragging: null       // { tile, downX, downY, originX, moved, pointerId }
      };
      rowStates.push(rowState);

      (rowDef.books || []).forEach((book, i) => {
        const r1 = rng(), r2 = rng(), r3 = rng();
        const isSpine = book.face === 'spine';

        // Height range — covers slightly taller than spines, like real shelves.
        // Spines vary a little so the shelf doesn't read as a fence.
        let w, h;
        if (isSpine) {
          h = (compact ? 162 : 184) + Math.floor(r2 * (compact ? 12 : 18));
          // Spine width hints at book thickness: 38-56 (or 32-48 compact).
          w = (compact ? 32 : 38) + Math.floor(r1 * (compact ? 16 : 18));
        } else {
          h = (compact ? 168 : 196) + Math.floor(r2 * (compact ? 10 : 16));
          // Width = height * actual cover aspect (fallback 0.70 if missing).
          const aspect = (typeof book.aspect === 'number' && book.aspect > 0.3 && book.aspect < 1.5) ? book.aspect : 0.70;
          w = Math.round(h * aspect);
        }
        const baseAngle = (r3 * 5 - 2.5); // ±2.5° range — slightly calmer than before
        const phase = rng() * Math.PI * 2;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'book-tile ' + (isSpine ? ('face-spine hue-' + (book.spineHue || 'cream')) : 'face-cover');
        btn.style.width = w + 'px';
        btn.style.height = h + 'px';
        btn.style.left = cursorX + 'px';
        btn.setAttribute('aria-label', book.title + (book.year ? (', ' + book.year) : ''));

        if (isSpine) {
          // Spine: head page-edge band, colored spine body with vertical title
          // and a year stamp near the foot, tail page-edge band.
          btn.innerHTML =
            '<span class="spine-page-edge head" aria-hidden="true"></span>' +
            '<span class="spine-body">' +
              '<span class="tile-spine-title">' + escAttr(book.title) + '</span>' +
              '<span class="spine-year">' + escAttr(String(book.year || '')) + '</span>' +
            '</span>' +
            '<span class="spine-page-edge tail" aria-hidden="true"></span>' +
            '<span class="tile-caption">' + escAttr(book.title) + ' · ' + escAttr(String(book.year || '')) + '</span>';
        } else {
          // Cover face-out: thin page-edge stripe above the cover, spine-edge
          // sliver on the left, real <img> rendering the cover at the tile's
          // aspect-correct size.
          const thumbAttr = String(book.thumb || '').replace(/"/g, '&quot;');
          btn.innerHTML =
            '<span class="tile-page-top" aria-hidden="true"></span>' +
            '<img class="tile-cover-img" src="' + thumbAttr + '" alt="" loading="lazy" decoding="async" draggable="false" />' +
            '<span class="tile-spine-edge" aria-hidden="true"></span>' +
            '<span class="tile-caption">' + escAttr(book.title) + ' · ' + escAttr(String(book.year || '')) + '</span>';
        }

        stageEl.appendChild(btn);

        const tile = {
          el: btn,
          x: cursorX,
          baseX: cursorX,
          slotX: cursorX,       // target position; tiles ease toward this
          width: w,
          height: h,
          baseAngle: baseAngle,
          angle: baseAngle,
          extraLean: 0,
          extraLeanTarget: 0,
          phase: phase,
          lift: 0,
          liftTarget: 0,
          hover: false,
          swap: null,           // { partner, startTime, fromX, toX }
          isDragging: false,
          dragLift: 0,
          suppressClickUntil: 0
        };
        tiles.push(tile);

        // Click handler — suppressed for ~250ms after a real drag so the
        // modal doesn't open as a side effect of dropping a book.
        btn.addEventListener('click', (e) => {
          if (performance.now() < tile.suppressClickUntil) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (window.RaghavaBookModal && typeof window.RaghavaBookModal.open === 'function') {
            window.RaghavaBookModal.open(book);
          }
        });

        // Hover handlers — rights the book and lifts it
        btn.addEventListener('pointerenter', () => {
          if (tile.isDragging) return;
          tile.hover = true;
          tile.liftTarget = compact ? 6 : 8;
        });
        btn.addEventListener('pointerleave', () => {
          if (tile.isDragging) return;
          tile.hover = false;
          tile.liftTarget = 0;
        });
        btn.addEventListener('focus', () => { tile.hover = true; tile.liftTarget = compact ? 6 : 8; });
        btn.addEventListener('blur',  () => { tile.hover = false; tile.liftTarget = 0; });

        // Drag-to-reorder — register the candidate; promotion to active drag
        // happens once the pointer moves more than the threshold. Skipped on
        // mobile so the horizontal shelf-scroll gesture isn't intercepted.
        btn.addEventListener('pointerdown', (e) => {
          if (isMobile) return;
          if (e.button !== undefined && e.button !== 0) return;
          startDrag(rowState, tile, e);
        });

        // Prevent the native HTML5 drag behavior on the cover <img> children
        btn.addEventListener('dragstart', (e) => e.preventDefault());

        cursorX += w + gap;
      });

      // Stage minimum width (used for the canvas on desktop and the
      // scroll width on mobile)
      rowState.contentWidth = cursorX + 14;
      // Seed each tile's slotX so the per-frame easing has a target.
      rowState.tiles.forEach(t => { t.slotX = t.x; });

      container.appendChild(rowEl);
    });

    // ── Sizing pass: set canvas resolution + ensure mobile scroll width.
    // Also (re)computes the horizontal center offset and the per-tile slotX
    // from the row's current `order`. Drag handlers depend on slotX being
    // the authoritative target for non-dragged tiles.
    function size() {
      const dpr = window.devicePixelRatio || 1;
      rowStates.forEach(r => {
        const rect = r.stageEl.getBoundingClientRect();
        const cssWidth  = isMobile ? Math.max(rect.width, r.contentWidth) : rect.width;
        const cssHeight = rect.height;
        r.canvas.style.width = cssWidth + 'px';
        r.canvas.style.height = cssHeight + 'px';
        r.canvas.width  = Math.round(cssWidth  * dpr);
        r.canvas.height = Math.round(cssHeight * dpr);
        r.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        r.cssWidth = cssWidth;
        r.cssHeight = cssHeight;
        // On desktop, center the shelf horizontally if narrower than stage.
        r.offset = (!isMobile && r.contentWidth < cssWidth)
          ? Math.floor((cssWidth - r.contentWidth) / 2)
          : 0;
        // Lay slot positions according to the current order, applying the offset.
        layoutSlots(r);
        // Snap any non-dragged tiles immediately to their new slots on resize.
        r.tiles.forEach(t => {
          if (!t.isDragging) {
            t.x = t.slotX;
            t.el.style.left = t.x + 'px';
          }
        });
      });
    }

    // ── Slot layout: walk r.order left-to-right, assign each tile's slotX.
    // Skips the dragging tile if any (its slot is held open by the others
    // shifting around it). Returns the cumulative content width.
    function layoutSlots(r) {
      let cx = r.leftGutter + r.offset;
      for (let i = 0; i < r.order.length; i++) {
        const t = r.order[i];
        t.slotX = cx;
        cx += t.width + r.gap;
      }
      return cx;
    }

    // ── Drag-to-reorder
    function startDrag(r, tile, e) {
      // Cancel any in-flight swap/event animation on this tile.
      tile.swap = null;
      tile.extraLeanTarget = 0;
      r.dragging = {
        tile: tile,
        downX: e.clientX,
        downY: e.clientY,
        originX: tile.x,
        moved: false,
        pointerId: e.pointerId
      };
      try { tile.el.setPointerCapture(e.pointerId); } catch (err) { /* not all pointers */ }
      tile.el.addEventListener('pointermove', onDragMovePtr);
      tile.el.addEventListener('pointerup',   onDragEndPtr);
      tile.el.addEventListener('pointercancel', onDragEndPtr);
    }

    function rowFromTile(tile) {
      for (let i = 0; i < rowStates.length; i++) {
        if (rowStates[i].tiles.indexOf(tile) !== -1) return rowStates[i];
      }
      return null;
    }

    function onDragMovePtr(e) {
      // Find which row this pointer is dragging on.
      let active = null;
      for (let i = 0; i < rowStates.length; i++) {
        if (rowStates[i].dragging && rowStates[i].dragging.pointerId === e.pointerId) {
          active = rowStates[i];
          break;
        }
      }
      if (!active) return;
      const d = active.dragging;
      const tile = d.tile;
      const dx = e.clientX - d.downX;
      const dy = e.clientY - d.downY;

      if (!d.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        d.moved = true;
        tile.isDragging = true;
        tile.hover = false;
        tile.liftTarget = 0;
        tile.dragLift = compact ? 14 : 18;
        tile.el.classList.add('is-dragging');
      }

      // Move the dragged tile in row-local coordinates.
      const newX = Math.max(
        active.leftGutter + active.offset - 4,
        Math.min(
          active.contentWidth + active.offset - tile.width - active.leftGutter + 4,
          d.originX + dx
        )
      );
      tile.x = newX;
      tile.el.style.left = newX + 'px';

      // Recompute the row order based on the dragged tile's current center,
      // then re-layout slotX for everyone (except the dragged tile, whose
      // x is driven by the cursor).
      const dragCenter = newX + tile.width / 2;
      const others = active.order.filter(t => t !== tile);
      // Walk the layout positions OF THE OTHERS to find the insertion index.
      let cursor = active.leftGutter + active.offset;
      let newIndex = others.length;
      for (let i = 0; i < others.length; i++) {
        const slotCenter = cursor + others[i].width / 2;
        if (dragCenter < slotCenter) {
          newIndex = i;
          break;
        }
        cursor += others[i].width + active.gap;
      }
      const nextOrder = others.slice();
      nextOrder.splice(newIndex, 0, tile);

      // If order changed, commit it and re-layout slots.
      let changed = nextOrder.length !== active.order.length;
      if (!changed) {
        for (let i = 0; i < nextOrder.length; i++) {
          if (nextOrder[i] !== active.order[i]) { changed = true; break; }
        }
      }
      if (changed) {
        active.order = nextOrder;
        layoutSlots(active);
        // The dragged tile's slotX is computed too — but its actual x stays
        // at the cursor until release; the slot is the rest position.
      }
    }

    function onDragEndPtr(e) {
      let active = null;
      for (let i = 0; i < rowStates.length; i++) {
        if (rowStates[i].dragging && rowStates[i].dragging.pointerId === e.pointerId) {
          active = rowStates[i];
          break;
        }
      }
      if (!active) return;
      const d = active.dragging;
      const tile = d.tile;
      try { tile.el.releasePointerCapture(e.pointerId); } catch (err) { /* */ }
      tile.el.removeEventListener('pointermove', onDragMovePtr);
      tile.el.removeEventListener('pointerup',   onDragEndPtr);
      tile.el.removeEventListener('pointercancel', onDragEndPtr);
      active.dragging = null;

      if (d.moved) {
        tile.isDragging = false;
        tile.dragLift = 0;
        tile.el.classList.remove('is-dragging');
        // Suppress the trailing click (it would otherwise open the modal).
        tile.suppressClickUntil = performance.now() + 350;
      }
      // tile.x will ease toward tile.slotX in tickTiles, settling the book
      // into its new slot.
    }

    // ── Spine title auto-fit
    // Vertical-rl text on a thin spine can easily exceed the spine's height
    // for long titles. Shrink font-size in 0.5px steps until the text's
    // intrinsic length (scrollHeight in vertical-rl writing mode) fits the
    // element's clientHeight. Floor at 8px so it never disappears.
    function fitSpineTitle(titleEl) {
      if (!titleEl) return;
      let fs = 12;
      titleEl.style.fontSize = fs + 'px';
      // scrollHeight in writing-mode: vertical-rl reflects the natural length
      // of the text in the inline (vertical) direction.
      while (titleEl.scrollHeight > titleEl.clientHeight && fs > 8) {
        fs -= 0.5;
        titleEl.style.fontSize = fs + 'px';
      }
    }
    function fitAllSpineTitles() {
      rowStates.forEach(r => {
        r.tiles.forEach(t => {
          const titleEl = t.el.querySelector('.tile-spine-title');
          if (titleEl) fitSpineTitle(titleEl);
        });
      });
    }

    size();
    fitAllSpineTitles();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitAllSpineTitles);
    }
    window.addEventListener('resize', () => { size(); fitAllSpineTitles(); });

    // ── Event vocabulary (desktop only, non-reduced-motion only)
    // Skips any row that's currently being dragged so a passive event
    // doesn't fight the user's intent.
    function fireEvent(r, now) {
      if (!r.order.length || r.dragging) return;
      const idx = Math.floor(r.rng() * r.order.length);
      const tile = r.order[idx];
      const which = Math.floor(r.rng() * 3); // 0=stretch, 1=slump, 2=swap
      if (which === 0) {
        // Stretch: lift then settle
        tile.liftTarget = 6;
        setTimeout(() => { if (!tile.hover) tile.liftTarget = 0; }, 700);
      } else if (which === 1) {
        // Slump: extra lean toward neighbor
        const dir = r.rng() < 0.5 ? -1 : 1;
        tile.extraLeanTarget = dir * 2.2;
        setTimeout(() => { tile.extraLeanTarget = 0; }, 1300);
      } else {
        // Swap with visual neighbor — mutate r.order, re-layout slots,
        // let the easing animate everyone into place.
        const neighborIdx = idx + (r.rng() < 0.5 ? -1 : 1);
        if (neighborIdx < 0 || neighborIdx >= r.order.length) {
          tile.liftTarget = 4;
          setTimeout(() => { if (!tile.hover) tile.liftTarget = 0; }, 600);
          return;
        }
        const a = r.order[idx], b = r.order[neighborIdx];
        const nextOrder = r.order.slice();
        nextOrder[idx] = b;
        nextOrder[neighborIdx] = a;
        r.order = nextOrder;
        layoutSlots(r);
      }
    }

    // ── Pulse spawn — pick a random pair of visually-adjacent books and
    // send a red dot along the shelf between them. Uses r.order (the visual
    // order after drag-reorders) rather than r.tiles (creation order).
    function spawnPulse(r, now) {
      if (r.order.length < 2) return;
      const i = Math.floor(r.rng() * (r.order.length - 1));
      const a = r.order[i], b = r.order[i + 1];
      r.pulses.push({
        ax: a.x + a.width / 2,
        bx: b.x + b.width / 2,
        y: r.cssHeight - r.baseFloor - 1,
        t0: now,
        duration: 760 + Math.random() * 200
      });
    }

    // ── Draw the shelf board + drop shadow + contact shadows + red pulses.
    // The shelf is rendered as a graphite-drawn BOARD with thickness, not a
    // single line — top edge, body fill, bottom edge, then a soft cast
    // shadow below. Each book gets a small contact shadow at its foot.
    function drawShelf(r) {
      const ctx = r.ctx;
      ctx.clearRect(0, 0, r.cssWidth, r.cssHeight);

      // Board geometry: top edge sits at yTop (= where books rest),
      // bottom edge at yBot. Board is ~6px tall on desktop, ~5px compact.
      const boardTopY = r.cssHeight - r.baseFloor;
      const boardThickness = compact ? 5 : 6;
      const boardBottomY = boardTopY + boardThickness;
      const xStart = 6;
      const xEnd = (isMobile ? Math.max(r.cssWidth, r.contentWidth) : r.cssWidth) - 6;

      // ── Contact shadows under each book (drawn first, behind everything)
      ctx.save();
      for (let i = 0; i < r.tiles.length; i++) {
        const t = r.tiles[i];
        const cx = t.x + t.width / 2;
        const yShadow = boardTopY + 0.5;
        // Width of contact shadow tracks book width
        const sw = Math.max(t.width * 0.6, 22);
        const sh = 3.5;
        // Hover books lift, contact softens
        const liftFade = Math.max(0, 1 - t.lift / 12);
        const alpha = 0.22 * liftFade;
        if (alpha < 0.01) continue;
        ctx.beginPath();
        ctx.ellipse(cx, yShadow, sw / 2, sh, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,18,14,' + alpha.toFixed(3) + ')';
        ctx.fill();
      }
      ctx.restore();

      // ── Polyline points for the shelf top + bottom edges (jittered).
      const segLen = 14;
      const xs = [];
      for (let x = xStart; x <= xEnd; x += segLen) xs.push(x);
      if (xs[xs.length - 1] !== xEnd) xs.push(xEnd);

      function jitteredLine(seedTag, baseY, amplitude) {
        const r2 = mulberry32(strSeed('shelf:' + seedTag));
        const pts = [];
        for (let i = 0; i < xs.length; i++) {
          pts.push({ x: xs[i], y: baseY + (r2() * 2 - 1) * amplitude });
        }
        return pts;
      }
      const topPts = jitteredLine('top', boardTopY, 0.55);
      const botPts = jitteredLine('bot', boardBottomY, 0.7);

      // ── Board body fill: subtle cream-darker band between top and bottom.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(topPts[0].x, topPts[0].y);
      for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
      for (let i = botPts.length - 1; i >= 0; i--) ctx.lineTo(botPts[i].x, botPts[i].y);
      ctx.closePath();
      const bandGrad = ctx.createLinearGradient(0, boardTopY, 0, boardBottomY);
      bandGrad.addColorStop(0,   'rgba(70,65,56,0.07)');
      bandGrad.addColorStop(0.55,'rgba(70,65,56,0.13)');
      bandGrad.addColorStop(1,   'rgba(70,65,56,0.06)');
      ctx.fillStyle = bandGrad;
      ctx.fill();
      ctx.restore();

      // ── Top edge (the hard graphite line books rest against)
      function strokePolyline(pts, color, width) {
        ctx.beginPath();
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
          else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
      }
      strokePolyline(topPts, 'rgba(20,18,14,0.78)', 1.0);
      // Fainter parallel grain on the top edge
      strokePolyline(topPts.map(p => ({ x: p.x, y: p.y - 0.5 })), 'rgba(58,52,44,0.18)', 1.0);
      // Bottom edge (a hair softer than the top)
      strokePolyline(botPts, 'rgba(20,18,14,0.55)', 1.0);
      strokePolyline(botPts.map(p => ({ x: p.x, y: p.y + 0.5 })), 'rgba(58,52,44,0.16)', 1.0);

      // ── Drop shadow band BELOW the shelf, fading down
      ctx.save();
      const dropGrad = ctx.createLinearGradient(0, boardBottomY, 0, boardBottomY + 12);
      dropGrad.addColorStop(0, 'rgba(20,18,14,0.22)');
      dropGrad.addColorStop(1, 'rgba(20,18,14,0)');
      ctx.fillStyle = dropGrad;
      ctx.fillRect(xStart, boardBottomY + 0.5, xEnd - xStart, 12);
      ctx.restore();

      // ── Pulses (red synaptic dots, traveling along the board's top edge)
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

    // ── Per-frame tile update
    function tickTiles(r, now) {
      const breathAmpDeg = reduceMotion ? 0 : 0.4;
      const breathPeriod = 5200;
      const breathTau = (now / breathPeriod) * Math.PI * 2;

      for (let i = 0; i < r.tiles.length; i++) {
        const t = r.tiles[i];

        // ── Position
        if (t.isDragging) {
          // Dragged tile follows the cursor — x is driven by the drag handler,
          // not by easing. Just ensure style.left is in sync (drag handler
          // already does this each pointermove).
        } else if (t.swap) {
          // Legacy programmatic swap animation (still used by the events
          // vocabulary). Tween directly between fromX and toX.
          const dur = 1200;
          const elapsed = now - t.swap.t0;
          const u = Math.min(1, elapsed / dur);
          const ease = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          t.x = t.swap.fromX + (t.swap.toX - t.swap.fromX) * ease;
          t.el.style.left = t.x + 'px';
          if (u >= 1) {
            t.slotX = t.swap.toX;
            t.baseX = t.swap.toX - (r.offset || 0);
            t.swap = null;
          }
        } else {
          // Non-dragged, non-swap tiles ease toward their slotX. This is what
          // makes books slide aside when a neighbor is being dragged, and snap
          // into place on release.
          const dx = t.slotX - t.x;
          if (Math.abs(dx) > 0.25) {
            t.x += dx * 0.22;
            t.el.style.left = t.x + 'px';
          } else if (t.x !== t.slotX) {
            t.x = t.slotX;
            t.el.style.left = t.x + 'px';
          }
        }

        // ── Lift composition (hover/event + active drag)
        const liftEase = t.hover ? 0.18 : 0.12;
        t.lift += (t.liftTarget - t.lift) * liftEase;
        const dragLiftEase = t.isDragging ? 0.3 : 0.18;
        t.dragLift += ((t.isDragging ? (compact ? 14 : 18) : 0) - t.dragLift) * dragLiftEase;

        // ── Lean
        t.extraLean += (t.extraLeanTarget - t.extraLean) * 0.08;

        // angle = base + breath + extra. Hover and drag both right the book.
        const baseInfluence = (t.hover || t.isDragging) ? 0 : t.baseAngle;
        const breath = Math.sin(breathTau + t.phase) * (t.isDragging ? 0 : breathAmpDeg);
        const dragWobble = t.isDragging ? Math.sin(now * 0.012) * 0.8 : 0;
        const angle = baseInfluence + breath + t.extraLean + dragWobble;

        const totalLift = t.lift + t.dragLift;
        t.el.style.transform = 'translate(0, ' + (-totalLift).toFixed(2) + 'px) rotate(' + angle.toFixed(3) + 'deg)';
      }
    }

    // ── Loop
    let running = true;
    let rafId = null;
    function loop() {
      if (!running) return;
      const now = performance.now();
      rowStates.forEach(r => {
        // Events (desktop, non-reduced-motion only)
        if (!isMobile && !reduceMotion && now >= r.nextEventAt) {
          fireEvent(r, now);
          r.nextEventAt = now + 6000 + Math.random() * 4000;
        }
        // Pulses
        if (!reduceMotion && now >= r.nextPulseAt) {
          spawnPulse(r, now);
          r.nextPulseAt = now + 1400 + Math.random() * 2200;
        }
        tickTiles(r, now);
        drawShelf(r);
      });
      rafId = requestAnimationFrame(loop);
    }
    loop();

    // ── Pause when off-screen
    const io = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          if (!running) { running = true; loop(); }
        } else {
          running = false;
          if (rafId) cancelAnimationFrame(rafId);
        }
      });
    }, { threshold: 0 }) : null;
    if (io) io.observe(container);

    function onVis() {
      if (document.hidden) {
        running = false;
        if (rafId) cancelAnimationFrame(rafId);
      } else if (!running) {
        running = true;
        loop();
      }
    }
    document.addEventListener('visibilitychange', onVis);

    function destroy() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (io) io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', size);
      container.classList.remove('library-shelf', 'compact');
      container.innerHTML = '';
    }

    return {
      destroy: destroy,
      pause:  () => { running = false; if (rafId) cancelAnimationFrame(rafId); },
      resume: () => { if (!running) { running = true; loop(); } },
      get isRunning() { return running; }
    };
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.RaghavaLibraryShelf = { init: init };
})();
