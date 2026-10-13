/* Auto-relock (planner decision 10): parent mode locks again after Settings > PIN > "Lock again
   after" minutes without input (5 / 10 / 30 / never; default 10), with a 30-second warning toast.
   A parent-mode movie does not lock the app while it plays, and nothing done on Now playing counts
   as a parent being there (round 3, N-R1): the time keeps running. When the movie reaches its end
   (the player stays open on the last frame), is stopped with the app's Stop, or its window is
   closed, and the time is already up, the app locks at once, before the library shows. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var WARN_MS = 30000;
  var last = Date.now();
  var warning = null;
  var timer = null;

  function minutes() {
    var s = BO.store.get('settings') || {};
    return typeof s.autoLockMinutes === 'number' ? s.autoLockMinutes : 10;
  }

  function active() {
    var s = BO.store.get('settings') || {};
    // setupDone means a PIN exists (the wizard sets it before finishing).
    return minutes() > 0 && !BO.store.get('locked') && s.setupDone && BO.router.current() !== 'setup';
  }

  function playing() { return BO.router.current() === 'player' && BO.views.player && BO.views.player.playing(); }

  function touch() {
    if (playing()) { return; } // input while a movie plays is not presence
    last = Date.now();
    if (warning) { warning.dismiss(); warning = null; }
  }

  function tick() {
    if (!active()) { last = Date.now(); return; }
    if (playing()) { if (warning) { warning.dismiss(); warning = null; } return; } // counts, but never locks mid-movie
    var left = minutes() * 60000 - (Date.now() - last);
    if (left <= 0) {
      if (warning) { warning.dismiss(); warning = null; }
      last = Date.now();
      BO.invoke('pin:lock', { reason: 'idle' }, function () {});
      return;
    }
    if (left <= WARN_MS && !warning) {
      warning = BO.toast.show({ kind: 'warning', title: BO.t('idle.title'), text: BO.t('idle.text'), timeout: WARN_MS,
        actions: [{ label: BO.t('idle.stay'), onClick: function () { warning = null; touch(); } }] });
    }
  }

  // True when the time is up (Stop asks this before stopping the movie).
  function expired() { return active() && minutes() * 60000 - (Date.now() - last) <= 0; }

  function start() {
    ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) { window.addEventListener(ev, touch, true); });
    var lastMove = 0;
    window.addEventListener('mousemove', function () { if (Date.now() - lastMove > 1000) { lastMove = Date.now(); touch(); } }, true);
    BO.store.subscribe('locked', function () { last = Date.now(); if (warning) { warning.dismiss(); warning = null; } });
    clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  BO.idle = { start: start, touch: touch, tick: tick, expired: expired, _setLast: function (t) { last = t; } };
}(window));
