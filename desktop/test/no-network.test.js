'use strict';
// PLAN 0.6 / 6: no code path opens a network socket. Only player-controller.js may require 'net',
// and only for mpv's local IPC pipe. The renderer has no fetch / XHR / WebSocket and no remote URL.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var ALLOWED = [path.join('desktop', 'main', 'player-controller.js')];

function walk(dir, out) {
  fs.readdirSync(dir).forEach(function (n) {
    if (n === 'node_modules' || n === '.git') { return; }
    var f = path.join(dir, n);
    var st = fs.statSync(f);
    if (st.isDirectory()) { walk(f, out); } else if (/\.(js|html)$/.test(n)) { out.push(f); }
  });
  return out;
}

test('only player-controller.js requires a network module', function () {
  var re = /require\(\s*['"](?:node:)?(net|http|https|http2|dns|dgram|tls)['"]\s*\)/;
  var hits = [];
  walk(path.join(ROOT, 'desktop'), []).concat(walk(path.join(ROOT, 'shared'), [])).forEach(function (f) {
    var rel = path.relative(ROOT, f);
    if (/\btest\b/.test(rel) && /no-network\.test\.js$/.test(rel)) { return; }
    var src = fs.readFileSync(f, 'utf8');
    if (re.test(src)) { hits.push(rel); }
  });
  assert.deepStrictEqual(hits, ALLOWED);
  var pc = fs.readFileSync(path.join(ROOT, ALLOWED[0]), 'utf8');
  assert.ok(!/net\.(createServer|Server)\b/.test(pc), 'no server');
  assert.ok(!/net\.connect\(\s*\{?\s*port/.test(pc), 'no TCP connection');
});

test('the renderer never talks to a network', function () {
  var re = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|RTCPeerConnection)/;
  walk(path.join(ROOT, 'desktop', 'renderer'), []).concat([path.join(ROOT, 'desktop', 'preload.js')]).forEach(function (f) {
    if (/design-preview\.html$/.test(f)) { return; }
    assert.ok(!re.test(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f));
  });
});

test('no telemetry, auto-updater or crash reporter in main', function () {
  walk(path.join(ROOT, 'desktop', 'main'), []).forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8');
    assert.ok(!/autoUpdater|crashReporter|electron-updater|net\.request|session\.[a-zA-Z]+\.fetch/.test(src), path.relative(ROOT, f));
  });
  var main = fs.readFileSync(path.join(ROOT, 'desktop', 'main', 'main.js'), 'utf8');
  assert.ok(/onBeforeRequest\(function \(details, cb\) \{\s*cb\(\{ cancel: !\/\^\(file\|data\|devtools\|chrome-devtools\):\/i/.test(main), 'every request but file:, data: and DevTools is cancelled');
  assert.ok(/setSpellCheckerEnabled\(false\)/.test(main), 'no spell-check dictionary download');
  assert.ok(/app\.setPath\('crashDumps', path\.join\(app\.getPath\('userData'\), 'crash'\)\)/.test(main), 'crash dumps stay in the app folder');
  ['disable-component-update', 'disable-background-networking'].forEach(function (sw) { assert.ok(main.indexOf("appendSwitch('" + sw + "')") >= 0, sw); });
});
