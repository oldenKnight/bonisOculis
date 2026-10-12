'use strict';
// skips.js operations (autosave with history, undo), library status derivation, and the playback
// document built for mpv (levels, cover instead of skip, kid mode fail-closed rules).

var test = require('node:test');
var assert = require('node:assert');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var lib = require('../main/library.js');
var ps = require('../main/player-service.js');

var ITEM = { id: 'cccccccccccccccc', path: '/m/c.mkv', filename: 'c.mkv', title: 'Gamma', size: 10, oshash: 'cccccccccccccccc', status: 'notScanned', duration: 300 };

function setup(name) {
  var s = h.stack(name);
  s.store.writeEnvelope('library.json', { version: 1, items: [JSON.parse(JSON.stringify(ITEM))] });
  s.library.load();
  var d = BO.newDoc({
    media: { title: 'Gamma', duration: 300, fingerprint: { size: 10, oshash: ITEM.oshash } },
    ranges: [BO.newRange({ id: 'rone00001', start: 10, end: 20, category: 'nudity', source: 'auto', review: 'pending', confidence: 0.9 }),
      BO.newRange({ id: 'rtwo00002', start: 40, end: 50, category: 'kissing', source: 'auto', review: 'pending', confidence: 0.5 })],
    scan: { status: 'complete' }
  });
  s.skips.replace(ITEM.id, d, false);
  return s;
}

test('library status follows the skip file', function () {
  assert.strictEqual(lib.deriveStatus(null).status, 'notScanned');
  var s = setup('skips-status');
  assert.strictEqual(s.library.get(ITEM.id).status, 'needsReview');
  assert.strictEqual(s.library.get(ITEM.id).pending, 2);
  s.skips.approve(ITEM.id, 'all');
  assert.strictEqual(s.library.get(ITEM.id).status, 'protected');
  assert.strictEqual(s.library.get(ITEM.id).enforced, 2);
  assert.deepStrictEqual(lib.titleFromFile('/x/The.Long.Way.Home.2019.1080p.mkv'), { title: 'The Long Way Home', year: 2019 });
});

test('every decision is saved at once with a history entry, and can be undone', function () {
  var s = setup('skips-ops');
  var r = s.skips.reject(ITEM.id, ['rtwo00002']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.canUndo, true);
  var d = s.skips.load(ITEM.id).doc;
  assert.strictEqual(d.ranges[1].review, 'rejected');
  assert.strictEqual(d.ranges[1].locked, true, 'a parent decision survives rescans');
  assert.strictEqual(d.history[d.history.length - 1].event, 'rejected');
  r = s.skips.edit(ITEM.id, 'rone00001', { start: 9.5, category: 'sex', action: 'hide', note: '  A  short   note ' });
  d = r.doc;
  assert.strictEqual(d.ranges[0].start, 9.5);
  assert.strictEqual(d.ranges[0].category, 'sex');
  assert.strictEqual(d.ranges[0].note, 'A short note');
  assert.match(d.history[d.history.length - 1].detail, /start 10 -> 9.5; category nudity -> sex; action skip -> hide; note/);
  assert.strictEqual(s.skips.edit(ITEM.id, 'rone00001', { end: 5 }).error, 'badEdges');
  assert.strictEqual(BO.validate(s.skips.load(ITEM.id).doc).ok, true);
  r = s.skips.undo(ITEM.id);
  assert.strictEqual(r.doc.ranges[0].start, 10);
  assert.strictEqual(r.doc.ranges[0].category, 'nudity');
  r = s.skips.undo(ITEM.id);
  assert.strictEqual(r.doc.ranges[1].review, 'pending');
  assert.strictEqual(s.skips.undo(ITEM.id).error, 'nothingToUndo');
});

test('mark as fully reviewed approves what is pending and completes the scan block', function () {
  var s = h.stack('skips-mark');
  s.store.writeEnvelope('library.json', { version: 1, items: [JSON.parse(JSON.stringify(ITEM))] });
  s.library.load();
  var r = s.skips.addRange(ITEM.id, { start: 5, end: 8, source: 'manual', review: 'pending' }, 'added');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.library.get(ITEM.id).status, 'needsReview');
  r = s.skips.markReviewed(ITEM.id);
  assert.strictEqual(r.doc.scan.status, 'complete');
  assert.strictEqual(r.doc.scan.stages.frames.status, 'skipped');
  assert.strictEqual(r.doc.ranges[0].review, 'approved');
  assert.strictEqual(s.library.get(ITEM.id).status, 'protected');
  assert.ok(r.doc.history.some(function (e) { return e.detail === 'marked fully reviewed by a parent'; }));
});

test('the playback file applies the current levels to unreviewed automatic scenes only', function () {
  var d = BO.newDoc({
    media: { title: 'x', duration: 100, fingerprint: { size: 1, oshash: '0000000000000001' } },
    ranges: [
      BO.newRange({ id: 'rauto0001', start: 1, end: 2, category: 'kissing', source: 'auto', review: 'pending', confidence: 0.5 }),
      BO.newRange({ id: 'rauto0002', start: 3, end: 4, category: 'kissing', source: 'auto', review: 'approved', confidence: 0.5, locked: true }),
      BO.newRange({ id: 'rauto0003', start: 5, end: 6, category: 'language', source: 'auto', review: 'pending', confidence: 0.9 }),
      BO.newRange({ id: 'rmanu0004', start: 7, end: 8, category: 'other', source: 'manual', review: 'pending' })
    ]
  });
  var levels = { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'light', gore: 'strict', language: 'moderate' };
  var p = ps.buildPlaybackDoc(d, { levels: levels, skipScenes: true });
  assert.deepStrictEqual(p.ranges.map(function (r) { return r.action; }), ['none', 'skip', 'mute', 'skip']);
  p = ps.buildPlaybackDoc(d, { levels: levels, skipScenes: false, nonSkipAction: 'hide' });
  assert.deepStrictEqual(p.ranges.map(function (r) { return r.action; }), ['none', 'hide', 'mute', 'hide']);
  assert.strictEqual(BO.validate(p).ok, true);
  assert.strictEqual(d.ranges[0].action, 'skip', 'the library copy is untouched');
});
