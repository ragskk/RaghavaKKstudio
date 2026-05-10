/* Random brush stroke placement with desynced organic motion */

(function () {
  var BRUSHES = [
    './images/brushes/01.png',
    './images/brushes/02.png',
    './images/brushes/03.png',
    './images/brushes/04.png',
    './images/brushes/05.png',
    './images/brushes/06.png',
    './images/brushes/07.png',
    './images/brushes/08.png',
    './images/brushes/09.png'
  ];

  // On-screen anchor regions, in vw / vh ranges.
  // Strokes interrupt visibly but stay near edges of the centered text column.
  var SLOTS = [
    { x: [  4, 22], y: [  6, 22] },    // top-left
    { x: [ 60, 80], y: [  8, 24] },    // top-right
    { x: [  4, 18], y: [ 38, 58] },    // mid-left
    { x: [ 64, 84], y: [ 36, 56] },    // mid-right
    { x: [ 12, 36], y: [ 64, 84] },    // bottom-left
    { x: [ 56, 78], y: [ 62, 82] },    // bottom-right
    { x: [ 32, 56], y: [ 28, 50] }     // center bold (occasional)
  ];

  function rand(min, max) { return Math.random() * (max - min) + min; }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function placeBrushes() {
    var layer = document.createElement('div');
    layer.className = 'brush-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);

    var brushes = shuffle(BRUSHES);
    var slots = shuffle(SLOTS);
    // 2 or 3 strokes — rare 1, very rare 4. Keeps the page alive but uncrowded.
    var counts = [2, 2, 2, 3, 3, 1];
    var n = Math.min(counts[Math.floor(Math.random() * counts.length)], slots.length, brushes.length);

    for (var i = 0; i < n; i++) {
      var slot = slots[i];
      var img = document.createElement('img');
      img.src = brushes[i];
      img.alt = '';
      img.className = 'brush-stroke alive';
      img.loading = 'lazy';
      img.decoding = 'async';

      // Size — smaller than before so they punctuate, not dominate.
      var w = rand(180, 340);
      img.style.left = rand(slot.x[0], slot.x[1]) + 'vw';
      img.style.top = rand(slot.y[0], slot.y[1]) + 'vh';
      img.style.width = w + 'px';
      img.style.height = 'auto';

      // Static base values picked up by keyframes via calc().
      img.style.setProperty('--rot', rand(-40, 40).toFixed(2) + 'deg');
      img.style.setProperty('--scl', rand(0.9, 1.1).toFixed(3));

      // Drift offset (animated).
      img.style.setProperty('--dx', rand(-16, 20).toFixed(1) + 'px');
      img.style.setProperty('--dy', rand(-14, 16).toFixed(1) + 'px');

      // Peak opacity for the bloom cycle. Lower than before so reading wins.
      img.style.setProperty('--opacity', rand(0.30, 0.55).toFixed(3));

      // Four desynced periods — drift/breathe/sway run independently of bloom.
      img.style.setProperty('--dur-bloom',   rand(38, 64).toFixed(1) + 's');
      img.style.setProperty('--dur-drift',   rand(24, 38).toFixed(1) + 's');
      img.style.setProperty('--dur-breathe', rand( 8, 14).toFixed(1) + 's');
      img.style.setProperty('--dur-sway',    rand(14, 24).toFixed(1) + 's');

      // Negative delays = mid-cycle starts, so strokes don't all bloom together.
      img.style.setProperty('--d-bloom',   (-rand(0, 50)).toFixed(1) + 's');
      img.style.setProperty('--d-drift',   (-rand(0, 30)).toFixed(1) + 's');
      img.style.setProperty('--d-breathe', (-rand(0, 12)).toFixed(1) + 's');
      img.style.setProperty('--d-sway',    (-rand(0, 20)).toFixed(1) + 's');

      layer.appendChild(img);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', placeBrushes);
  } else {
    placeBrushes();
  }
})();
