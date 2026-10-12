'use strict';
var test = require('node:test');
var assert = require('node:assert');
var S = require('../skipfile.js');
var F = require('./fixtures.js');

var NOW = F.manifest.now;

test('Kodi EDL, mpv EDL and enforced() match the expected files byte for byte', function () {
  F.manifest.valid.forEach(function (e) {
    var doc = F.json(e.fixture);
    assert.strictEqual(S.toKodiEdl(doc), F.text(e.kodi), e.kodi);
    assert.strictEqual(S.toMpvEdl(doc, e.mediaPath), F.text(e.mpv), e.mpv);
    assert.strictEqual(JSON.stringify(S.enforced(doc), null, 2) + '\n', F.text(e.enforced), e.enforced);
  });
});

test('Kodi EDL edge cases (hand-checked)', function () {
  var doc = F.json('valid/edl-edges.bonis.json');
  assert.strictEqual(S.toKodiEdl(doc), [
    '10.00 30.00 0',   // 10.005-20.001 rounded outward, joined with 15-25 and touching hide 25-30
    '30.00 40.00 1',   // mute 28-40 minus the cut
    '49.00 60.00 0',   // blur; the mute inside it disappears
    '80.12 80.13 0',   // tiny manual mark rounded outward
    '95.00 100.00 0',  // rejected (70-75) and action none (76-78) are absent
    ''].join('\n'));
  assert.strictEqual(S.toMpvEdl(doc, 'm.mkv'), '# mpv EDL v0\nm.mkv,0.00,10.00\nm.mkv,40.00,9.00\nm.mkv,60.00,20.12\nm.mkv,80.13,14.87\n');
});

test('offsets shift exports and clamp at zero', function () {
  var neg = F.json('valid/offset-negative.bonis.json');
  assert.deepStrictEqual(S.enforced(neg).map(function (r) { return [r.id, r.start, r.end]; }), [
    ['rneg00002', 0, 5], ['rneg00003', 295.33, 305.67], ['rneg00004', 1190, 1195]]);
  assert.strictEqual(S.toKodiEdl(neg), '0.00 5.00 0\n295.33 305.67 0\n1190.00 1195.00 0\n');
  assert.strictEqual(S.toMpvEdl(neg, 'a.mkv'), '# mpv EDL v0\na.mkv,5.00,290.33\na.mkv,305.67,884.33\n');
  var pos = F.json('valid/offset-positive.bonis.json');
  assert.strictEqual(S.toKodiEdl(pos), '12.50 16.50 0\n112.75 142.50 0\n212.50 214.00 1\n3602.50 3612.50 0\n');
});

test('applyOffset sets media.offset, records history and leaves ranges alone', function () {
  F.manifest.offset.forEach(function (o) {
    var doc = F.json(o.fixture), before = JSON.stringify(doc), out = S.applyOffset(doc, o.seconds, { now: NOW });
    assert.deepStrictEqual(out, F.json(o.expected), o.expected);
    assert.strictEqual(JSON.stringify(doc), before);
    assert.strictEqual(out.media.offset, o.seconds);
    assert.deepStrictEqual(out.ranges, doc.ranges);
    assert.ok(S.validate(out).ok);
  });
  var h = F.json('expected/offset-positive.offset.bonis.json').history;
  assert.deepStrictEqual(h[h.length - 1], { at: NOW, event: 'offsetChanged', detail: 'offset 12.5 -> 0.1' });
  assert.throws(function () { S.applyOffset(F.json('valid/minimal.bonis.json'), NaN); }, TypeError);
  assert.throws(function () { S.applyOffset(F.json('valid/minimal.bonis.json'), '2'); }, TypeError);
});

test('mpv EDL quotes paths that contain separators, using the UTF-8 byte length', function () {
  var doc = F.json('valid/minimal.bonis.json');
  assert.strictEqual(S.toMpvEdl(doc, 'C:\\films\\a.mkv'), '# mpv EDL v0\nC:\\films\\a.mkv,0.00\n');
  assert.strictEqual(S.toMpvEdl(doc, 'a,b.mkv'), '# mpv EDL v0\n%7%a,b.mkv,0.00\n');
  assert.strictEqual(S.toMpvEdl(doc, 'ñ=\ud83c\udfac'), '# mpv EDL v0\n%7%ñ=\ud83c\udfac,0.00\n');
  assert.strictEqual(S.toMpvEdl(doc, '#x'), '# mpv EDL v0\n%2%#x,0.00\n');
  assert.strictEqual(S.toMpvEdl(doc, 'x '), '# mpv EDL v0\n%2%x ,0.00\n');
});

test('an empty skip file exports an empty Kodi list and one whole-file mpv segment', function () {
  var doc = F.json('valid/minimal.bonis.json');
  assert.strictEqual(S.toKodiEdl(doc), '');
  assert.strictEqual(S.toMpvEdl(doc, 'movie.mkv'), '# mpv EDL v0\nmovie.mkv,0.00\n');
  assert.deepStrictEqual(S.enforced(doc), []);
});
