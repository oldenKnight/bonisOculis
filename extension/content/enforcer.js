/*
 * bonis oculis - enforcement engine (BO.enforcer). ES5, no DOM of its own:
 * the adapter (time, seek, mute target) and the overlay (black-out) are
 * passed in, so node tests drive it with a fake clock and a fake video.
 *
 * Every 100 ms and on timeupdate/seeking/seeked/play/ratechange:
 *   - panic on            -> black-out + mute, nothing else
 *   - ad playing          -> nothing (restore), ranges belong to the film
 *   - inside a range (start - 0.05 <= t < end), strongest action wins
 *     (skip > hide = blur > mute):
 *       skip  -> black-out + mute at once (fail closed while the jump
 *                happens), seekTo(end + 0.05); if the time has not left the
 *                range within 500 ms the site refused the jump: keep the
 *                black-out + mute until the range ends
 *       hide, blur, anything visual -> black-out + mute (no visual filters)
 *       mute  -> mute only
 *   - outside every range -> restore: overlay removed, `muted` set back to
 *     what it was before we touched it. A timer fires exactly at the range
 *     end so the restore does not wait for the next tick.
 * The engine never reads video frames or audio samples.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.enforcer) { return; }

  var STRENGTH = { skip: 4, hide: 3, blur: 3, mute: 1, none: 0 };
  var EDGE = 0.05;
  var SEEK_PAST = 0.05;

  function create(opts) {
    var adapter = opts.adapter;
    var overlay = opts.overlay;
    var now = opts.now || function () { return Date.now(); };
    var setI = opts.setInterval || function (f, ms) { return setInterval(f, ms); };
    var clearI = opts.clearInterval || function (id) { clearInterval(id); };
    var setT = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    var clearT = opts.clearTimeout || function (id) { clearTimeout(id); };
    var onEvent = opts.onEvent || function () {};
    var tickMs = opts.tickMs || 100;
    var verifyMs = opts.verifyMs || 500;

    var ranges = [];
    var attached = false;
    var interval = null;
    var endTimer = null;
    var stopEvents = null;
    var panicOn = false;
    var panicStart = 0;
    var blackKind = null;
    var mutedByUs = false;
    var prevMuted = false;
    var pending = null;
    var blocked = {};
    var active = null;

    function video() { return adapter.video || null; }

    function setMuted(on) {
      var v = video();
      if (!v) { return; }
      if (on) {
        if (!mutedByUs) { prevMuted = !!v.muted; mutedByUs = true; }
        if (!v.muted) { v.muted = true; }
      } else if (mutedByUs) {
        mutedByUs = false;
        if (!!v.muted !== prevMuted) { v.muted = prevMuted; }
      }
    }

    function setBlack(kind) {
      if (kind) {
        overlay.show(kind);
      } else if (blackKind) {
        overlay.hide();
      }
      blackKind = kind || null;
    }

    function restore() {
      setBlack(null);
      setMuted(false);
      active = null;
    }

    function keyOf(r) { return String(r.id) + '@' + r.start + '-' + r.end; }

    function activeAt(t) {
      var best = null, i, r, s, bs;
      for (i = 0; i < ranges.length; i++) {
        r = ranges[i];
        if (r.start > t + EDGE) { break; }
        if (t >= r.start - EDGE && t < r.end) {
          s = STRENGTH[r.action] === undefined ? 3 : STRENGTH[r.action];
          if (s <= 0) { continue; }
          bs = best ? (STRENGTH[best.action] === undefined ? 3 : STRENGTH[best.action]) : -1;
          if (s > bs || (s === bs && r.end > best.end)) { best = r; }
        }
      }
      return best;
    }

    function scheduleEnd(r, t) {
      var v = video(), rate = v && v.playbackRate > 0 ? v.playbackRate : 1, ms;
      if (endTimer !== null) { clearT(endTimer); endTimer = null; }
      if (!r || (v && v.paused)) { return; }
      ms = Math.max(0, (r.end - t) / rate * 1000) + 5;
      if (ms > 60000) { return; }
      endTimer = setT(function () { endTimer = null; tick(); }, ms);
    }

    function tick() {
      var t, r, k;
      if (!attached) { return; }
      t = adapter.currentTime();
      if (panicOn) {
        setBlack('panic');
        setMuted(true);
        return;
      }
      if (adapter.isAdPlaying && adapter.isAdPlaying()) {
        pending = null;
        restore();
        return;
      }
      r = activeAt(t);
      if (!r) {
        if (pending && t < pending.end - EDGE) {
          /* the site sent the time back instead of jumping: never try this range again */
          blocked[pending.key] = true;
          onEvent('blocked', { id: pending.id, at: t });
        } else if (pending) {
          onEvent('skipped', { id: pending.id, to: t });
        }
        pending = null;
        restore();
        scheduleEnd(null, t);
        return;
      }
      active = r;
      if (r.action === 'mute') {
        setBlack(null);
        setMuted(true);
        pending = null;
      } else if (r.action === 'skip') {
        setBlack('scene');
        setMuted(true);
        k = keyOf(r);
        if (!blocked[k]) {
          if (!pending || pending.key !== k) {
            pending = { key: k, id: r.id, end: r.end, at: now(), from: t };
            adapter.seekTo(r.end + SEEK_PAST);
          } else if (now() - pending.at >= verifyMs) {
            blocked[k] = true;
            pending = null;
            onEvent('blocked', { id: r.id, at: t });
          }
        }
      } else {
        setBlack('scene');
        setMuted(true);
        pending = null;
      }
      scheduleEnd(r, t);
    }

    function setRanges(list) {
      var out = [], i, r;
      for (i = 0; list && i < list.length; i++) {
        r = list[i];
        if (r && typeof r.start === 'number' && typeof r.end === 'number' && r.end > r.start && r.action && r.action !== 'none') {
          out.push(r);
        }
      }
      out.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
      ranges = out;
      tick();
    }

    function attach() {
      detach();
      attached = true;
      stopEvents = adapter.onTimeUpdate(tick);
      interval = setI(tick, tickMs);
      tick();
    }

    function detach() {
      if (!attached) { return; }
      if (stopEvents) { stopEvents(); stopEvents = null; }
      if (interval !== null) { clearI(interval); interval = null; }
      if (endTimer !== null) { clearT(endTimer); endTimer = null; }
      pending = null;
      restore();
      attached = false;
    }

    /* -> {on: true} or {on: false, range: {start, end}} */
    function togglePanic() {
      var t = adapter.currentTime(), res;
      if (!panicOn) {
        panicOn = true;
        panicStart = t;
        setBlack('panic');
        setMuted(true);
        onEvent('panic', { on: true, at: t });
        return { on: true };
      }
      panicOn = false;
      res = { on: false, range: { start: Math.max(0, Math.round((panicStart - 2) * 1000) / 1000), end: Math.round(Math.max(t, panicStart + 1) * 1000) / 1000 } };
      setBlack(null);
      setMuted(false);
      onEvent('panic', { on: false, at: t });
      tick();
      return res;
    }

    function state() {
      var n = 0, k;
      for (k in blocked) { if (Object.prototype.hasOwnProperty.call(blocked, k)) { n++; } }
      return {
        attached: attached,
        panic: panicOn,
        active: active ? { id: active.id, action: active.action, category: active.category } : null,
        covered: !!blackKind,
        mutedByUs: mutedByUs,
        blocked: n,
        ranges: ranges.length
      };
    }

    return { setRanges: setRanges, attach: attach, detach: detach, tick: tick, togglePanic: togglePanic, state: state, isPanic: function () { return panicOn; } };
  }

  BO.enforcer = { create: create, STRENGTH: STRENGTH };
}(typeof self !== 'undefined' ? self : this));
