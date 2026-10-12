'use strict';
/* Live listening, pure parts: the YAMNet class table (against the analyzer's
 * AUDIO_CLASS_MAP and the official class list), the cover/release state
 * machine fed with score streams, the resampler on synthetic sines, noise and
 * silence, and the 0.96 s / 0.48 s windower. Nothing explicit: tones, noise,
 * silence and numbers. */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var EXT = path.join(__dirname, '..', '..');
var ROOT = path.join(EXT, '..');

function load() {
  var g = {};
  g.self = g;
  vm.createContext(g);
  ['audio/classmap.js', 'audio/live.js'].forEach(function (f) { vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), g, { filename: f }); });
  return g.BO;
}
var BO = load();
/* objects made in the vm context have another Object.prototype: compare plain copies */
function plain(o) { return JSON.parse(JSON.stringify(o)); }
var CM = BO.classmap;
var L = BO.live;

/* ------------------------------------------------------------------ */
/* class map                                                           */
/* ------------------------------------------------------------------ */

function analyzerMap() {
  var src = fs.readFileSync(path.join(ROOT, 'analyzer', 'bonis_analyzer', 'config.py'), 'utf8');
  var block = /AUDIO_CLASS_MAP[^=]*=\s*\{([\s\S]*?)\n\}/.exec(src)[1], out = {}, re = /^\s*"([^"]+)":\s*\{([^}]*)\}/gm, m;
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = {};
    m[2].replace(/"([a-z]+)":\s*([0-9.]+)/g, function (x, c, w) { out[m[1]][c] = Number(w); return x; });
  }
  return out;
}

function csvNames() {
  var names = [];
  fs.readFileSync(path.join(ROOT, 'analyzer', 'models', 'yamnet_class_map.csv'), 'utf8').split(/\r?\n/).slice(1).forEach(function (l) {
    var m = /^(\d+),[^,]*,(.*)$/.exec(l);
    if (m) { names[+m[1]] = m[2].replace(/^"|"$/g, ''); }
  });
  return names;
}

test('classmap: same classes and weights as the analyzer, indices from the official class list', function () {
  var ref = analyzerMap(), names = csvNames(), mine = {};
  assert.strictEqual(names.length, 521);
  assert.strictEqual(CM.CLASSES, 521);
  CM.TABLE.forEach(function (row) {
    assert.strictEqual(names[row[0]], row[1], 'index ' + row[0]);
    mine[row[1]] = JSON.parse(JSON.stringify(row[2]));
  });
  assert.ok(Object.keys(ref).length >= 10, 'parsed the analyzer table');
  assert.deepStrictEqual(mine, ref);
  assert.ok(/AUDIO_CLASS_MAP/.test(CM.SOURCE));
});

test('classmap sums: per-category weight sums, max of weighted scores, bounds', function () {
  var sums = {}, zeros = new Float32Array(521), ones = new Float32Array(521), m, i, v;
  CM.TABLE.forEach(function (row) { Object.keys(row[2]).forEach(function (c) { sums[c] = Math.round(((sums[c] || 0) + row[2][c]) * 100) / 100; }); });
  /* sex 0.9+0.7+0.6+0.55+0.5+0.4+0.4; implied 0.7+0.5+0.4+0.4+0.35+0.3+0.25; gore 0.8+0.8+0.7+0.7+0.5+0.5+0.45+0.45+0.3 */
  assert.deepStrictEqual(sums, { sex: 4.05, implied: 2.9, gore: 5.2 });
  assert.deepStrictEqual(plain(CM.map(zeros)), { sex: 0, implied: 0, gore: 0 });
  m = plain(CM.map(ones.fill(1)));
  assert.deepStrictEqual(m, { sex: 0.9, implied: 0.7, gore: 0.8 }, 'max, never a sum');
  CM.TABLE.forEach(function (row) {
    var x = new Float32Array(521);
    x[row[0]] = 0.5;
    v = CM.map(x);
    Object.keys(row[2]).forEach(function (c) { assert.ok(Math.abs(v[c] - row[2][c] * 0.5) < 1e-6, row[1] + ' ' + c); });
  });
  /* out-of-range model output is clamped; NaN ignored */
  zeros = new Float32Array(521);
  zeros[421] = 7;
  zeros[22] = NaN;
  assert.deepStrictEqual(plain(CM.map(zeros)), { sex: 0, implied: 0, gore: 0.8 });
  for (i = 0; i < 200; i++) {
    ones = new Float32Array(521).map(function () { return Math.random(); });
    v = CM.map(ones);
    assert.ok(v.sex >= 0 && v.sex <= 0.9 && v.implied <= 0.7 && v.gore <= 0.8);
  }
  /* Explosion and Screaming alone stay under the 0.6 violence threshold, as in the analyzer */
  zeros = new Float32Array(521);
  zeros[420] = 1;
  zeros[11] = 1;
  assert.ok(CM.map(zeros).gore < L.DEFAULTS.on.gore);
  assert.deepStrictEqual(plain(CM.top([0.1, 0.9, 0.3, 0.5], 2)), [[1, 0.9], [3, 0.5]]);
});

/* ------------------------------------------------------------------ */
/* hysteresis                                                          */
/* ------------------------------------------------------------------ */

var HOP = 0.48;

function run(stream, opts) {
  var h = L.createHysteresis(opts), events = [];
  stream.forEach(function (f, i) {
    var ev = h.feed({ t: (i + 2) * HOP, sex: f[0] || 0, gore: f[1] || 0 });
    if (ev) { ev.i = i; events.push(ev); }
  });
  return { h: h, events: events };
}

function quiet(n) { var out = [], i; for (i = 0; i < n; i++) { out.push([0.02, 0.01]); } return out; }

test('hysteresis: two consecutive windows over the threshold cover; one does not', function () {
  var r = run([[0.9, 0]].concat(quiet(10)));
  assert.strictEqual(r.events.length, 0);
  r = run([[0.4, 0], [0.55, 0], [0.6, 0]].concat(quiet(10)));
  assert.strictEqual(r.events[0].cover, true);
  assert.strictEqual(r.events[0].category, 'sex');
  assert.strictEqual(r.events[0].i, 2);
  /* violence needs 0.6: 0.59 twice is not enough */
  assert.strictEqual(run([[0, 0.59], [0, 0.59], [0, 0.59]]).events.length, 0);
  r = run([[0, 0.6], [0, 0.8]]);
  assert.deepStrictEqual([r.events[0].cover, r.events[0].category, r.events[0].score], [true, 'gore', 0.8]);
  /* two categories at once: the one further over its threshold names the scene */
  r = run([[0.55, 0.9], [0.55, 0.9]]);
  assert.strictEqual(r.events[0].category, 'gore');
});

test('hysteresis: releases exactly at the first window 3 s after the last loud one', function () {
  var stream = [[0.9, 0], [0.9, 0], [0.3, 0], [0.26, 0]].concat(quiet(12)), r = run(stream), lastLoud = 3, rel;
  assert.strictEqual(r.events.length, 2);
  rel = r.events[1];
  assert.strictEqual(rel.cover, false);
  /* window 3 (0.26 >= half of 0.5) is the last loud one; 3 s = 6.25 hops -> 7 windows later */
  assert.strictEqual(rel.i, lastLoud + 7);
  assert.ok(rel.t - (lastLoud + 2) * HOP >= 3 - 1e-9);
  assert.ok((rel.i - 1 + 2) * HOP - (lastLoud + 2) * HOP < 3);
  /* below half the threshold does not keep it covered */
  r = run([[0.9, 0], [0.9, 0]].concat([[0.24, 0], [0.24, 0], [0.24, 0], [0.24, 0], [0.24, 0], [0.24, 0], [0.24, 0], [0.24, 0]]));
  assert.strictEqual(r.events[1].i, 1 + 7);
  /* with other timing the same rule holds: exact 3.0 s boundary releases */
  var h = L.createHysteresis(), ev;
  h.feed({ t: 0, sex: 0.9 });
  h.feed({ t: 0.5, sex: 0.9 });
  assert.strictEqual(h.feed({ t: 3.49, sex: 0 }), null);
  ev = h.feed({ t: 3.5, sex: 0 });
  assert.deepStrictEqual([ev.cover, ev.t], [false, 3.5]);
});

test('hysteresis: never stuck covered (random streams, idle time, stop)', function () {
  var k, i, n, stream, h, covered, lastLoud, t, ev, seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  for (k = 0; k < 300; k++) {
    h = L.createHysteresis();
    covered = false;
    lastLoud = -Infinity;
    n = 20 + Math.floor(rnd() * 200);
    stream = [];
    for (i = 0; i < n; i++) { stream.push(rnd() < 0.3 ? [rnd(), rnd()] : [rnd() * 0.3, rnd() * 0.35]); }
    for (i = 0; i < 8; i++) { stream.push([0, 0]); }
    for (i = 0; i < stream.length; i++) {
      t = (i + 2) * HOP;
      ev = h.feed({ t: t, sex: stream[i][0], gore: stream[i][1] });
      if (stream[i][0] >= 0.25 || stream[i][1] >= 0.3) { lastLoud = t; }
      if (ev) { assert.notStrictEqual(ev.cover, covered, 'events alternate'); covered = ev.cover; }
      if (covered) { assert.ok(t - lastLoud < 3, 'covered only within 3 s of a loud window (stream ' + k + ', window ' + i + ')'); }
    }
    assert.strictEqual(covered, false, 'released after the final quiet stretch');
    assert.strictEqual(h.state().covered, false);
  }
  /* no windows arrive (model busy): time alone releases */
  h = L.createHysteresis();
  h.feed({ t: 1, gore: 0.9 });
  h.feed({ t: 1.48, gore: 0.9 });
  assert.strictEqual(h.idle(4.0), null);
  assert.strictEqual(h.idle(4.48).cover, false);
  /* stopping always uncovers */
  h = L.createHysteresis();
  h.feed({ t: 1, sex: 0.9 });
  h.feed({ t: 1.48, sex: 0.9 });
  ev = h.stop();
  assert.deepStrictEqual([ev.cover, ev.category], [false, 'sex']);
  assert.strictEqual(h.stop(), null);
});

test('hysteresis: no flapping around the threshold', function () {
  var stream = [], i, r;
  /* hovers around the threshold for 60 windows: one cover, no release while it hovers */
  for (i = 0; i < 60; i++) { stream.push([i % 2 ? 0.52 : 0.47, 0]); }
  r = run(stream.concat(quiet(10)));
  assert.strictEqual(r.events.filter(function (e) { return e.cover; }).length, 0, 'never two in a row over 0.5');
  stream = [];
  for (i = 0; i < 60; i++) { stream.push([i % 3 ? 0.55 : 0.3, 0]); }
  r = run(stream.concat(quiet(10)));
  assert.deepStrictEqual(r.events.map(function (e) { return e.cover; }), [true, false]);
  /* single loud windows every 2.5 s: no cover at all */
  stream = [];
  for (i = 0; i < 60; i++) { stream.push([i % 5 === 0 ? 0.95 : 0.1, 0]); }
  assert.strictEqual(run(stream).events.length, 0);
  /* after a release, one loud window alone does not cover again */
  r = run([[0.9, 0], [0.9, 0]].concat(quiet(8), [[0.9, 0]], quiet(3), [[0.9, 0], [0.9, 0]], quiet(8)));
  assert.deepStrictEqual(r.events.map(function (e) { return [e.cover, e.i]; }), [[true, 1], [false, 8], [true, 15], [false, 22]]);
});

/* ------------------------------------------------------------------ */
/* resampler, downmix, windower                                        */
/* ------------------------------------------------------------------ */

function sine(freq, rate, secs, amp) {
  var n = Math.round(rate * secs), x = new Float32Array(n), i;
  for (i = 0; i < n; i++) { x[i] = (amp || 1) * Math.sin(2 * Math.PI * freq * i / rate); }
  return x;
}

function resampleChunked(x, inRate, chunk) {
  var r = L.createResampler(inRate, 16000), parts = [], o, out, k = 0, n = 0;
  for (o = 0; o < x.length; o += chunk) { parts.push(r.process(x.subarray(o, Math.min(x.length, o + chunk)))); }
  parts.push(r.flush());
  parts.forEach(function (p) { n += p.length; });
  out = new Float32Array(n);
  parts.forEach(function (p) { out.set(p, k); k += p.length; });
  return out;
}

/* amplitude of frequency f in y (16 kHz) over `len` samples after skipping the start */
function amp(y, f, len) {
  var re = 0, im = 0, i, a = 1000, b = Math.min(y.length - 1000, a + (len || 16000));
  for (i = a; i < b; i++) { re += y[i] * Math.cos(2 * Math.PI * f * i / 16000); im += y[i] * Math.sin(2 * Math.PI * f * i / 16000); }
  return 2 * Math.sqrt(re * re + im * im) / (b - a);
}

/* coarse scan of 0-8 kHz on 20 ms (50 Hz resolution), then 1 Hz steps on 1 s around the peak */
function dominant(y) {
  var best = 0, bf = 0, f, a, lo;
  for (f = 50; f <= 7950; f += 25) { a = amp(y, f, 320); if (a > best) { best = a; bf = f; } }
  lo = bf - 50;
  best = 0;
  for (f = lo; f <= lo + 100; f++) { a = amp(y, f); if (a > best) { best = a; bf = f; } }
  return bf;
}

test('resampler: 48 kHz and 44.1 kHz sines come out at 16 kHz with the same frequency and level', function () {
  [[48000, 1000], [44100, 440], [44100, 3000], [48000, 6000], [22050, 1500], [16000, 2500]].forEach(function (c) {
    var y = resampleChunked(sine(c[1], c[0], 2, 0.5), c[0], 1031), expected = 32000, r = L.createResampler(c[0], 16000), tol = c[1] > 5000 ? 0.04 : 0.01;
    assert.ok(Math.abs(y.length - expected) <= 2 + Math.ceil(r.half * 16000 / c[0]), c[0] + ' Hz: ' + y.length + ' samples');
    assert.strictEqual(dominant(y), c[1], c[0] + ' -> ' + c[1] + ' Hz');
    /* flat to 5 kHz; 6 kHz sits near the 7.4 kHz cutoff and loses under 0.7 dB */
    assert.ok(Math.abs(amp(y, c[1]) - 0.5) < tol, c[1] + ' Hz level kept: ' + amp(y, c[1]));
  });
});

test('resampler: tones above 8 kHz are filtered, not folded into the band', function () {
  var y = resampleChunked(sine(11000, 48000, 1, 0.8), 48000, 2048);
  assert.ok(L.rms(y.subarray(500, y.length - 500)) < 0.002, 'alias rms ' + L.rms(y));
  y = resampleChunked(sine(13000, 44100, 1, 0.8), 44100, 4096);
  assert.ok(L.rms(y.subarray(500, y.length - 500)) < 0.002);
});

test('resampler: chunk size does not change the output; silence stays silent; noise is bounded', function () {
  var x = sine(700, 48000, 1, 0.7), a = resampleChunked(x, 48000, 128), b = resampleChunked(x, 48000, 48000), i, n, seed = 3, z;
  assert.strictEqual(a.length, b.length);
  for (i = 0; i < a.length; i++) { assert.ok(Math.abs(a[i] - b[i]) < 1e-6); }
  z = resampleChunked(new Float32Array(48000), 48000, 4096);
  assert.strictEqual(L.rms(z), 0);
  n = new Float32Array(48000).map(function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 1073741824 - 1; });
  z = resampleChunked(n, 48000, 4096);
  /* white noise over 0-24 kHz keeps about a third of its power below 7.4 kHz */
  assert.ok(L.rms(z) > 0.25 && L.rms(z) < 0.45, 'noise rms ' + L.rms(z));
  for (i = 0; i < z.length; i++) { assert.ok(Math.abs(z[i]) < 1.5); }
});

test('downmix: averages channels', function () {
  var m = L.downmix([new Float32Array([1, 0.5, -1]), new Float32Array([0, 0.5, 1])]);
  assert.deepStrictEqual(Array.prototype.slice.call(m), [0.5, 0.5, 0]);
  assert.strictEqual(L.downmix([]).length, 0);
});

test('windower: first window after 0.96 s, then one every 0.48 s, each the last 15360 samples', function () {
  var w = L.createWindower(), got = [], x = new Float32Array(16000 * 3), i;
  for (i = 0; i < x.length; i++) { x[i] = i; }
  for (i = 0; i < x.length; i += 1000) {
    w.push(x.subarray(i, i + 1000), function (win, t) { got.push([t, win[0], win[win.length - 1], win.length]); });
  }
  assert.deepStrictEqual(got.map(function (g) { return g[0]; }), [0.96, 1.44, 1.92, 2.4, 2.88]);
  got.forEach(function (g) {
    assert.strictEqual(g[3], 15360);
    assert.strictEqual(g[2], g[0] * 16000 - 1);
    assert.strictEqual(g[1], g[0] * 16000 - 15360);
  });
});

test('pipeline: 2 s silence + 3 s noise impulses + 2 s silence at 48 kHz -> 13 windows, loud ones only in the middle', function () {
  var rate = 48000, x = new Float32Array(rate * 7), i, t, seed = 11, r = L.createResampler(rate, 16000), w = L.createWindower(), wins = [];
  for (i = 2 * rate; i < 5 * rate; i++) {
    t = (i / rate) % 0.08;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    x[i] = (seed / 1073741824 - 1) * Math.exp(-35 * t) * 0.8;
  }
  for (i = 0; i < x.length; i += 2048) {
    w.push(r.process(x.subarray(i, i + 2048)), function (win, end) { wins.push([end, L.rms(win)]); });
  }
  assert.strictEqual(wins.length, 13);
  wins.forEach(function (wv) {
    var start = wv[0] - 0.96;
    if (wv[0] < 1.95) { assert.ok(wv[1] < 1e-4, 'silent window at ' + wv[0]); }
    if (start > 2.05 && wv[0] < 4.95) { assert.ok(wv[1] > 0.05, 'loud window at ' + wv[0]); }
  });
});
