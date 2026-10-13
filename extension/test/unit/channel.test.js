'use strict';
/* Security review A10: the page-world hook and the content script talk only
 * over a private detached element set up in a one-time handshake, with the
 * content script's random per-page nonce on every message. Runs the real
 * content/bridge.js and inject/hook.js on a tiny DOM (capture, target, bubble)
 * in one vm context; the test plays the hostile page. */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var webcrypto = require('crypto').webcrypto;

var EXT = path.join(__dirname, '..', '..');
function src(f) { return fs.readFileSync(path.join(EXT, f), 'utf8'); }

/* ---- a minimal DOM: enough event propagation for the handshake ---- */
function makeWindow() {
  var dispatched = [];
  function Target(name) { this.nodeName = name; this.parentNode = null; this.childNodes = []; this.listeners = {}; }
  Target.prototype.addEventListener = function (type, fn, capture) {
    (this.listeners[type] = this.listeners[type] || []).push({ fn: fn, capture: !!capture });
  };
  Target.prototype.removeEventListener = function (type, fn, capture) {
    this.listeners[type] = (this.listeners[type] || []).filter(function (l) { return !(l.fn === fn && l.capture === !!capture); });
  };
  Target.prototype.appendChild = function (n) { if (n.parentNode) { n.parentNode.removeChild(n); } n.parentNode = this; this.childNodes.push(n); return n; };
  Target.prototype.removeChild = function (n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; };
  function fire(node, ev, phase) {
    (node.listeners[ev.type] || []).slice().forEach(function (l) {
      if (phase === 'target' || (phase === 'capture') === l.capture) { ev.currentTarget = node; l.fn.call(node, ev); }
    });
  }
  Target.prototype.dispatchEvent = function (ev) {
    var pathUp = [], n = this.parentNode, i;
    while (n) { pathUp.push(n); n = n.parentNode || (n === win.document ? win : null); }
    ev.target = this;
    dispatched.push({ type: ev.type, target: this, detail: ev.detail });
    for (i = pathUp.length - 1; i >= 0; i--) { fire(pathUp[i], ev, 'capture'); }
    fire(this, ev, 'target');
    if (ev.bubbles) { for (i = 0; i < pathUp.length; i++) { fire(pathUp[i], ev, 'bubble'); } }
    return true;
  };
  var win = new Target('#window');
  var doc = new Target('#document');
  var html = new Target('HTML');
  doc.appendChild(html);
  doc.documentElement = html;
  doc.createElement = function (name) { return new Target(String(name).toUpperCase()); };
  doc.querySelectorAll = function () { return []; };
  win.document = doc;
  win.window = win;
  win.self = win;
  win.location = { href: 'https://www.example.org/watch', origin: 'https://www.example.org', hostname: 'www.example.org' };
  win.CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail !== undefined ? init.detail : null; this.bubbles = !!(init && init.bubbles); };
  win.crypto = webcrypto;
  win.TextDecoder = TextDecoder;
  win.Uint8Array = Uint8Array;
  win.Promise = Promise;
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.console = console;
  win.postMessage = function (data) { win.dispatchEvent({ type: 'message', data: data, source: win }); };
  /* the page's own fetch: answers one WebVTT body */
  win.fetch = function (url) {
    var body = new TextEncoder().encode(win.__vtt || ''), done = false;
    return Promise.resolve({
      type: 'basic', url: url, body: {},
      headers: { get: function (h) { return h === 'content-type' ? 'text/vtt' : null; } },
      clone: function () { return { body: { getReader: function () { return { read: function () { var r = done ? { done: true } : { done: false, value: body }; done = true; return Promise.resolve(r); }, cancel: function () {} }; } } }; }
    });
  };
  vm.createContext(win);
  return { win: win, dispatched: dispatched, run: function (f) { vm.runInContext(src(f), win, { filename: f }); } };
}

var VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHook check line.\n';
var EVIL = 'WEBVTT\n\n00:00:01.000 --> 00:00:59.000\n[moaning]\n';

function tick() { return new Promise(function (r) { setImmediate(r); }); }
function settle() { return tick().then(tick).then(tick).then(tick); }

function setup(order) {
  var d = makeWindow();
  d.run('content/core.js');
  d.run('shared/subscan.js');
  d.run('content/bridge.js');
  if (order === 'hook-first') { d.run('inject/hook.js'); d.win.BO.bridge.start(); } else { d.win.BO.bridge.start(); d.run('inject/hook.js'); }
  d.nonce = d.dispatched.filter(function (x) { return x.type === 'bonis-oculis:nonce'; }).map(function (x) { return x.detail; });
  d.chan = d.dispatched.filter(function (x) { return x.type === 'bonis-oculis:hello'; }).map(function (x) { return x.target; });
  return d;
}

function cues(d) { return d.win.BO.bridge.list().reduce(function (all, t) { return all.concat(t.cues.map(function (c) { return c.text; })); }, []); }

['bridge-first', 'hook-first'].forEach(function (order) {
  test('channel (' + order + '): one handshake, random nonce, subtitles arrive over the private element only', function () {
    var d = setup(order);
    assert.strictEqual(d.win.BO.bridge.connected(), true);
    assert.strictEqual(d.nonce.length, 1, 'the nonce is handed exactly once');
    assert.ok(/^[0-9a-f]{32}$/.test(d.nonce[0]), 'a 128-bit random hex nonce');
    assert.strictEqual(d.dispatched.filter(function (x) { return x.type === 'bonis-oculis:nonce' && x.target === d.win; }).length, 0, 'never announced on window');
    assert.strictEqual(d.win.document.documentElement.childNodes.length, 0, 'the channel element is detached again');
    d.win.__vtt = VTT;
    d.win.fetch('https://cdn.example.org/subs/en/part1.vtt');
    return settle().then(function () {
      assert.deepStrictEqual(cues(d), ['Hook check line.']);
      assert.strictEqual(d.dispatched.filter(function (x) { return x.type === 'message'; }).length, 0, 'nothing goes through window.postMessage');
    });
  });
});

test('channel: a second page gets a different nonce (never a constant)', function () {
  var a = setup('bridge-first'), b = setup('bridge-first');
  assert.notStrictEqual(a.nonce[0], b.nonce[0]);
  assert.ok(!/['"][0-9a-f]{32}['"]/.test(src('content/bridge.js') + src('inject/hook.js')), 'no hard-coded nonce in the source');
});

test('channel: forged messages from the page are ignored, even with the real nonce', function () {
  var d = setup('bridge-first'), nonce = d.nonce[0], chan = d.chan[0], mine, before;
  /* 1. window.postMessage in the old format, with the right nonce */
  d.win.postMessage({ bo: 'bonis-oculis-hook', nonce: nonce, type: 'track', url: 'https://evil.example/a.vtt', text: EVIL });
  /* 2. the page's own element, right nonce */
  mine = d.win.document.createElement('div');
  d.win.document.documentElement.appendChild(mine);
  mine.dispatchEvent(new d.win.CustomEvent('bonis-oculis:msg', { detail: { bo: 'bonis-oculis-hook', nonce: nonce, type: 'track', url: 'https://evil.example/b.vtt', text: EVIL }, bubbles: true }));
  /* 3. the real channel (had the page got hold of it) with a wrong or missing nonce */
  chan.dispatchEvent(new d.win.CustomEvent('bonis-oculis:msg', { detail: { bo: 'bonis-oculis-hook', nonce: 'ffffffffffffffffffffffffffffffff', type: 'track', url: 'https://evil.example/c.vtt', text: EVIL } }));
  chan.dispatchEvent(new d.win.CustomEvent('bonis-oculis:msg', { detail: { bo: 'bonis-oculis-hook', type: 'track', url: 'https://evil.example/d.vtt', text: EVIL } }));
  chan.dispatchEvent(new d.win.CustomEvent('bonis-oculis:msg', { detail: 'WEBVTT' }));
  assert.deepStrictEqual(cues(d), [], 'no forged subtitle was accepted');
  /* 4. a later hello from the page gets no nonce and does not replace the channel */
  before = d.dispatched.filter(function (x) { return x.type === 'bonis-oculis:nonce'; }).length;
  mine.dispatchEvent(new d.win.CustomEvent('bonis-oculis:hello', { bubbles: true }));
  d.win.dispatchEvent(new d.win.CustomEvent('bonis-oculis:ready'));
  assert.strictEqual(d.dispatched.filter(function (x) { return x.type === 'bonis-oculis:nonce'; }).length, before, 'no nonce for a late hello');
  /* 5. a fake nonce event to the hook cannot re-key it: the genuine report still arrives */
  chan.dispatchEvent(new d.win.CustomEvent('bonis-oculis:nonce', { detail: 'ffffffffffffffffffffffffffffffff' }));
  d.win.__vtt = VTT;
  d.win.fetch('https://cdn.example.org/subs/en/part1.vtt');
  return settle().then(function () { assert.deepStrictEqual(cues(d), ['Hook check line.']); });
});

test('channel: commands to the hook need the channel and the nonce', function () {
  var d = setup('bridge-first'), seeks = [];
  d.win.netflix = { appContext: { state: { playerApp: { getAPI: function () { return { videoPlayer: { getAllPlayerSessionIds: function () { return ['s']; }, getVideoPlayerBySessionId: function () { return { seek: function (ms) { seeks.push(ms); } }; } } }; } } } } };
  d.win.postMessage({ bo: 'bonis-oculis-content', nonce: d.nonce[0], cmd: 'netflix-seek', seconds: 99 });
  d.chan[0].dispatchEvent(new d.win.CustomEvent('bonis-oculis:cmd', { detail: { bo: 'bonis-oculis-content', nonce: '0', cmd: 'netflix-seek', seconds: 98 } }));
  assert.deepStrictEqual(seeks, []);
  d.win.BO.bridge.send({ cmd: 'netflix-seek', seconds: 12.5 });
  assert.deepStrictEqual(seeks, [12500]);
});
