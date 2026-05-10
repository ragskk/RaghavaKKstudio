/* ─────────────────────────────────────────────────────────────
   Raghava KK · /draw — paint trail tool
   Modular: delete this file + remove its <script> tag for clean removal.

   What's here
   ───────────
   · Paint trail with main line + lag-lines (harmony.js feel)
   · Strokes drift slowly upward + sway + rotate after release (smoke physics)
   · Strokes fade out and disappear over 8–14s
   · Site palette only: ink, red, faint grey
   · Speed-aware stroke width
   · UI bottom-right: ✎ Draw toggle. When active: ⌫ Clear button + tiny help
   · Keyboard: D toggle · C clear · Esc exit
   · Reduced-motion users: no drift, fast clear
   ───────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Config ──
  // Red, black, and white. Three-color palette, equal-ish chance.
  const PALETTE         = ['#0E0E0C', '#E63D22', '#FFFFFF'];
  const PALETTE_WEIGHTS = [0.50,       0.30,       0.20];
  const LIFE_RANGE_MS   = [8000, 14000];
  const SATELLITES      = 3;
  const MAX_STROKES     = 80;
  const DRIFT_VY_RANGE  = [-0.030, -0.012];     // px/ms upward
  const DRIFT_VX_RANGE  = [-0.018,  0.018];     // px/ms horizontal sway
  const ROT_VEL_RANGE   = [-0.00009, 0.00009];  // radians/ms

  // ── State ──
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dpr  = Math.max(1, window.devicePixelRatio || 1);
  let isOn   = false;
  let strokes = [];
  let inProgress = null;
  let canvas, ctx, btn, clearBtn, help, hideHelpTimer;

  // ── Helpers ──
  const rand = (a, b) => a + Math.random() * (b - a);
  function pickColor() {
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < PALETTE.length; i++) {
      acc += PALETTE_WEIGHTS[i];
      if (r < acc) return PALETTE[i];
    }
    return PALETTE[0];
  }

  // ── Canvas ──
  function buildCanvas() {
    canvas = document.createElement('canvas');
    canvas.id = 'rkkDrawCanvas';
    Object.assign(canvas.style, {
      position: 'fixed', inset: '0',
      pointerEvents: 'none', zIndex: '8500',
      // No blend mode — white strokes need to render true. Ink/red still
      // sit boldly over the cream page.
      touchAction: 'none'
    });
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    addEventListener('resize', resize);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
  }
  function resize() {
    canvas.width  = innerWidth  * dpr;
    canvas.height = innerHeight * dpr;
    canvas.style.width  = innerWidth  + 'px';
    canvas.style.height = innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── UI ──
  function buildUI() {
    const css = `
      .rkk-draw-btn,
      .rkk-draw-clear {
        position: fixed; z-index: 9001;
        font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
        font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
        padding: 0.6rem 0.85rem; cursor: pointer;
        background: rgba(244,241,234,0.94); color: #0E0E0C;
        border: 1px solid #0E0E0C;
        display: inline-flex; align-items: center; gap: 0.45rem;
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        transition: background .25s ease, color .25s ease, transform .25s ease, opacity .25s ease;
        user-select: none;
      }
      .rkk-draw-btn { bottom: 1.4rem; right: 1.4rem; }
      .rkk-draw-btn:hover { background: #0E0E0C; color: #F4F1EA; }
      .rkk-draw-btn.is-on { background: #E63D22; color: #F4F1EA; border-color: #E63D22; }
      .rkk-draw-btn.is-on:hover { background: #0E0E0C; border-color: #0E0E0C; }
      .rkk-draw-btn .icon { font-size: 13px; line-height: 1; }
      .rkk-draw-btn.is-on .icon { animation: rkk-draw-pulse 1.4s ease-in-out infinite; }
      @keyframes rkk-draw-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }

      .rkk-draw-clear {
        bottom: 1.4rem;
        right: 9.5rem;
        opacity: 0; pointer-events: none;
        transform: translateX(8px);
      }
      .rkk-draw-clear.is-visible { opacity: 1; pointer-events: auto; transform: translateX(0); }
      .rkk-draw-clear:hover { background: #0E0E0C; color: #F4F1EA; }

      .rkk-draw-help {
        position: fixed; z-index: 9001;
        bottom: 4rem; right: 1.4rem;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 9.5px; letter-spacing: 0.22em; text-transform: uppercase;
        color: #2B2A26;
        background: rgba(244,241,234,0.94); padding: 0.45rem 0.7rem;
        border: 1px solid rgba(14,14,12,0.18);
        opacity: 0; transform: translateY(6px);
        transition: opacity .35s ease, transform .35s ease;
        pointer-events: none;
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      }
      .rkk-draw-help.is-visible { opacity: 1; transform: translateY(0); }
      .rkk-draw-help kbd {
        font: inherit; padding: 0.1rem 0.35rem;
        background: rgba(14,14,12,0.07); border-radius: 2px;
        margin-right: 0.2rem; color: #0E0E0C;
      }

      @media (max-width: 640px) {
        .rkk-draw-btn { bottom: 1rem; right: 1rem; }
        .rkk-draw-clear { right: 8rem; bottom: 1rem; }
        .rkk-draw-help { right: 1rem; bottom: 3.5rem; }
      }
      @media (hover: none) and (pointer: coarse) {
        .rkk-draw-help { display: none; }
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    btn = document.createElement('button');
    btn.className = 'rkk-draw-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle drawing mode');
    btn.innerHTML = '<span class="icon" aria-hidden="true">✎</span><span class="label">draw</span>';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);

    clearBtn = document.createElement('button');
    clearBtn.className = 'rkk-draw-clear';
    clearBtn.type = 'button';
    clearBtn.setAttribute('aria-label', 'Clear drawings');
    clearBtn.innerHTML = '<span aria-hidden="true">⌫</span> clear';
    clearBtn.addEventListener('click', clearAll);
    document.body.appendChild(clearBtn);

    help = document.createElement('div');
    help.className = 'rkk-draw-help';
    help.innerHTML = '<kbd>D</kbd> toggle &nbsp;·&nbsp; <kbd>C</kbd> clear &nbsp;·&nbsp; <kbd>Esc</kbd> exit';
    document.body.appendChild(help);
  }

  function setOn(v) {
    isOn = v;
    canvas.style.pointerEvents = isOn ? 'auto' : 'none';
    btn.classList.toggle('is-on', isOn);
    btn.querySelector('.label').textContent = isOn ? 'drawing' : 'draw';
    clearBtn.classList.toggle('is-visible', isOn);
    if (isOn) showHelp();
    else hideHelp();
  }
  function toggle()   { setOn(!isOn); }
  function clearAll() { strokes = []; inProgress = null; }
  function showHelp() {
    help.classList.add('is-visible');
    clearTimeout(hideHelpTimer);
    hideHelpTimer = setTimeout(() => help.classList.remove('is-visible'), 3500);
  }
  function hideHelp() {
    help.classList.remove('is-visible');
    clearTimeout(hideHelpTimer);
  }

  // ── Drawing handlers ──
  function onPointerDown(e) {
    if (!isOn) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const color = pickColor();
    inProgress = {
      pts:    [{ x: e.clientX, y: e.clientY, t: performance.now() }],
      color,
      width:  1.6 + Math.random() * 2.4,
      born:   performance.now(),
      life:   rand(LIFE_RANGE_MS[0], LIFE_RANGE_MS[1]),
      vx:     reduceMotion ? 0 : rand(DRIFT_VX_RANGE[0], DRIFT_VX_RANGE[1]),
      vy:     reduceMotion ? 0 : rand(DRIFT_VY_RANGE[0], DRIFT_VY_RANGE[1]),
      rotV:   reduceMotion ? 0 : rand(ROT_VEL_RANGE[0], ROT_VEL_RANGE[1]),
    };
  }
  function onPointerMove(e) {
    if (!isOn || !inProgress) return;
    const last = inProgress.pts[inProgress.pts.length - 1];
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (dx*dx + dy*dy < 4) return; // de-dupe close points
    inProgress.pts.push({ x: e.clientX, y: e.clientY, t: performance.now() });
  }
  function onPointerUp(e) {
    if (!isOn) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (inProgress && inProgress.pts.length >= 2) {
      strokes.push(inProgress);
      while (strokes.length > MAX_STROKES) strokes.shift();
    }
    inProgress = null;
  }

  // ── Render ──
  function drawStroke(s, now) {
    const age = now - s.born;
    const t   = Math.min(1, age / s.life);
    // Ease-in opacity decay (slower fade at start, fast at end)
    const opacity = Math.max(0, 1 - (t * t * t));
    if (opacity <= 0.01) return;

    // Centroid for rotation pivot
    let cx = 0, cy = 0;
    for (const p of s.pts) { cx += p.x; cy += p.y; }
    cx /= s.pts.length; cy /= s.pts.length;

    const offX = s.vx * age;
    const offY = s.vy * age;

    ctx.save();
    ctx.translate(cx + offX, cy + offY);
    ctx.rotate(s.rotV * age);
    ctx.translate(-cx, -cy);

    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;

    // Main smoothed line
    ctx.globalAlpha = opacity;
    ctx.lineWidth   = s.width;
    ctx.beginPath();
    ctx.moveTo(s.pts[0].x, s.pts[0].y);
    for (let i = 1; i < s.pts.length; i++) {
      const prev = s.pts[i - 1];
      const cur  = s.pts[i];
      const mx = (prev.x + cur.x) / 2;
      const my = (prev.y + cur.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    }
    ctx.lineTo(s.pts[s.pts.length - 1].x, s.pts[s.pts.length - 1].y);
    ctx.stroke();

    // Satellite lag-lines for harmony.js feel
    for (let k = 1; k <= SATELLITES; k++) {
      const lag = k * 5;
      const start = Math.max(0, s.pts.length - lag - 2);
      const end   = s.pts.length - lag;
      if (end - start < 2) continue;

      ctx.globalAlpha = opacity * (0.42 - k * 0.09);
      ctx.lineWidth   = s.width * (1 - k * 0.18);
      ctx.beginPath();
      ctx.moveTo(s.pts[start].x, s.pts[start].y);
      for (let i = start + 1; i < end; i++) {
        ctx.lineTo(s.pts[i].x, s.pts[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function loop() {
    const now = performance.now();
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // Cull dead strokes
    strokes = strokes.filter(s => (now - s.born) < s.life);

    for (const s of strokes) drawStroke(s, now);
    if (inProgress) drawStroke(inProgress, now);

    requestAnimationFrame(loop);
  }

  // ── Keyboard ──
  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'd' || e.key === 'D') { e.preventDefault(); toggle(); }
    else if (isOn && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); clearAll(); }
    else if (isOn && e.key === 'Escape') { setOn(false); }
  }

  // ── Init ──
  function init() {
    buildCanvas();
    buildUI();
    addEventListener('keydown', onKey);
    requestAnimationFrame(loop);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
