/* ─────────────────────────────────────────────────────
   BOOK MODAL — shared spread gallery
   Extracted from lab2.html. Multiple pages (lab2, library2)
   share one implementation. Auto-inserts modal markup on
   first call. Looks up spreads by book title from an
   internal SPREADS catalogue.

   Public API:
     window.RaghavaBookModal.open({ title, thumb, pdf, filename })
     window.RaghavaBookModal.close()
     window.RaghavaBookModal.SPREADS   (read-only catalogue)

   Each book row passed to open() needs at minimum:
     - title    (string, matches a SPREADS key for spread mode)
     - thumb    (cover image URL, used in fallback)
     - pdf      (URL of the full PDF, offered as Open PDF / Download inside the reader)
     - filename (optional download filename)
   ───────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── Catalogue: title → { folder under /images/spreads/, page count, zero-padding width }
  const SPREADS = {
    'Calling All Gods':                          { folder: 'Calling_All_Gods',    count: 49,  pad: 2 },
    'The Yali Project':                          { folder: 'Yali_Project',        count: 4,   pad: 2 },
    'About Raghava KK':                          { folder: 'About_Raghava_KK',    count: 58,  pad: 2 },
    'Art Archive Book':                          { folder: 'Art_Archive_Book',    count: 208, pad: 3 },
    '64/1':                                      { folder: '64_1',                count: 64,  pad: 2 },
    'too fast':                                  { folder: 'too_fast',            count: 25,  pad: 2 },
    'PASSPORT':                                  { folder: 'PASSPORT',            count: 27,  pad: 2 },
    '33M Gods':                                  { folder: '33M_Gods',            count: 26,  pad: 2 },
    'Chris book':                                { folder: 'Chris_book',          count: 7,   pad: 1 },
    'MAYBE you KNOW ME':                         { folder: 'MAYBE_you_KNOW_ME',   count: 24,  pad: 2 },
    'On Being me!':                              { folder: 'On_Being_me',         count: 30,  pad: 2 },
    'MASCULYNE':                                 { folder: 'MASCULYNE',           count: 20,  pad: 2 },
    'Restless Frequency':                        { folder: 'Restless_Frequency',  count: 110, pad: 3 },
    'Superstar Rajinikanth Made Me':             { folder: 'Superstar_Rajinikanth', count: 30, pad: 2 },
    'ATTITUDES':                                 { folder: 'ATTITUDES',           count: 56,  pad: 2 },
    'Elite Sample':                              { folder: 'Elite_Sample',        count: 12,  pad: 2 },
    "The Machine Didn't Kill Me, It Rewrote Me": { folder: 'Machine_Rewrote_Me',  count: 92,  pad: 2 },
    'Artist Not Found':                          { folder: 'Artist_Not_Found',    count: 184, pad: 3 },
    'The Raghava KK Studio Projects Book':       { folder: 'Studio_Projects_Book', count: 160, pad: 3 },
    'the duck forgot it was whole':              { folder: 'duck_forgot',         count: 196, pad: 3 },
    // Show brochures + catalogues (library shelves five and six, 2026-08-30). The three studio
    // catalogues were exported as landscape spreads with a wraparound cover: each sheet is split
    // into halves, the front cover leads, the back cover closes (count = halves).
    'Figuring the Edge':                         { folder: 'Figuring_the_Edge',   count: 22,  pad: 2 },
    'La petite mort':                            { folder: 'La_petite_mort',      count: 71,  pad: 2 },
    "Catch 'em if you can!":                     { folder: 'Catch_em_if_you_can', count: 22,  pad: 2 },
    'Advaitha Ganesha':                          { folder: 'Advaitha_Ganesha',    count: 11,  pad: 2 },
    'Ceramics':                                  { folder: 'Ceramics',            count: 17,  pad: 2 },
    'Impossible Bouquet':                        { folder: 'Impossible_Bouquet',  count: 18,  pad: 2 },
    'Reimagining History':                       { folder: 'Reimagining_History', count: 22,  pad: 2 },
    // Miscellany (shelf seven)
    'Lookbook':                                  { folder: 'Lookbook',            count: 38,  pad: 2 },
    'Delicate Grace':                            { folder: 'Delicate_Grace',      count: 56,  pad: 2 },
    'Leela':                                     { folder: 'Leela',               count: 28,  pad: 2 },
    // Process dossier documents (process-edges.html, process-trojan.html) — same reader, same rules.
    'The Edges catalog':                         { folder: 'Edges_Catalog',       count: 20,  pad: 2 },
    'My journey from painting to sculpture':     { folder: 'Journey_Painting_to_Sculpture', count: 20, pad: 2 },
    'My relationship with art':                  { folder: 'Relationship_with_Art', count: 1, pad: 2 },
    'Painting with oils':                        { folder: 'Painting_with_Oils',  count: 4,   pad: 2 },
    'Painting as body':                          { folder: 'Painting_as_Body',    count: 6,   pad: 2 },
    'Display of the Edges':                      { folder: 'Display_of_the_Edges', count: 4,  pad: 2 },
    'My truths':                                 { folder: 'My_Truths',           count: 3,   pad: 2 },
    'The ultimate other':                        { folder: 'The_Ultimate_Other',  count: 24,  pad: 2 },
    // Toy Trojan essay: the PDF is exported as landscape spreads; each spread is split
    // into left/right halves here so 2-up mode reassembles it (cover alone, then 2-3, 4-5…).
    'A Visual Essay of the Creation of the Toy Trojan': { folder: 'Toy_Trojan_Essay', count: 35, pad: 2 }
  };

  let mounted = false;
  let els = null;
  let currentBook = null;
  let currentPage = 0;
  // Default: 2-up. Last-mode is remembered in localStorage so a user who
  // explicitly switches to single will keep that preference across opens.
  const STORAGE_KEY = 'rkk.book.spreadMode';
  function readStoredMode() {
    try {
      const v = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
      return v === 'single' || v === 'double' ? v : 'double';
    } catch (_) { return 'double'; }
  }
  function writeStoredMode(v) {
    try { if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, v); } catch (_) {}
  }
  let spreadMode = readStoredMode();
  let bookLastFocus = null;

  // ── Inject modal markup once, attach all event listeners.
  function mount() {
    if (mounted) return;
    if (document.getElementById('bookModal')) {
      // Page already has the markup (e.g. legacy embed); just bind it.
      bind();
      mounted = true;
      return;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = [
      '<div class="modal" id="bookModal" role="dialog" aria-modal="true" aria-labelledby="bookTitle" aria-hidden="true">',
      '  <div class="modal-frame">',
      '    <div class="modal-bar">',
      '      <span class="modal-title" id="bookTitle">Book</span>',
      '      <span class="modal-meta" id="bookMeta">—</span>',
      '      <div class="modal-actions">',
      '        <button type="button" id="bookSpreadMode" class="modal-action ghost" aria-label="Toggle single page view">Single ⊞</button>',
      '        <button type="button" id="bookFullscreen" class="modal-action ghost" aria-label="Toggle full screen">Full ⤢</button>',
      '        <a href="#" id="bookOpenPdf" class="modal-action ghost" target="_blank" rel="noopener">Open PDF ↗</a>',
      '        <a href="#" id="bookDownload" class="modal-action ghost" download>Download</a>',
      '        <button type="button" id="bookClose" class="modal-action" aria-label="Close">Close ×</button>',
      '      </div>',
      '    </div>',
      '    <div class="spread-stage" id="spreadStage" data-mode="double">',
      '      <button type="button" class="spread-nav prev" id="spreadPrev" aria-label="Previous spread">‹</button>',
      '      <img class="spread-img" id="spreadImg" alt="" />',
      '      <img class="spread-img spread-img-2" id="spreadImg2" alt="" />',
      '      <button type="button" class="spread-nav next" id="spreadNext" aria-label="Next spread">›</button>',
      '      <span class="spread-counter" id="spreadCounter">— / —</span>',
      '      <div class="cover-fallback" id="coverFallback" hidden>',
      '        <div class="cover-fallback-inner">',
      '          <img id="coverFallbackImg" alt="" />',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div class="spread-thumbs" id="spreadThumbs"></div>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(wrap.firstElementChild);
    bind();
    mounted = true;
  }

  function bind() {
    els = {
      modal:           document.getElementById('bookModal'),
      title:           document.getElementById('bookTitle'),
      meta:            document.getElementById('bookMeta'),
      openPdf:         document.getElementById('bookOpenPdf'),
      download:        document.getElementById('bookDownload'),
      close:           document.getElementById('bookClose'),
      stage:           document.getElementById('spreadStage'),
      img:             document.getElementById('spreadImg'),
      img2:            document.getElementById('spreadImg2'),
      prev:            document.getElementById('spreadPrev'),
      next:            document.getElementById('spreadNext'),
      counter:         document.getElementById('spreadCounter'),
      thumbs:          document.getElementById('spreadThumbs'),
      coverFallback:   document.getElementById('coverFallback'),
      coverFallbackImg:document.getElementById('coverFallbackImg'),
      spreadModeBtn:   document.getElementById('bookSpreadMode'),
      fullscreenBtn:   document.getElementById('bookFullscreen')
    };

    els.prev.addEventListener('click', () => goToPage(prevOf(currentPage)));
    els.next.addEventListener('click', () => goToPage(nextOf(currentPage)));
    els.spreadModeBtn.addEventListener('click', () => setSpreadMode(spreadMode === 'double' ? 'single' : 'double'));
    els.close.addEventListener('click', close);
    els.modal.addEventListener('click', (e) => { if (e.target === els.modal) close(); });
    if (els.fullscreenBtn) els.fullscreenBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      if (els.fullscreenBtn) els.fullscreenBtn.textContent = document.fullscreenElement ? 'Exit ⤡' : 'Full ⤢';
    });

    // touch swipe
    let tx = null, ty = null;
    els.stage.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; tx = t.clientX; ty = t.clientY;
    }, { passive: true });
    els.stage.addEventListener('touchend', (e) => {
      if (tx === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tx, dy = t.clientY - ty;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) goToPage(nextOf(currentPage)); else goToPage(prevOf(currentPage));
      }
      tx = ty = null;
    });

    // keyboard while modal is open
    document.addEventListener('keydown', (e) => {
      if (!els.modal || els.modal.getAttribute('aria-hidden') !== 'false') return;
      if      (e.key === 'Escape')     close();
      else if (e.key === 'ArrowRight') goToPage(nextOf(currentPage));
      else if (e.key === 'ArrowLeft')  goToPage(prevOf(currentPage));
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === '2')                  { e.preventDefault(); setSpreadMode(spreadMode === 'double' ? 'single' : 'double'); }
    });
  }

  function spreadUrl(book, n) {
    const num = String(n).padStart(book.spreads.pad, '0');
    return './images/spreads/' + book.spreads.folder + '/p-' + num + '.jpg';
  }

  function open(book) {
    if (!book || !book.title) return;
    mount();
    bookLastFocus = document.activeElement;
    currentBook = Object.assign({}, book, { spreads: SPREADS[book.title] || null });
    currentPage = 1;

    els.title.textContent = book.title.toUpperCase();
    if (book.pdf) {
      els.openPdf.href = book.pdf;
      els.openPdf.textContent = 'Open PDF ↗';
      els.openPdf.removeAttribute('target');
      els.openPdf.setAttribute('target', '_blank');
      els.openPdf.style.display = '';
      els.download.href = book.pdf;
      els.download.style.display = '';
      if (book.filename) els.download.setAttribute('download', book.filename);
    } else if (book.requestOnly) {
      // No PDF on the site — invite a request by email.
      const subject = encodeURIComponent('Request: ' + book.title + ' (full edition)');
      const body = encodeURIComponent("Hi Raghava,\n\nI'd love to see the full edition of " + book.title + ".\n\nThanks.");
      els.openPdf.href = 'mailto:studio@raghavakkstudio.com?subject=' + subject + '&body=' + body;
      els.openPdf.textContent = 'Request edition ✉';
      els.openPdf.removeAttribute('target');
      els.openPdf.style.display = '';
      els.download.style.display = 'none';
    } else {
      els.openPdf.style.display = 'none';
      els.download.style.display = 'none';
    }

    if (currentBook.spreads) {
      // Spread mode
      els.img.style.display = '';
      els.prev.style.display = '';
      els.next.style.display = '';
      els.counter.style.display = '';
      els.thumbs.style.display = '';
      els.coverFallback.hidden = true;
      els.meta.textContent = '1 / ' + currentBook.spreads.count;
      renderThumbs();
      // Apply the stored / default spread mode (2-up by default) and render.
      setSpreadMode(spreadMode);
    } else {
      // Cover-only fallback — silent (no apologia)
      els.img.style.display = 'none';
      els.prev.style.display = 'none';
      els.next.style.display = 'none';
      els.counter.style.display = 'none';
      els.coverFallback.hidden = false;
      els.coverFallbackImg.src = book.thumb || '';
      els.coverFallbackImg.alt = book.title;
      els.meta.textContent = 'cover only';
      els.thumbs.innerHTML = '';
      els.thumbs.style.display = 'none';
    }

    els.modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setTimeout(() => els.close.focus(), 60);
  }

  function close() {
    if (!els || !els.modal) return;
    els.modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    els.img.removeAttribute('src');
    els.img.classList.remove('loaded');
    if (bookLastFocus && typeof bookLastFocus.focus === 'function') bookLastFocus.focus();
  }

  function renderThumbs() {
    if (!currentBook || !currentBook.spreads) return;
    const total = currentBook.spreads.count;
    const html = ['<span class="label">' + total + ' pages</span>'];
    for (let i = 1; i <= total; i++) {
      html.push('<button type="button" class="spread-thumb' + (i === currentPage ? ' active' : '') + '" data-page="' + i + '" aria-label="Page ' + i + '"><img src="' + spreadUrl(currentBook, i) + '" alt="" loading="lazy" decoding="async" /></button>');
    }
    els.thumbs.innerHTML = html.join('');
    els.thumbs.querySelectorAll('.spread-thumb').forEach(b => {
      b.addEventListener('click', () => goToPage(parseInt(b.dataset.page, 10)));
    });
  }

  function loadIntoImg(targetImg, n) {
    if (!currentBook || !currentBook.spreads) return;
    targetImg.classList.remove('loaded', 'errored', 'alone');
    const url = spreadUrl(currentBook, n);
    const onLoad = () => { targetImg.classList.add('loaded'); cleanup(); };
    const onError = () => {
      console.warn('[book-modal] spread failed to load:', url);
      targetImg.classList.add('errored');
      cleanup();
    };
    function cleanup() {
      targetImg.removeEventListener('load', onLoad);
      targetImg.removeEventListener('error', onError);
    }
    targetImg.addEventListener('load', onLoad);
    targetImg.addEventListener('error', onError);
    targetImg.src = url;
    targetImg.dataset.page = String(n);
    // Cached-image race guard
    if (targetImg.complete && targetImg.naturalWidth > 0) {
      targetImg.classList.add('loaded');
      cleanup();
    }
  }

  function goToPage(n) {
    if (!currentBook || !currentBook.spreads) return;
    const total = currentBook.spreads.count;
    if (n < 1 || n > total) return;
    // In 2-up mode, anchor to the physical spread: the cover sits alone,
    // then pages 2-3, 4-5... (the same imposition as the printed book and
    // the site PDFs). So the left page of every spread after the cover is even.
    if (spreadMode === 'double') n = anchorOf(n);
    currentPage = n;

    if (spreadMode === 'double') {
      loadIntoImg(els.img, n);
      const hasRight = n > 1 && n + 1 <= total;
      if (hasRight) {
        loadIntoImg(els.img2, n + 1);
        els.img2.classList.remove('alone');
      } else {
        els.img2.removeAttribute('src');
        els.img2.classList.add('alone');
      }
      const label = hasRight ? (n + '-' + (n + 1) + ' / ' + total) : (n + ' / ' + total);
      els.counter.textContent = label;
      els.meta.textContent = label;
    } else {
      loadIntoImg(els.img, n);
      els.counter.textContent = n + ' / ' + total;
      els.meta.textContent = n + ' / ' + total;
    }

    // Preload neighbors
    const lookahead = spreadMode === 'double' ? 2 : 1;
    for (let i = 1; i <= lookahead + 1; i++) {
      if (n + i <= total) { const im = new Image(); im.src = spreadUrl(currentBook, n + i); }
      if (n - i >= 1)     { const im = new Image(); im.src = spreadUrl(currentBook, n - i); }
    }

    els.prev.disabled = n <= 1;
    els.next.disabled = (spreadMode === 'double') ? (n + 1 >= total) : (n >= total);

    // active thumb
    els.thumbs.querySelectorAll('.spread-thumb').forEach(b => {
      const p = parseInt(b.dataset.page, 10);
      b.classList.toggle('active', p === n || (spreadMode === 'double' && n > 1 && p === n + 1));
    });
    const active = els.thumbs.querySelector('.spread-thumb.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }

  // Spread anchors. Single mode: every page is its own anchor.
  // Double mode: 1 (cover alone), then 2, 4, 6... (left page of each spread).
  function anchorOf(n) { return (n > 1 && n % 2 === 1) ? n - 1 : n; }
  function nextOf(n) {
    if (spreadMode !== 'double') return n + 1;
    return n === 1 ? 2 : anchorOf(n) + 2;
  }
  function prevOf(n) {
    if (spreadMode !== 'double') return n - 1;
    return n <= 2 ? 1 : anchorOf(n) - 2;
  }

  function setSpreadMode(mode) {
    spreadMode = mode === 'double' ? 'double' : 'single';
    els.stage.dataset.mode = spreadMode;
    els.spreadModeBtn.textContent = spreadMode === 'double' ? 'Single ⊞' : '2-up ⊟';
    els.spreadModeBtn.setAttribute('aria-label', spreadMode === 'double' ? 'Switch to single page view' : 'Switch to 2-up spread view');
    writeStoredMode(spreadMode);
    // Snap currentPage to a left-page anchor when going double (cover alone, then even left pages)
    if (spreadMode === 'double') currentPage = anchorOf(currentPage);
    if (currentBook && currentBook.spreads) goToPage(currentPage);
  }

  function toggleFullscreen() {
    if (!els || !els.modal) return;
    const target = els.modal.querySelector('.modal-frame');
    if (!document.fullscreenElement) {
      const req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
      if (req) req.call(target).catch(() => {});
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) exit.call(document).catch(() => {});
    }
  }

  // ── Public API
  window.RaghavaBookModal = {
    open: open,
    close: close,
    SPREADS: SPREADS
  };
})();
