'use strict';
/* Tests for shared/subscan.js. Synthetic, non-explicit fixtures only:
 * spec/fixtures/subtitles/js/ (ours) and spec/fixtures/subtitles/*.srt with
 * expected/<name>.scores.json (the analyzer's, checked when present). */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var sub = require('../subscan.js');
var skipfile = require('../skipfile.js');

var ROOT = path.join(__dirname, '..', '..');
var FIX = path.join(ROOT, 'spec', 'fixtures', 'subtitles');
var JSFIX = path.join(FIX, 'js');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function lexicon(lang) { return JSON.parse(read(path.join(ROOT, 'spec', 'lexicon', lang + '.json'))); }
function times(cues) { return cues.map(function (c) { return [c.start, c.end]; }); }
function folded(cues) { return cues.map(function (c) { return sub.fold(c.text); }); }
function near(a, b) { return Math.abs(a - b) < 1e-9; }

var EN = lexicon('en');
var ES = lexicon('es');

/* ------------------------------------------------------------------ */
/* parsers                                                             */
/* ------------------------------------------------------------------ */

test('parseSrt: BOM, CRLF, tags, entities, missing blank line, dot ms, overlap', function () {
  var cues = sub.parseSrt(read(path.join(JSFIX, 'basic.srt')));
  assert.strictEqual(cues.length, 9);
  assert.deepStrictEqual(cues[0], { start: 1, end: 3.5, text: 'Good evening, everyone.' });
  assert.strictEqual(cues[1].text, '[moaning]');
  assert.deepStrictEqual(cues[2], { start: 11.5, end: 13, text: 'Overlapping line' });
  assert.deepStrictEqual(cues[3], { start: 20, end: 22.25, text: 'I think they will kiss now.' });
  assert.strictEqual(cues[5].text, '<Hello> & goodbye');
  assert.strictEqual(cues[8].text, '- ¿Qué BESO?');
});

test('parseSrt: robust against junk, CR-only, no indices, short times, end <= start', function () {
  assert.deepStrictEqual(sub.parseSrt(''), []);
  assert.deepStrictEqual(sub.parseSrt('just some words\nand more'), []);
  assert.deepStrictEqual(sub.parseSrt(null), []);
  var cues = sub.parseSrt('00:01,5 --> 00:02,25\rHi there\r\r00:00:05,000 --> 00:00:04,000\rBackwards\r');
  assert.deepStrictEqual(times(cues), [[1.5, 2.25], [5, 6]]);
  cues = sub.parseSrt('1\n00:00:02,000 --> 00:00:03,000\n\n\n2\n00:00:01,000 --> 00:00:01,500\nFirst\n');
  assert.deepStrictEqual(cues, [{ start: 1, end: 1.5, text: 'First' }]);
});

test('parseVtt: header, NOTE/STYLE, ids, settings, <v>, inline timestamps', function () {
  var srt = sub.parseSrt(read(path.join(JSFIX, 'basic.srt')));
  var vtt = sub.parseVtt(read(path.join(JSFIX, 'basic.vtt')));
  assert.deepStrictEqual(vtt, srt);
});

test('parseVtt: CRLF, BOM, X-TIMESTAMP-MAP, cue without blank line after header', function () {
  var cues = sub.parseVtt('﻿WEBVTT\r\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nA\r\n\r\n');
  assert.deepStrictEqual(cues.slice(), [{ start: 1, end: 2, text: 'A' }]);
  assert.strictEqual(cues.timestampMap, 'MPEGTS:900000,LOCAL:00:00:00.000');
  cues = sub.parseVtt('WEBVTT\n00:00:03.000 --> 00:00:04.000\nB\n');
  assert.deepStrictEqual(cues, [{ start: 3, end: 4, text: 'B' }]);
});

test('parseTtml: ticks, clock, offset, dur, <br/>, spans, entities', function () {
  var srt = sub.parseSrt(read(path.join(JSFIX, 'basic.srt')));
  var ttml = sub.parseTtml(read(path.join(JSFIX, 'basic.ttml')));
  assert.deepStrictEqual(times(ttml), times(srt));
  assert.deepStrictEqual(folded(ttml), folded(srt));
  assert.strictEqual(ttml[0].text, 'Good evening,\neveryone.');
});

test('parseTtml: frame-based clock and YouTube srv3', function () {
  var c = sub.parseTtml('<tt ttp:frameRate="25"><body><p begin="00:00:01:12" end="00:00:02:00">X</p></body></tt>');
  assert.ok(near(c[0].start, 1.48));
  c = sub.parseTtml('<?xml version="1.0"?><timedtext format="3"><body><p t="1500" d="1000">Y<s>z</s></p></body></timedtext>');
  assert.deepStrictEqual(c, [{ start: 1.5, end: 2.5, text: 'Yz' }]);
});

test('parseJson3: segments joined, empty events dropped, text kept literally', function () {
  var srt = sub.parseSrt(read(path.join(JSFIX, 'basic.srt')));
  var j = sub.parseJson3(read(path.join(JSFIX, 'basic.json3')));
  assert.deepStrictEqual(times(j), times(srt));
  assert.deepStrictEqual(folded(j), folded(srt));
  assert.deepStrictEqual(sub.parseJson3('not json'), []);
});

test('parseAuto sniffs every format', function () {
  assert.strictEqual(sub.parseAuto(read(path.join(JSFIX, 'basic.srt'))).format, 'srt');
  assert.strictEqual(sub.parseAuto(read(path.join(JSFIX, 'basic.vtt'))).format, 'vtt');
  assert.strictEqual(sub.parseAuto(read(path.join(JSFIX, 'basic.ttml'))).format, 'ttml');
  assert.strictEqual(sub.parseAuto(read(path.join(JSFIX, 'basic.json3'))).format, 'json3');
  assert.strictEqual(sub.parseAuto('hello').format, null);
  assert.strictEqual(sub.parseAuto(read(path.join(JSFIX, 'basic.vtt'))).cues.length, 9);
});

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

test('fold follows spec/lexicon/README.md rule 1', function () {
  assert.strictEqual(sub.fold('¿Qué BESO?'), 'que beso');
  assert.strictEqual(sub.fold('  Niño -- respiración  agitada! '), 'nino respiracion agitada');
  assert.strictEqual(sub.fold('[MOANING]'), 'moaning');
});

test('scoreText: SDH segments, word boundaries, stems, once per entry, ignore lines', function () {
  assert.ok(near(sub.scoreText('[moaning]', EN).sex, 0.85));
  assert.deepStrictEqual(sub.scoreText('The moaning wind.', EN), {});
  assert.ok(near(sub.scoreText('They kissed.', EN).kissing, 0.45));
  assert.ok(near(sub.scoreText('kiss kiss kiss', EN).kissing, 0.45));
  assert.deepStrictEqual(sub.scoreText('Sexual tension in class.', EN), {});
  assert.ok(near(sub.scoreText('Oh, crap. Damn it.', EN).language, 1 - (1 - 0.25) * (1 - 0.35)));
  assert.deepStrictEqual(sub.scoreText('♪ Kiss me, kiss me ♪', EN), {});
  assert.ok(near(sub.scoreText('- ¿Qué BESO?', ES).kissing, 0.45));
  assert.deepStrictEqual(sub.scoreText('- ¿Qué BESO?', EN), {});
});

test('score: per-second arrays, cue covers its span, max over overlapping cues', function () {
  var cues = sub.parseSrt(read(path.join(JSFIX, 'basic.srt')));
  var s = sub.score(cues, EN, { round: true });
  assert.deepStrictEqual(Object.keys(s).sort(), ['gore', 'implied', 'kissing', 'language', 'nudity', 'sex']);
  assert.strictEqual(s.sex.length, 57);
  assert.deepStrictEqual(s.sex.slice(9, 13), [0, 0.85, 0.85, 0]);
  assert.deepStrictEqual(s.kissing.slice(19, 24), [0, 0.45, 0.45, 0.45, 0]);
  assert.deepStrictEqual(s.kissing.slice(44, 48), [0, 0.85, 0.85, 0]);
  assert.strictEqual(s.kissing[50], 0);
  assert.strictEqual(s.language[30], 0.513);
  assert.ok(near(sub.score(cues, EN).language[30], 1 - 0.75 * 0.65));
  assert.strictEqual(sub.score(cues, EN, { duration: 100 }).sex.length, 100);
  assert.strictEqual(sub.score(cues, EN, { duration: 20 }).sex.length, 20);
  assert.deepStrictEqual(sub.score([], EN).sex, [0]);
});

test('score: a short cue inside one second covers that second only', function () {
  var s = sub.score([{ start: 3.2, end: 3.7, text: '[kissing]' }], EN, { duration: 6 });
  assert.deepStrictEqual(s.kissing, [0, 0, 0, 0.85, 0, 0]);
});

/* Parity with the analyzer's expected scores (when that agent has written them). */
function expectedArrays(doc) {
  if (!doc || typeof doc !== 'object') { return null; }
  if (doc.perSecond) { return doc.perSecond; }
  if (doc.scores) { return doc.scores; }
  if (doc.categories) { return doc.categories; }
  return doc;
}

test('score parity with spec/fixtures/subtitles/expected/*.scores.json', function (t) {
  var expDir = path.join(FIX, 'expected'), names;
  if (!fs.existsSync(expDir)) { t.skip('no expected scores yet'); return; }
  names = fs.readdirSync(expDir).filter(function (n) { return /\.scores\.json$/.test(n); });
  if (!names.length) { t.skip('no expected scores yet'); return; }
  names.forEach(function (n) {
    var base = n.replace(/\.scores\.json$/, ''), doc = JSON.parse(read(path.join(expDir, n)));
    var srt = path.join(FIX, base + '.srt'), lang, arrays, got, opts = {};
    if (!fs.existsSync(srt)) { return; }
    lang = doc.language || doc.lang || (/(^|[._-])es([._-]|$)/.test(base) ? 'es' : 'en');
    if (typeof doc.duration === 'number') { opts.duration = doc.duration; }
    opts.round = true;
    got = sub.score(sub.parseSrt(read(srt)), sub.langFamily(lang) === 'es' ? ES : EN, opts);
    arrays = expectedArrays(doc);
    sub.CATEGORIES.forEach(function (c) {
      if (!Array.isArray(arrays[c])) { return; }
      assert.strictEqual(got[c].length, arrays[c].length, base + ' ' + c + ' length');
      arrays[c].forEach(function (v, i) {
        assert.ok(Math.abs(got[c][i] - v) <= 0.0011, base + ' ' + c + '[' + i + '] ' + got[c][i] + ' != ' + v);
      });
    });
  });
});

test('guessLanguage and langFamily', function () {
  assert.strictEqual(sub.langFamily('es-MX'), 'es');
  assert.strictEqual(sub.langFamily('eng'), 'en');
  assert.strictEqual(sub.langFamily('fr'), '');
  assert.strictEqual(sub.guessLanguage([{ text: 'Que no es lo que pienso, pero la casa es de ella.' }], 'en'), 'es');
  assert.strictEqual(sub.guessLanguage([{ text: 'What is that thing you are holding?' }], 'es'), 'en');
  assert.strictEqual(sub.guessLanguage([], 'es-MX'), 'es');
});

/* ------------------------------------------------------------------ */
/* ranges                                                              */
/* ------------------------------------------------------------------ */

function arr(n, sets) {
  var a = [], i;
  for (i = 0; i < n; i++) { a.push(0); }
  sets.forEach(function (s) { for (i = s[0]; i < s[1]; i++) { a[i] = s[2]; } });
  return a;
}

test('rangesFromScores: thresholds by level, lead-in 2 s, tail 1 s, peak confidence', function () {
  var per = { sex: arr(60, [[10, 12, 0.85]]), kissing: arr(60, [[20, 23, 0.45]]), gore: arr(60, [[30, 31, 0.65]]) };
  var r = sub.rangesFromScores(per, { sex: 'strict', kissing: 'strict', gore: 'strict' });
  assert.deepStrictEqual(r.map(function (x) { return [x.category, x.start, x.end, x.confidence, x.action, x.intensity]; }), [
    ['sex', 8, 13, 0.85, 'skip', 3], ['kissing', 18, 24, 0.45, 'skip', 1], ['gore', 28, 32, 0.65, 'skip', 2]
  ]);
  r = sub.rangesFromScores(per, { sex: 'light', kissing: 'moderate', gore: 'moderate' });
  assert.deepStrictEqual(r.map(function (x) { return x.category; }), ['sex', 'gore']);
  assert.deepStrictEqual(sub.rangesFromScores(per, { sex: 'off' }), []);
  assert.deepStrictEqual(sub.rangesFromScores(per, {}), []);
});

test('rangesFromScores: gaps under 3 s merge, 3 s does not; clamped to 0 and duration', function () {
  var per = { gore: arr(40, [[1, 2, 0.5], [4, 5, 0.9], [8, 9, 0.5], [38, 40, 0.5]]) };
  var r = sub.rangesFromScores(per, { gore: 'strict' });
  assert.deepStrictEqual(r.map(function (x) { return [x.start, x.end, x.confidence]; }), [[0, 6, 0.9], [6, 10, 0.5], [36, 40, 0.5]]);
  r = sub.rangesFromScores(per, { gore: 'strict' }, { duration: 39.5 });
  assert.strictEqual(r[r.length - 1].end, 39.5);
});

test('rangesFromScores: language mutes with cue timing; minimum 1.5 s; offset; notes', function () {
  var per = { language: arr(40, [[30, 31, 0.6]]), kissing: arr(40, [[5, 6, 0.9]]) };
  var r = sub.rangesFromScores(per, { language: 'strict', kissing: 'strict' }, { offset: -1, lang: 'es' });
  assert.deepStrictEqual(r.map(function (x) { return [x.category, x.start, x.end, x.action]; }), [['kissing', 2, 6, 'skip'], ['language', 28.5, 30.5, 'mute']]);
  assert.strictEqual(r[0].note, 'Los subtítulos sugieren besos intensos.');
  r = sub.rangesFromScores(per, { kissing: 'strict' }, { timing: { defaults: { leadIn: 0, tail: 0 } } });
  assert.deepStrictEqual([r[0].start, r[0].end], [5, 6.5]);
  r = sub.rangesFromScores(per, { kissing: 'strict' }, { actions: { kissing: 'hide' } });
  assert.strictEqual(r[0].action, 'hide');
});

test('rangesFromScores output is a valid skip-file range list', function () {
  var cues = sub.parseSrt(read(path.join(JSFIX, 'basic.srt')));
  var levels = { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'strict' };
  var r = sub.rangesFromScores(sub.score(cues, EN), levels);
  var doc = skipfile.newDoc({ ranges: r, media: { title: 'Test', duration: 60, fingerprint: { size: 1, oshash: '0123456789abcdef' } } }, { now: '2026-10-12T00:00:00Z' });
  var v = skipfile.validate(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.deepStrictEqual(r.map(function (x) { return [x.id, x.category, x.start, x.end, x.action]; }), [
    ['rsub0001', 'sex', 8, 13, 'skip'], ['rsub0002', 'kissing', 18, 24, 'skip'],
    ['rsub0003', 'language', 29.5, 32.5, 'mute'], ['rsub0004', 'kissing', 43, 48, 'skip']
  ]);
});

/* ------------------------------------------------------------------ */
/* sync                                                                */
/* ------------------------------------------------------------------ */

var LINES = [
  'Where did you put the map?', 'It was on the kitchen table.', 'We need to leave before sunset.',
  'Grandpa will meet us at the station.', 'Did anyone feed the dog?', 'I packed sandwiches for everyone.',
  'The train is running late again.', 'Look, the lake is frozen.', 'Can we stop for hot chocolate?',
  'Tell me the story about the lighthouse.', 'Yes.', 'No.', 'Okay.', 'Remember to call your aunt.',
  'This bridge is older than the town.', 'Keep your scarf on, it is cold.'
];

function cuesAt(start, step, lines) {
  return lines.map(function (t, i) { return { start: start + i * step, end: start + i * step + 2, text: t }; });
}

test('syncOffset finds a positive and a negative offset', function () {
  var file = cuesAt(10, 5, LINES);
  assert.strictEqual(sub.syncOffset(sub.shiftCues(file, 2.5), file), 2.5);
  assert.strictEqual(sub.syncOffset(sub.shiftCues(file, -4.2), file), -4.2);
});

test('syncOffset tolerates different wrapping, tags and a few missing lines', function () {
  var file = cuesAt(10, 5, LINES);
  var page = sub.shiftCues(file, 31.04).filter(function (c, i) { return i % 4 !== 1; }).map(function (c, i) {
    return { start: c.start + (i % 2 ? 0.08 : -0.06), end: c.end, text: i % 3 ? c.text.replace(' ', '\n') : '<i>' + c.text.toUpperCase() + '</i>' };
  });
  var off = sub.syncOffset(page, file);
  assert.ok(Math.abs(off - 31.04) < 0.1, String(off));
});

test('syncOffset returns null when confidence is low', function () {
  var file = cuesAt(10, 5, LINES);
  assert.strictEqual(sub.syncOffset([], file), null);
  assert.strictEqual(sub.syncOffset(cuesAt(0, 3, ['Completely', 'different words here', 'nothing in common at all']), file), null);
  assert.strictEqual(sub.syncOffset(sub.shiftCues(file, 3).slice(0, 2), file), null);
  assert.strictEqual(sub.syncOffset(cuesAt(0, 1, ['Yes.', 'No.', 'Okay.', 'Yes.', 'No.']), file), null);
  var d = sub.syncDetail(sub.shiftCues(file, 3), file);
  assert.strictEqual(d.offset, 3);
  assert.ok(d.matches >= 10);
});

test('syncOffset ignores a scattered minority of false matches', function () {
  var file = cuesAt(10, 5, LINES);
  var page = sub.shiftCues(file, 7);
  page.push({ start: 500, end: 501, text: 'Did anyone feed the dog?' });
  page.sort(function (a, b) { return a.start - b.start; });
  assert.strictEqual(sub.syncOffset(page, file), 7);
});
