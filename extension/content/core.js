/*
 * bonis oculis content script - shared helpers (BO.util). ES5.
 * Runs in the extension's isolated world on video sites.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.util) { return; }

  /* FNV-1a 32-bit, hex. Used for generic-site video ids (no content involved). */
  function hash(s) {
    var h = 0x811c9dc5, i;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments, self = this;
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(function () { timer = null; fn.apply(self, args); }, ms);
    };
  }

  function randomHex(bytes) {
    var a = new Uint8Array(bytes), s = '', i;
    crypto.getRandomValues(a);
    for (i = 0; i < a.length; i++) { s += ('0' + a[i].toString(16)).slice(-2); }
    return s;
  }

  /* chrome.runtime.sendMessage that never throws (extension reloaded, worker asleep). */
  function toBackground(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        var err = chrome.runtime.lastError;
        if (typeof cb === 'function') { cb(err ? null : res); }
      });
    } catch (e) {
      if (typeof cb === 'function') { cb(null); }
    }
  }

  /* Largest visible <video>, searching open shadow roots too (Disney+). */
  function findVideos(rootNode, out, depth) {
    var list, i, all;
    out = out || [];
    depth = depth || 0;
    if (!rootNode || depth > 4) { return out; }
    list = rootNode.querySelectorAll('video');
    for (i = 0; i < list.length; i++) { out.push(list[i]); }
    if (depth < 4) {
      all = rootNode.querySelectorAll('*');
      for (i = 0; i < all.length && i < 5000; i++) {
        if (all[i].shadowRoot) { findVideos(all[i].shadowRoot, out, depth + 1); }
      }
    }
    return out;
  }

  function biggestVideo(selector) {
    var list = selector ? document.querySelectorAll(selector) : findVideos(document), best = null, bestArea = 0, i, r, a;
    for (i = 0; i < list.length; i++) {
      r = list[i].getBoundingClientRect();
      a = Math.max(0, r.width) * Math.max(0, r.height);
      if (list[i].readyState > 0 || list[i].currentSrc) { a += 1; }
      if (a > bestArea) { best = list[i]; bestArea = a; }
    }
    return best;
  }

  BO.util = {
    hash: hash,
    debounce: debounce,
    randomHex: randomHex,
    toBackground: toBackground,
    findVideos: findVideos,
    biggestVideo: biggestVideo
  };
}(typeof self !== 'undefined' ? self : this));
