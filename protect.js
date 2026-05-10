/* ─────────────────────────────────────────────────────────────────
   protect.js — image friction layer
   Scope statement (honesty matters here):
     This script makes casual image theft annoying. It does not stop
     screenshots, dev-tools image extraction, or anyone determined.
     Real protection is the X-Robots-Tag noai/noimageai header on
     image responses, the robots.txt training-bot bans, the EXIF
     copyright stamps on every artwork file, and the terms.html
     reservation of rights. This is the front-of-house friction layer.
   ───────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // Mark the document so protect.css can adapt (print suppression, etc.)
  document.documentElement.classList.add("protected");

  // Block right-click / context menu on <img> elements specifically.
  // We don't block contextmenu site-wide because it would break copy/
  // paste of text. Image right-click is the meaningful save vector.
  function isProtectedTarget(t) {
    if (!t) return false;
    if (t.tagName === "IMG") return true;
    // .protect-wrap overlay or any element with [data-protect]
    if (t.closest && (t.closest(".protect-wrap") || t.closest("[data-protect]"))) {
      return true;
    }
    return false;
  }

  document.addEventListener(
    "contextmenu",
    function (e) {
      if (isProtectedTarget(e.target)) {
        e.preventDefault();
      }
    },
    { capture: true }
  );

  // Block native drag-to-desktop on every image, current and future.
  function blockDrag(e) {
    if (e.target && e.target.tagName === "IMG") e.preventDefault();
  }
  document.addEventListener("dragstart", blockDrag, { capture: true });

  // Block "Save Page As" hotkey when an image has focus / is hovered.
  // Cmd/Ctrl+S, Cmd/Ctrl+Shift+S
  document.addEventListener(
    "keydown",
    function (e) {
      var hoveringImg = document.querySelector("img:hover");
      if (!hoveringImg) return;
      var key = (e.key || "").toLowerCase();
      if ((e.metaKey || e.ctrlKey) && (key === "s")) {
        e.preventDefault();
      }
    },
    { capture: true }
  );

  // Set decoding hint and disable the implicit drag affordance via the
  // HTML attribute as well (CSS handles the modern path; this is belt
  // and suspenders for older WebKit).
  function harden(img) {
    if (!img || img.dataset.protectedHooked === "1") return;
    img.setAttribute("draggable", "false");
    if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
    if (!img.hasAttribute("decoding")) img.setAttribute("decoding", "async");
    img.dataset.protectedHooked = "1";
  }

  function hardenAll(root) {
    var imgs = (root || document).querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) harden(imgs[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { hardenAll(); });
  } else {
    hardenAll();
  }

  // Watch for images added later (modal opens, lazy renders, etc.).
  if (typeof MutationObserver !== "undefined") {
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        for (var j = 0; j < r.addedNodes.length; j++) {
          var n = r.addedNodes[j];
          if (n.nodeType !== 1) continue;
          if (n.tagName === "IMG") harden(n);
          else if (n.querySelectorAll) hardenAll(n);
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
