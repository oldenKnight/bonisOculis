/* Auto-relock (planner decision 10): parent mode locks again after Settings > PIN > "Lock again
   after" minutes without input (5 / 10 / 30 / never; default 10), with a 30-second warning toast.
   Time spent with a movie open does not count. ES5. */
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
    var boot = BO.store.get('boot') || {};
    var s = BO.store.get('settings') || {};
    return minutes() > 0 && !BO.store.get('locked') && boot.hasPin !== false && s.setupDone && BO.router.current() !== 'player' && BO.router.current() !== 'setup';
  }

  function touch() {
    last = Date.now();
    if (warning) { warning.dismiss(); warning = null; }
  }

  function tick() {
    if (!active()) { last = Date.now(); return; }
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

  function start() {
    ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) { window.addEventListener(ev, touch, true); });
    var lastMove = 0;
    window.addEventListener('mousemove', function () { if (Date.now() - lastMove > 1000) { lastMove = Date.now(); touch(); } }, true);
    BO.store.subscribe('locked', function () { touch(); });
    clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  BO.idle = { start: start, touch: touch, tick: tick, _setLast: function (t) { last = t; } };
}(window));
