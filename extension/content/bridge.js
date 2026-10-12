/*
 * bonis oculis content script - receives subtitle text captured by the
 * page-world hook (inject/hook.js) and keeps it per track (BO.bridge). ES5.
 *
 * Track: {key, url, lang, format, cues: [{start, end, text}], segments}
 * Segmented WebVTT (HLS, e.g. Disney+) arrives as many small files; files
 * whose URLs differ only in digits of the last path part are one track and
 * their cues are merged.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.bridge) { return; }

  var nonce = null;
  var tracks = {};
  var order = [];
  var listeners = [];
  var started = false;
  var MAX_TRACKS = 40;

  function langFromUrl(url) {
    var m = /[?&](?:tlang|lang|language|lng)=([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?)/.exec(url) || /[\/_.-](es|en|spa|eng|es-419|es-MX|en-US)[\/_.-]/i.exec(url);
    return m ? m[1] : '';
  }

  function trackKey(url) {
    var u = String(url || '').split('#')[0], q = '', i = u.indexOf('?'), base, tl;
    if (i >= 0) { q = u.slice(i + 1); u = u.slice(0, i); }
    base = u.replace(/[0-9]+(?=[^\/]*$)/g, '#');
    /* YouTube timedtext: one track per language, whatever the other parameters */
    if (/timedtext/.test(u)) {
      tl = /(?:^|&)(?:tlang|lang)=([^&]+)/.exec(q);
      return base + '|' + (tl ? tl[1] : '') + '|' + (/(?:^|&)kind=asr/.test(q) ? 'asr' : '');
    }
    return base;
  }

  function sameCue(a, b) { return Math.abs(a.start - b.start) < 0.01 && Math.abs(a.end - b.end) < 0.01 && a.text === b.text; }

  function addCues(track, cues) {
    var added = 0, i, j, dup;
    for (i = 0; i < cues.length; i++) {
      dup = false;
      for (j = track.cues.length - 1; j >= 0 && j >= track.cues.length - 400; j--) {
        if (sameCue(track.cues[j], cues[i])) { dup = true; break; }
      }
      if (!dup) { track.cues.push(cues[i]); added++; }
    }
    if (added) { track.cues.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); }); }
    return added;
  }

  /* Adds parsed cues as a track; used by the hook path and by <track> elements. */
  function addTrack(info) {
    var key = info.key || trackKey(info.url), t = tracks[key], added, i;
    if (!info.cues || !info.cues.length) { return null; }
    if (!t) {
      if (order.length >= MAX_TRACKS) { delete tracks[order.shift()]; }
      t = tracks[key] = { key: key, url: info.url || '', lang: info.lang || langFromUrl(info.url || ''), format: info.format || '', cues: [], segments: 0, source: info.source || 'hook' };
      order.push(key);
    }
    t.segments++;
    added = addCues(t, info.cues);
    if (added) {
      for (i = 0; i < listeners.length; i++) {
        try { listeners[i](t); } catch (e) { /* listener errors must not stop others */ }
      }
    }
    return t;
  }

  function onMessage(e) {
    var d = e.data, parsed;
    if (e.source !== window || !d || d.bo !== 'bonis-oculis-hook' || d.nonce !== nonce) { return; }
    if (d.type === 'track' && typeof d.text === 'string') {
      parsed = BO.subscan.parseAuto(d.text, d.format || d.url);
      if (parsed.cues.length) { addTrack({ url: d.url, format: parsed.format, cues: parsed.cues, source: 'hook' }); }
    }
  }

  function start() {
    if (started) { return; }
    started = true;
    nonce = BO.util.randomHex(16);
    window.addEventListener('message', onMessage);
    window.addEventListener('bonis-oculis:hello', function () { announce(); }, true);
    announce();
  }

  function announce() {
    try { window.dispatchEvent(new CustomEvent('bonis-oculis:nonce', { detail: nonce })); } catch (e) { /* ignore */ }
  }

  /* fn(track) for every track now and every new or grown track later. Returns an unsubscribe function. */
  function onTrack(fn) {
    var i;
    listeners.push(fn);
    for (i = 0; i < order.length; i++) {
      if (tracks[order[i]]) { try { fn(tracks[order[i]]); } catch (e) { /* ignore */ } }
    }
    return function () {
      var k = listeners.indexOf(fn);
      if (k >= 0) { listeners.splice(k, 1); }
    };
  }

  function list() {
    var out = [], i;
    for (i = 0; i < order.length; i++) { if (tracks[order[i]]) { out.push(tracks[order[i]]); } }
    return out;
  }

  function reset() { tracks = {}; order = []; }

  function send(cmd) {
    var msg = {}, k;
    if (!nonce) { return; }
    for (k in cmd) { if (Object.prototype.hasOwnProperty.call(cmd, k)) { msg[k] = cmd[k]; } }
    msg.bo = 'bonis-oculis-content';
    msg.nonce = nonce;
    window.postMessage(msg, window.location.origin && window.location.origin !== 'null' ? window.location.origin : '*');
  }

  BO.bridge = { start: start, onTrack: onTrack, addTrack: addTrack, list: list, reset: reset, send: send, trackKey: trackKey, langFromUrl: langFromUrl };
}(typeof self !== 'undefined' ? self : this));
