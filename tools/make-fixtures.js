/*
 * bonis oculis - deterministic fixture generator for spec/fixtures.
 *
 *   node tools/make-fixtures.js          write every fixture
 *   node tools/make-fixtures.js --check  exit 1 if any file on disk differs
 *
 * No randomness, no clock: fixed timestamps and a Park-Miller generator, so
 * two runs produce identical bytes. Expected outputs (EDL, normalise, merge,
 * offsets, validator errors, fingerprints) are produced by shared/skipfile.js
 * and shared/fingerprint.js; the Python port must reproduce them exactly.
 * ES5, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var S = require('../shared/skipfile.js');
var FP = require('../shared/fingerprint.js');

var ROOT = path.join(__dirname, '..', 'spec', 'fixtures');
var T0 = '2026-10-01T09:00:00.000Z';
var T1 = '2026-10-01T10:30:00.000Z';
var NOW = '2026-10-12T12:00:00.000Z';
var CHECK = process.argv.indexOf('--check') >= 0;
var written = [];
var mismatched = [];

/* ---------------------------------------------------------------- utils */

function json(v) { return JSON.stringify(v, null, 2) + '\n'; }

function out(rel, text) {
  var file = path.join(ROOT, rel);
  written.push(rel);
  if (CHECK) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) { mismatched.push(rel); }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/* Park-Miller minimal standard generator; exact in doubles. */
function Rng(seed) { this.x = seed; }
Rng.prototype.next = function () { this.x = (this.x * 48271) % 2147483647; return this.x; };
Rng.prototype.int = function (n) { return this.next() % n; };

function uuid(n) {
  var h = String(n);
  while (h.length < 12) { h = '0' + h; }
  return '6b0c1f2e-3d4a-4b5c-8d6e-' + h;
}

function baseDoc(n, title, duration) {
  return {
    format: 'bonis-oculis-skip',
    version: 1,
    id: uuid(n),
    created: T0,
    modified: T1,
    generator: { app: 'bonis oculis', appVersion: '0.1.0' },
    media: { title: title, duration: duration, fingerprint: { size: 734003200, oshash: '8e245d9679d31e12' } },
    ranges: []
  };
}

function rng(id, start, end, category, confidence, extra) {
  var r = { id: id, start: start, end: end, category: category, confidence: confidence,
    action: 'skip', source: 'auto', review: 'pending' }, k;
  for (k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { r[k] = extra[k]; } }
  return r;
}

function copy(v) { return JSON.parse(JSON.stringify(v)); }

/* ------------------------------------------------------------- valid */

function minimal() {
  return baseDoc(1, 'Minimal', 0);
}

function full() {
  var d = baseDoc(2, 'Full Example (every field)', 5400);
  d.generator = { app: 'bonis oculis', appVersion: '0.1.0', analyzerVersion: '0.1.0', modelSet: 'v1-2026-10' };
  d.media = {
    title: 'Full Example (every field)',
    year: 1999,
    duration: 5400,
    filename: 'Full Example (1999).mkv',
    offset: 0,
    fingerprint: {
      size: 1468006400,
      oshash: '00ff00ff12345678',
      headSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sceneCuts: [0, 4.2, 10.5, 61.04, 120, 600.5, 1200.25, 2700, 4000.75, 5399.9]
    }
  };
  d.language = 'es-MX';
  d.ranges = [
    rng('rnud00001', 600.5, 640.25, 'nudity', 0.93, { intensity: 3, cutStart: 600.5, cutEnd: 640.25,
      signals: { frames: 0.97, subtitles: 0.2, audio: 0.1, speech: 0, captions: 0.8 },
      note: 'Nudity detected in the picture.' }),
    rng('rsex00001', 1200.25, 1260, 'sex', 0.81, { intensity: 2, review: 'approved', action: 'hide',
      note: 'Dialogue and sound suggest intimacy.' }),
    rng('rimp00001', 1500, 1512.5, 'implied', 0.55, { intensity: 1, action: 'blur' }),
    rng('rkis00001', 2000, 2008, 'kissing', 0.62, { intensity: 1, review: 'rejected', action: 'none' }),
    rng('rgor00001', 2700, 2731.75, 'gore', 0.71, { intensity: 3, locked: true, review: 'approved',
      note: 'A violent injury is shown.' }),
    rng('rlan00001', 3000.4, 3001.6, 'language', 0.9, { action: 'mute', source: 'imported' }),
    rng('roth00001', 4000.75, 4010, 'other', 1, { source: 'manual', review: 'approved' }),
    rng('roth00002', 4500, 4503.5, 'other', 1, { source: 'panic', review: 'approved', locked: false })
  ];
  d.scan = {
    status: 'complete',
    startedAt: '2026-10-01T09:00:00Z',
    finishedAt: '2026-10-01T10:29:59.5+02:00',
    stages: {
      subtitles: { status: 'done', progress: 1, seconds: 12.5, model: 'qwen3-0.6b-q4', detail: 'track 2 (es)' },
      frames: { status: 'done', progress: 1, seconds: 2400, model: 'nudenet-320n' },
      audio: { status: 'skipped', detail: 'disabled in settings' },
      speech: { status: 'skipped' },
      captions: { status: 'failed', progress: 0.4, resumeAt: 2160, detail: 'model missing' },
      fusion: { status: 'done', progress: 1, seconds: 0.8 }
    },
    levels: { nudity: 'strict', sex: 'strict', implied: 'moderate', kissing: 'light', gore: 'moderate', language: 'off' },
    device: 'cpu',
    warnings: ['captions stage failed; implied scenes may be missed']
  };
  d.summary = S.summarise(d);
  d.history = [
    { at: T0, event: 'created' },
    { at: '2026-10-01T10:29:59Z', event: 'scanned', detail: 'kept 0, replaced 0, added 8, dropped 0' },
    { at: '2026-10-01T10:31:00Z', event: 'approved', rangeId: 'rsex00001' },
    { at: '2026-10-01T10:32:00Z', event: 'rejected', rangeId: 'rkis00001' },
    { at: '2026-10-01T10:33:00Z', event: 'edited', rangeId: 'rgor00001', detail: 'end +0.5 s' },
    { at: '2026-10-01T10:34:00Z', event: 'added', rangeId: 'roth00001' },
    { at: '2026-10-01T10:35:00Z', event: 'panic', rangeId: 'roth00002' },
    { at: '2026-10-01T10:36:00Z', event: 'deleted', rangeId: 'rdel00001' },
    { at: '2026-10-01T10:37:00Z', event: 'imported', detail: 'language marks from extension' },
    { at: '2026-10-01T10:38:00Z', event: 'exported', detail: 'kodi edl' },
    { at: '2026-10-01T10:39:00Z', event: 'offsetChanged', detail: 'offset 0 -> 0' }
  ];
  return d;
}

function offsetPositive() {
  var d = baseDoc(3, 'Heat, Director\'s Cut', 3600);
  d.media.filename = 'Heat, Director\'s Cut.mkv';
  d.media.offset = 12.5;
  d.ranges = [
    rng('roff00001', 0, 4, 'gore', 0.8),
    rng('roff00002', 100.25, 130, 'nudity', 0.9),
    rng('roff00003', 200, 201.5, 'language', 0.9, { action: 'mute' }),
    rng('roff00004', 3590, 3600, 'sex', 0.7)
  ];
  return d;
}

function offsetNegative() {
  var d = baseDoc(4, 'Shorter Edition', 1200);
  d.media.offset = -5;
  d.ranges = [
    rng('rneg00001', 1, 3, 'nudity', 0.9),
    rng('rneg00002', 2, 10, 'gore', 0.8),
    rng('rneg00003', 300.33, 310.67, 'sex', 0.6, { action: 'blur' }),
    rng('rneg00004', 1195, 1200, 'kissing', 0.5)
  ];
  return d;
}

function overlap() {
  var d = baseDoc(5, 'Overlaps (pending ranges)', 600);
  d.ranges = [
    rng('rj0001', 590, 650, 'nudity', 0.8),
    rng('rb0001', 105, 120, 'nudity', 0.9),
    rng('ra0001', 100, 110, 'nudity', 0.7, { cutStart: 100, intensity: 2 }),
    rng('rc0001', 115, 130, 'gore', 0.6, { cutEnd: 130 }),
    rng('rd0001', 200, 230, 'language', 0.95, { action: 'mute' }),
    rng('re0001', 210, 215, 'sex', 0.5),
    rng('rf0001', 300, 310, 'kissing', 0.8, { review: 'approved', locked: true }),
    rng('rg0001', 305, 320, 'kissing', 0.9),
    rng('rh0001', 400, 410, 'implied', 0.5, { review: 'rejected' }),
    rng('ri0001', 402, 408, 'implied', 0.6),
    rng('rk0001', 650, 660, 'gore', 0.9),
    rng('rl0001', 50, 50.5, 'other', 0.3, { action: 'none' }),
    rng('rn0001', 500, 505, 'sex', 0.7, { action: 'hide', intensity: 1, signals: { frames: 0.4, audio: 0.9 } }),
    rng('rn0002', 503, 506, 'sex', 0.95, { action: 'mute', intensity: 3, signals: { frames: 0.6, subtitles: 0.7 } }),
    rng('rp0001', 450, 480, 'gore', 0.5),
    rng('rq0001', 460, 465, 'nudity', 0.9),
    rng('rs0001', 550, 560, 'gore', 0.8, { review: 'approved' }),
    rng('rt0001', 555, 570, 'gore', 0.6),
    rng('ru0001', 20, 30, 'implied', 0.5),
    rng('ru0001', 25, 26, 'implied', 0.5, { review: 'rejected' })
  ];
  return d;
}

function reviewed() {
  var d = baseDoc(6, 'Reviewed (rejected and locked)', 1000);
  d.ranges = [
    rng('ro0001', 100, 110, 'nudity', 0.8),
    rng('ro0002', 200, 210, 'gore', 0.6, { review: 'rejected', action: 'none' }),
    rng('ro0003', 300, 310, 'kissing', 0.7, { review: 'approved' }),
    rng('ro0004', 400, 420, 'sex', 0.75, { locked: true, note: 'Edges adjusted by a parent.' }),
    rng('ro0005', 500, 505, 'other', 1, { source: 'manual' }),
    rng('ro0006', 600, 603, 'other', 1, { source: 'panic', review: 'approved' }),
    rng('ro0007', 700, 702, 'language', 1, { source: 'imported', action: 'mute' }),
    rng('ro0008', 800, 810, 'implied', 0.5),
    rng('ro0009', 900, 910, 'nudity', 0.65, { review: 'approved', action: 'none', locked: true })
  ];
  d.history = [
    { at: T0, event: 'created' },
    { at: T0, event: 'scanned', detail: 'kept 0, replaced 0, added 9, dropped 0' },
    { at: T1, event: 'rejected', rangeId: 'ro0002' },
    { at: T1, event: 'approved', rangeId: 'ro0003' },
    { at: T1, event: 'edited', rangeId: 'ro0004' }
  ];
  return d;
}

function rescan() {
  var d = baseDoc(7, 'Reviewed (rejected and locked)', 1000.5);
  d.generator = { app: 'bonis oculis', appVersion: '0.2.0', analyzerVersion: '0.2.0', modelSet: 'v2' };
  d.media.title = 'reviewed-rescan.mkv';
  d.media.filename = 'reviewed.mkv';
  d.media.fingerprint.headSha256 = '0000000000000000000000000000000000000000000000000000000000000001';
  d.scan = { status: 'complete', finishedAt: NOW };
  d.ranges = [
    rng('rn0001', 101, 111, 'nudity', 0.85),
    rng('rn0002', 201, 212, 'gore', 0.6),
    rng('rn0003', 205, 230, 'gore', 0.7),
    rng('rn0004', 205, 209, 'nudity', 0.9),
    rng('rn0005', 302, 308, 'kissing', 0.8),
    rng('rn0006', 410, 430, 'sex', 0.9),
    rng('rn0007', 902, 909, 'nudity', 0.7),
    rng('ro0005', 550, 560, 'gore', 0.5),
    rng('rn0009', 805, 815, 'implied', 0.45),
    rng('rn0010', 990, 1010, 'gore', 0.66)
  ];
  d.history = [{ at: NOW, event: 'created' }];
  return d;
}

function movie3h() {
  var d = baseDoc(8, 'Three Hour Epic', 10800), r = new Rng(20261012), i, start, len, cat, conf;
  var cats = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
  var actions = { nudity: 'skip', sex: 'skip', implied: 'hide', kissing: 'blur', gore: 'skip', language: 'mute' };
  var reviews = ['pending', 'pending', 'pending', 'approved', 'approved', 'rejected'];
  var x;
  d.media.year = 2024;
  d.media.filename = 'three_hour_epic.mkv';
  d.media.fingerprint.sceneCuts = [];
  for (i = 0; i < 360; i++) { d.media.fingerprint.sceneCuts.push((i * 300 + r.int(300)) / 10); }
  for (i = 0; i < 60; i++) {
    start = (i * 1800 + r.int(1200)) / 10;
    len = (20 + r.int(580)) / 10;
    cat = cats[r.int(cats.length)];
    conf = (40 + r.int(60)) / 100;
    x = rng('r3h' + (i < 10 ? '00' : '0') + i, start, start + len, cat, conf, {
      action: actions[cat], intensity: 1 + r.int(3), review: reviews[r.int(reviews.length)]
    });
    if (x.review === 'rejected') { x.action = 'none'; }
    if (r.int(4) === 0) { x.signals = { frames: r.int(101) / 100, subtitles: r.int(101) / 100 }; }
    if (r.int(5) === 0) { x.cutStart = start; x.cutEnd = x.end; }
    d.ranges.push(x);
  }
  d.summary = S.summarise(d);
  return d;
}

function futureVersion() {
  var d = baseDoc(9, 'From the future', 120);
  d.version = 2;
  d.chapters = [{ at: 0, title: 'Opening' }];
  d.ranges = [rng('rfut00001', 10, 20, 'nudity', 0.9)];
  return d;
}

function unicodeLimits() {
  var d = baseDoc(10, '', 7200), title = '', note = '', i;
  /* 250 x (BMP char + astral char) = 500 code points, 750 UTF-16 units */
  for (i = 0; i < 250; i++) { title += 'é🎬'; }
  for (i = 0; i < 300; i++) { note += 'ñ'; }
  d.media.title = title;
  d.media.filename = '#película; versión=2 .mkv';
  d.language = 'es';
  d.ranges = [rng('r0123456789abcdef', 0.29, 1.005, 'implied', 0.4, { note: note })];
  d.history = [];
  for (i = 0; i < 2000; i++) {
    d.history.push({ at: '2026-10-01T10:00:00Z', event: i % 2 ? 'approved' : 'edited', rangeId: 'r0123456789abcdef' });
  }
  return d;
}

function edlEdges() {
  var d = baseDoc(11, 'EDL edges', 100);
  d.ranges = [
    rng('redge0001', 10.005, 20.001, 'nudity', 0.9),
    rng('redge0002', 15, 25, 'gore', 0.8),
    rng('redge0003', 25, 30, 'sex', 0.7, { action: 'hide' }),
    rng('redge0004', 28, 40, 'language', 0.9, { action: 'mute' }),
    rng('redge0005', 50, 52, 'language', 0.9, { action: 'mute' }),
    rng('redge0006', 49, 60, 'kissing', 0.6, { action: 'blur' }),
    rng('redge0007', 70, 75, 'nudity', 0.9, { review: 'rejected' }),
    rng('redge0008', 76, 78, 'nudity', 0.9, { action: 'none' }),
    rng('redge0009', 80.123, 80.127, 'other', 1, { source: 'manual' }),
    rng('redge0010', 95, 100, 'gore', 0.9)
  ];
  return d;
}

var VALID = {
  minimal: minimal,
  full: full,
  'offset-positive': offsetPositive,
  'offset-negative': offsetNegative,
  overlap: overlap,
  reviewed: reviewed,
  'movie-3h': movie3h,
  'future-version': futureVersion,
  'unicode-limits': unicodeLimits,
  'edl-edges': edlEdges
};

/* ----------------------------------------------------------- invalid */

function withRange() {
  var d = baseDoc(20, 'Invalid base', 600);
  d.ranges = [rng('rbad00001', 10, 20, 'nudity', 0.9)];
  return d;
}

function mutate(fn) { var d = withRange(); fn(d); return json(d); }

/* name -> [file text, a JSON Pointer that must appear among the errors] */
var INVALID = {
  'wrong-format': [mutate(function (d) { d.format = 'bonis-oculis-skp'; }), '/format'],
  'wrong-version-string': [mutate(function (d) { d.version = '1'; }), '/version'],
  'wrong-version-zero': [mutate(function (d) { d.version = 0; }), '/version'],
  'end-not-after-start': [mutate(function (d) { d.ranges[0].end = 10; }), '/ranges/0/end'],
  'end-before-start': [mutate(function (d) { d.ranges[0].end = 5; }), '/ranges/0/end'],
  'bad-category': [mutate(function (d) { d.ranges[0].category = 'violence'; }), '/ranges/0/category'],
  'extra-key-range': [mutate(function (d) { d.ranges[0].colour = 'red'; }), '/ranges/0/colour'],
  'bad-range-id': [mutate(function (d) { d.ranges[0].id = 'R-12'; }), '/ranges/0/id'],
  'short-range-id': [mutate(function (d) { d.ranges[0].id = 'r12'; }), '/ranges/0/id'],
  'bad-confidence': [mutate(function (d) { d.ranges[0].confidence = 1.5; }), '/ranges/0/confidence'],
  'missing-media': [mutate(function (d) { delete d.media; }), '/media'],
  'missing-fingerprint': [mutate(function (d) { delete d.media.fingerprint; }), '/media/fingerprint'],
  'bad-oshash': [mutate(function (d) { d.media.fingerprint.oshash = '8E245D9679D31E12'; }), '/media/fingerprint/oshash'],
  'bad-uuid': [mutate(function (d) { d.id = 'not-a-uuid'; }), '/id'],
  'bad-date': [mutate(function (d) { d.created = '2026-02-30T10:00:00Z'; }), '/created'],
  'bad-date-nozone': [mutate(function (d) { d.modified = '2026-10-01T10:00:00'; }), '/modified'],
  'bad-action': [mutate(function (d) { d.ranges[0].action = 'fade'; }), '/ranges/0/action'],
  'bad-intensity': [mutate(function (d) { d.ranges[0].intensity = 2.5; }), '/ranges/0/intensity'],
  'negative-start': [mutate(function (d) { d.ranges[0].start = -1; }), '/ranges/0/start'],
  'bad-language': [mutate(function (d) { d.language = 'es_MX'; }), '/language'],
  'bad-year': [mutate(function (d) { d.media.year = 1879; }), '/media/year'],
  'long-title': [mutate(function (d) { var t = '', i; for (i = 0; i < 501; i++) { t += 'a'; } d.media.title = t; }), '/media/title'],
  'bad-stage': [mutate(function (d) { d.scan = { stages: { ocr: { status: 'done' } } }; }), '/scan/stages/ocr'],
  'stage-missing-status': [mutate(function (d) { d.scan = { stages: { frames: { progress: 0.5 } } }; }), '/scan/stages/frames/status'],
  'bad-level': [mutate(function (d) { d.scan = { levels: { nudity: 'max', other: 'strict' } }; }), '/scan/levels/nudity'],
  'bad-summary-key': [mutate(function (d) { d.summary = { violence: { count: 1 } }; }), '/summary/violence'],
  'bad-summary-entry': [mutate(function (d) { d.summary = { nudity: { count: -1, maxIntensity: 4 } }; }), '/summary/nudity/count'],
  'bad-history-event': [mutate(function (d) { d.history = [{ at: T0, event: 'watched' }]; }), '/history/0/event'],
  'history-too-long': [mutate(function (d) {
    var i; d.history = [];
    for (i = 0; i < 2001; i++) { d.history.push({ at: T0, event: 'edited' }); }
  }), '/history'],
  'bad-signal': [mutate(function (d) { d.ranges[0].signals = { frames: 2, smell: 0.5 }; }), '/ranges/0/signals/smell'],
  'bad-locked': [mutate(function (d) { d.ranges[0].locked = 'yes'; }), '/ranges/0/locked'],
  'bad-scene-cut': [mutate(function (d) { d.media.fingerprint.sceneCuts = [1, -2, 'x']; }), '/media/fingerprint/sceneCuts/1'],
  'ranges-not-array': [mutate(function (d) { d.ranges = {}; }), '/ranges'],
  'future-version-bad-known-key': [mutate(function (d) { d.version = 3; d.extra = 1; d.ranges[0].review = 'maybe'; }), '/ranges/0/review'],
  'missing-everything': ['{}\n', '/format'],
  'tilde-slash-key': [mutate(function (d) { d.media['a/b~c'] = 1; }), '/media/a~1b~0c'],
  'extra-key-media': [mutate(function (d) { d.media.notes = 'media has no notes key'; }), '/media/notes'],
  'bad-history-range-id': [mutate(function (d) { d.history = [{ at: T0, event: 'approved', rangeId: 'R-1' }]; }), '/history/0/rangeId'],
  'truncated': [json(withRange()).slice(0, 200), ''],
  'non-object': ['[1, 2, 3]\n', ''],
  'null': ['null\n', ''],
  'empty': ['', ''],
  'garbage': ['bonis oculis \u0000 not json\n', ''],
  'nan-literal': ['{"format": "bonis-oculis-skip", "version": NaN}\n', '']
};

/* ------------------------------------------------------- fingerprint */

function synthBytes(size, seed) {
  var buf = Buffer.alloc(size), r = new Rng(seed), i;
  for (i = 0; i < size; i++) { buf[i] = r.next() & 255; }
  return buf;
}

var FP_SIZES = [0, 1, 7, 8, 16, 4096, 65535, 65536, 65537, 131071, 131072, 131073, 200003, 1048575, 1048576, 1048579];

function fingerprintCases() {
  var cases = [], i, size, buf, n;
  for (i = 0; i < FP_SIZES.length; i++) {
    size = FP_SIZES[i];
    buf = synthBytes(size, size + 1);
    n = Math.min(size, 65536);
    cases.push({
      size: size,
      seed: size + 1,
      oshash: FP.oshashFromBuffers(size, buf.slice(0, n), buf.slice(size - n)),
      headSha256: crypto.createHash('sha256').update(buf.slice(0, Math.min(size, 1048576))).digest('hex')
    });
  }
  return cases;
}

/* ------------------------------------------------------ differential */

/*
 * Random (seeded) documents full of overlaps, duplicate ids, offsets and
 * locked/rejected mixes, with every function's output, so the Python port
 * is checked far beyond the hand-made fixtures.
 */
function differentialCases(count) {
  var r = new Rng(97531), cases = [], i, a, b, sec;
  function doc() {
    var d = S.newDoc({ id: uuid(99), created: T0, media: {
      title: 'Random', duration: r.int(3) ? 300 + r.int(50) / 4 : 0,
      offset: r.int(2) ? (r.int(400) - 200) / 8 : 0, fingerprint: { size: 1, oshash: '0000000000000000' } } });
    var n = r.int(25), j, s, x;
    for (j = 0; j < n; j++) {
      s = r.int(3500) / (r.int(2) ? 10 : 7);
      x = S.newRange({ id: 'r' + (1000 + r.int(r.int(2) ? 15 : 9000)), start: s, end: s + 0.01 + r.int(600) / (r.int(2) ? 10 : 3),
        category: S.CATEGORIES[r.int(7)], confidence: r.int(101) / 100, action: S.ACTIONS[r.int(5)],
        source: S.SOURCES[r.int(4)], review: S.REVIEWS[r.int(3)] });
      if (r.int(3) === 0) { x.locked = r.int(2) === 0; }
      if (r.int(3) === 0) { x.intensity = 1 + r.int(3); }
      if (r.int(4) === 0) { x.signals = { frames: r.int(101) / 100 }; if (r.int(2)) { x.signals.audio = r.int(101) / 100; } }
      if (r.int(4) === 0) { x.cutStart = x.start; }
      if (r.int(4) === 0) { x.cutEnd = x.end; }
      d.ranges.push(x);
    }
    return d;
  }
  for (i = 0; i < count; i++) {
    a = doc();
    b = doc();
    sec = (r.int(1000) - 500) / 3;
    cases.push({ a: a, b: b, seconds: sec, mediaPath: 'p,=x.mkv', normalised: S.normalise(a, { now: NOW }),
      enforced: S.enforced(a), kodi: S.toKodiEdl(a), mpv: S.toMpvEdl(a, 'p,=x.mkv'),
      merged: S.merge(a, b, { now: NOW }), offset: S.applyOffset(a, sec, { now: NOW }) });
  }
  return cases;
}

/* -------------------------------------------------------------- main */

function main() {
  var manifest = { now: NOW, valid: [], invalid: 'expected/invalid-errors.json', merge: [], offset: [], fingerprint: 'expected/fingerprint.json',
    differential: 'expected/differential.json' };
  var names = Object.keys(VALID), i, name, doc, res, base, mediaPath, invalidErrors = {}, text, parsed, oldDoc, newDoc, merged;

  for (i = 0; i < names.length; i++) {
    name = names[i];
    doc = VALID[name]();
    res = S.validate(doc);
    if (!res.ok) { throw new Error('valid fixture ' + name + ' fails: ' + JSON.stringify(res.errors)); }
    base = 'valid/' + name + '.bonis.json';
    out(base, json(doc));
    mediaPath = doc.media.filename ? '/media/movies/' + doc.media.filename : 'movie.mkv';
    out('expected/' + name + '.edl', S.toKodiEdl(doc));
    out('expected/' + name + '.mpv.edl', S.toMpvEdl(doc, mediaPath));
    out('expected/' + name + '.enforced.json', json(S.enforced(doc)));
    out('expected/' + name + '.normalised.bonis.json', json(S.normalise(doc, { now: NOW })));
    manifest.valid.push({
      fixture: base,
      mediaPath: mediaPath,
      kodi: 'expected/' + name + '.edl',
      mpv: 'expected/' + name + '.mpv.edl',
      enforced: 'expected/' + name + '.enforced.json',
      normalised: 'expected/' + name + '.normalised.bonis.json'
    });
  }

  manifest.offset.push({ fixture: 'valid/minimal.bonis.json', seconds: -2.25, expected: 'expected/minimal.offset.bonis.json' });
  manifest.offset.push({ fixture: 'valid/offset-positive.bonis.json', seconds: 0.1, expected: 'expected/offset-positive.offset.bonis.json' });
  manifest.offset.push({ fixture: 'valid/full.bonis.json', seconds: 3, expected: 'expected/full.offset.bonis.json' });
  for (i = 0; i < manifest.offset.length; i++) {
    doc = VALID[manifest.offset[i].fixture.replace(/^valid\//, '').replace(/\.bonis\.json$/, '')]();
    out(manifest.offset[i].expected, json(S.applyOffset(doc, manifest.offset[i].seconds, { now: NOW })));
  }

  oldDoc = reviewed();
  newDoc = rescan();
  merged = S.merge(oldDoc, newDoc, { now: NOW });
  if (!S.validate(merged).ok) { throw new Error('merge result invalid'); }
  out('merge/old.bonis.json', json(oldDoc));
  out('merge/new.bonis.json', json(newDoc));
  out('merge/expected.bonis.json', json(merged));
  out('merge/expected.edl', S.toKodiEdl(merged));
  manifest.merge.push({ old: 'merge/old.bonis.json', 'new': 'merge/new.bonis.json', expected: 'merge/expected.bonis.json', kodi: 'merge/expected.edl' });

  names = Object.keys(INVALID);
  for (i = 0; i < names.length; i++) {
    name = names[i];
    text = INVALID[name][0];
    out('invalid/' + name + '.json', text);
    parsed = S.fromJson(text);
    if (parsed.ok) { throw new Error('invalid fixture ' + name + ' validates'); }
    if (!parsed.errors.some(function (e) { return e.path === INVALID[name][1]; })) {
      throw new Error('invalid fixture ' + name + ' lacks error at ' + INVALID[name][1] + ': ' + JSON.stringify(parsed.errors));
    }
    invalidErrors['invalid/' + name + '.json'] = { mustInclude: INVALID[name][1], errors: parsed.errors };
  }
  out('expected/invalid-errors.json', json(invalidErrors));
  out('expected/fingerprint.json', json(fingerprintCases()));
  out('expected/differential.json', JSON.stringify(differentialCases(40)) + '\n');
  out('expected/manifest.json', json(manifest));

  if (CHECK) {
    if (mismatched.length) {
      process.stderr.write('fixtures out of date:\n  ' + mismatched.join('\n  ') + '\n');
      process.exit(1);
    }
    process.stdout.write('fixtures up to date (' + written.length + ' files)\n');
  } else {
    process.stdout.write('wrote ' + written.length + ' fixture files\n');
  }
}

main();
