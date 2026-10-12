/*
 * Test page helpers (page world). window.__test is driven by extension/test/run.js.
 * blockSeeks(true) imitates a player that refuses outside seeks: any seek the
 * page did not start itself is sent back to the last time the page saw. (A
 * read-only currentTime defined here would not reach the extension's isolated
 * world, which has its own view of the element, so the page reverts instead.)
 */
(function () {
  'use strict';
  var v = document.getElementById('v');
  var block = false, last = 0, pageSeek = false, reverting = false, reverted = 0;
  var log = [];
  v.addEventListener('timeupdate', function () {
    if (!v.seeking) { last = v.currentTime; }
    log.push(Math.round(v.currentTime * 1000) / 1000);
    if (log.length > 5000) { log.shift(); }
  });
  v.addEventListener('seeking', function () {
    if (pageSeek) { pageSeek = false; return; }
    if (block && !reverting) {
      reverting = true;
      reverted++;
      v.currentTime = last;
      setTimeout(function () { reverting = false; }, 0);
    }
  });
  window.__test = {
    seek: function (t) { pageSeek = true; last = t; v.currentTime = t; },
    blockSeeks: function (on) { block = !!on; reverted = 0; },
    reverted: function () { return reverted; },
    log: function () { return log.slice(); },
    clearLog: function () { log = []; }
  };
}());
