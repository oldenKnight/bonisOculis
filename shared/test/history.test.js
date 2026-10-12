'use strict';
var test = require('node:test');
var assert = require('node:assert');
var S = require('../skipfile.js');

test('addHistory appends, omits empty fields and returns the doc', function () {
  var d = S.newDoc({}, { now: '2026-01-01T00:00:00Z' });
  assert.strictEqual(S.addHistory(d, 'approved', 'rabcd1234', '', { now: '2026-01-02T00:00:00Z' }), d);
  S.addHistory(d, 'exported', null, 'kodi', { now: '2026-01-03T00:00:00Z' });
  assert.deepStrictEqual(d.history, [
    { at: '2026-01-01T00:00:00Z', event: 'created' },
    { at: '2026-01-02T00:00:00Z', event: 'approved', rangeId: 'rabcd1234' },
    { at: '2026-01-03T00:00:00Z', event: 'exported', detail: 'kodi' }
  ]);
  assert.ok(S.validate(d).ok);
});

test('addHistory keeps the newest 2000 entries', function () {
  var d = S.newDoc({}, { now: '2026-01-01T00:00:00Z' }), i;
  for (i = 0; i < 2100; i++) { S.addHistory(d, 'edited', 'r' + (10000 + i), null, { now: '2026-01-01T00:00:00Z' }); }
  assert.strictEqual(d.history.length, 2000);
  assert.strictEqual(d.history[0].rangeId, 'r10100');
  assert.strictEqual(d.history[1999].rangeId, 'r12099');
  assert.ok(S.validate(d).ok);
});

test('addHistory cuts detail at 200 code points without splitting a pair', function () {
  var d = S.newDoc(), long = '', i;
  for (i = 0; i < 300; i++) { long += '🎬'; }
  S.addHistory(d, 'edited', null, long);
  assert.strictEqual(d.history[1].detail.length, 400);
  assert.ok(S.validate(d).ok);
});

test('addHistory refuses unknown events', function () {
  assert.throws(function () { S.addHistory(S.newDoc(), 'watched'); }, TypeError);
});
