/*
 * bonis oculis - page-world subtitle hook (runs in the page's MAIN world).
 *
 * MV3 extensions cannot read response bodies, so this small script wraps
 * window.fetch and XMLHttpRequest to notice the subtitle files the page
 * downloads for itself (WebVTT, TTML/DFXP, YouTube json3/srv3). It never
 * makes a request of its own, never touches video or audio data, and never
 * changes what the page receives: it reads a copy of text responses that
 * look like subtitles and hands the text to the extension's isolated world
 * with window.postMessage, tagged with a per-page nonce.
 *
 * Nonce handshake: the isolated content script makes a random nonce and
 * announces it with a 'bonis-oculis:nonce' CustomEvent; this script asks for
 * it with 'bonis-oculis:hello' in case it ran second. Both run at
 * document_start, before any page script, and only the first nonce is kept.
 * The nonce tells our messages apart from anything else on the page; it is
 * not a security boundary (a hostile page controls its own video anyway).
 *
 * Commands from the isolated world (same nonce): {cmd: 'netflix-seek',
 * seconds} asks the Netflix player to seek. Best effort, may break when
 * Netflix updates its player; the extension never relies on it.
 * ES5. No dependencies.
 */
(function () {
  'use strict';
  var w = window;
  if (w.__bonisOculisHook) { return; }
  try { Object.defineProperty(w, '__bonisOculisHook', { value: true, enumerable: false }); } catch (e0) { w.__bonisOculisHook = true; }

  var TAG = 'bonis-oculis-hook';
  var MAX_TEXT = 8 * 1024 * 1024;
  var URL_HINT = /timedtext|\.vtt(\b|$)|webvtt|\.ttml2?(\b|$)|\.dfxp(\b|$)|\.srt(\b|$)|\.xml(\b|$)|subtitle|caption|texttrack|\/subs?\//i;
  var TYPE_HINT = /vtt|ttml|dfxp|xml|json|text\/plain|octet-stream/i;
  var nonce = null;
  var queue = [];
  var origFetch = w.fetch;
  var XHR = w.XMLHttpRequest;

  function target() { return w.location.origin && w.location.origin !== 'null' ? w.location.origin : '*'; }

  function post(msg) {
    msg.bo = TAG;
    if (!nonce) {
      if (queue.length < 40) { queue.push(msg); }
      return;
    }
    msg.nonce = nonce;
    try { w.postMessage(msg, target()); } catch (e) { /* ignore */ }
  }

  function setNonce(v) {
    var q, i;
    if (nonce || typeof v !== 'string' || v.length < 16) { return; }
    nonce = v;
    q = queue;
    queue = [];
    for (i = 0; i < q.length; i++) { post(q[i]); }
  }

  w.addEventListener('bonis-oculis:nonce', function (e) { setNonce(e && e.detail); }, true);
  try { w.dispatchEvent(new CustomEvent('bonis-oculis:hello')); } catch (e1) { /* ignore */ }

  function head(text) { return String(text).slice(0, 4096).replace(/^﻿/, '').replace(/^\s+/, ''); }

  function looksLikeSubs(text) {
    var h = head(text);
    if (/^WEBVTT/.test(h)) { return 'vtt'; }
    if (/^</.test(h) && /<(\w+:)?tt[\s>]|<timedtext[\s>]/i.test(h)) { return 'ttml'; }
    if (/^[{]/.test(h) && /"events"\s*:/.test(h) && /"tStartMs"|"segs"/.test(h)) { return 'json3'; }
    return null;
  }

  /* Cheap test on the first chunk, so large JSON or media responses are dropped early. */
  function promising(start) {
    var h = head(start);
    if (/^WEBVTT/.test(h)) { return true; }
    if (/^</.test(h)) { return /^<\?xml/.test(h) || /<(\w+:)?tt[\s>]|<timedtext[\s>]/i.test(h); }
    if (/^[{]/.test(h)) { return /"events"|"wireMagic"/.test(h); }
    return false;
  }

  function maybeText(c) { return c === 0x3C || c === 0x57 || c === 0x7B || c === 0xEF || c === 0xFE || c === 0xFF || c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09; }

  function report(url, text, ct) {
    var kind;
    if (typeof text !== 'string' || !text || text.length > MAX_TEXT) { return; }
    kind = looksLikeSubs(text);
    if (kind) { post({ type: 'track', url: String(url || ''), text: text, contentType: String(ct || ''), format: kind }); }
  }

  function decode(buf) {
    try { return new TextDecoder('utf-8').decode(buf); } catch (e) { return ''; }
  }

  /* ----- fetch ----- */
  function inspectResponse(res, reqUrl) {
    var url, ct, len, clone, reader, chunks = [], total = 0;
    try {
      if (!res || res.type === 'opaque' || !res.body) { return; }
      url = res.url || reqUrl || '';
      ct = res.headers.get('content-type') || '';
      len = parseInt(res.headers.get('content-length') || '0', 10);
      if (len > MAX_TEXT) { return; }
      if (!URL_HINT.test(url) && !TYPE_HINT.test(ct)) { return; }
      if (/^(video|audio|image)\//i.test(ct)) { return; }
      clone = res.clone();
      reader = clone.body.getReader();
    } catch (e) { return; }
    function pump() {
      reader.read().then(function (r) {
        var first, merged, i, off;
        if (r.done) {
          merged = new Uint8Array(total);
          off = 0;
          for (i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }
          report(url, decode(merged), ct);
          return;
        }
        if (!chunks.length) {
          first = r.value;
          if (!first || !first.length || !maybeText(first[0]) || !promising(decode(first.subarray(0, 4096)))) {
            try { reader.cancel(); } catch (e2) { /* ignore */ }
            return;
          }
        }
        chunks.push(r.value);
        total += r.value.length;
        if (total > MAX_TEXT) { try { reader.cancel(); } catch (e3) { /* ignore */ } return; }
        pump();
      }, function () { /* stream error: ignore */ });
    }
    pump();
  }

  if (typeof origFetch === 'function') {
    w.fetch = function fetch(input, init) {
      var p = origFetch.apply(this, arguments), reqUrl = '';
      try { reqUrl = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (e) { reqUrl = ''; }
      try {
        p.then(function (res) { inspectResponse(res, reqUrl); }, function () { /* network error: the page handles it */ });
      } catch (e4) { /* ignore */ }
      return p;
    };
    try { w.fetch.toString = function () { return origFetch.toString(); }; } catch (e5) { /* ignore */ }
  }

  /* ----- XMLHttpRequest ----- */
  if (XHR && XHR.prototype) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__boUrl = String(url); } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          var rt, ct, text, buf, b;
          try {
            if (xhr.status && (xhr.status < 200 || xhr.status >= 300)) { return; }
            rt = xhr.responseType;
            ct = xhr.getResponseHeader('content-type') || '';
            if (/^(video|audio|image)\//i.test(ct)) { return; }
            if (rt === '' || rt === 'text') {
              text = xhr.responseText;
              if (text && text.length <= MAX_TEXT && maybeText(text.charCodeAt(0) & 0xFF)) { report(xhr.responseURL || xhr.__boUrl, text, ct); }
            } else if (rt === 'arraybuffer' && xhr.response) {
              buf = xhr.response;
              if (buf.byteLength > MAX_TEXT || buf.byteLength < 8) { return; }
              b = new Uint8Array(buf, 0, 1);
              if (maybeText(b[0])) { report(xhr.responseURL || xhr.__boUrl, decode(new Uint8Array(buf)), ct); }
            } else if (rt === 'json' && xhr.response && typeof xhr.response === 'object' && xhr.response.events) {
              report(xhr.responseURL || xhr.__boUrl, JSON.stringify(xhr.response), ct);
            }
          } catch (e) { /* ignore */ }
        });
      } catch (e6) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  /* ----- commands from the isolated world ----- */
  function netflixSeek(seconds) {
    var api, ids, player;
    try {
      api = w.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      ids = api.getAllPlayerSessionIds();
      player = api.getVideoPlayerBySessionId(ids[ids.length - 1]);
      player.seek(Math.round(seconds * 1000));
      return true;
    } catch (e) { return false; }
  }

  w.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== w || !d || d.bo !== 'bonis-oculis-content' || !nonce || d.nonce !== nonce) { return; }
    if (d.cmd === 'netflix-seek' && typeof d.seconds === 'number' && isFinite(d.seconds)) {
      post({ type: 'cmd-result', cmd: d.cmd, ok: netflixSeek(d.seconds) });
    }
  });
}());
