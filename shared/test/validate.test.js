'use strict';
var test = require('node:test');
var assert = require('node:assert');
var S = require('../skipfile.js');
var F = require('./fixtures.js');

var invalidExpected = F.json('expected/invalid-errors.json');

function paths(errors) { return errors.map(function (e) { return e.path; }); }

test('every valid fixture validates', function () {
  var files = F.list('valid');
  assert.ok(files.length >= 6, 'at least 6 valid fixtures');
  files.forEach(function (f) {
    var res = S.validate(F.json(f));
    assert.deepStrictEqual(res, { ok: true, errors: [] }, f);
    assert.strictEqual(S.fromJson(F.text(f)).ok, true, f);
  });
});

test('every invalid fixture is rejected with the expected path-bearing errors', function () {
  var files = F.list('invalid');
  assert.ok(files.length >= 10, 'at least 10 invalid fixtures');
  assert.deepStrictEqual(files, Object.keys(invalidExpected).sort(), 'expected/invalid-errors.json covers every fixture');
  files.forEach(function (f) {
    var res = S.fromJson(F.text(f)), exp = invalidExpected[f];
    assert.strictEqual(res.ok, false, f);
    assert.strictEqual(res.doc, null, f);
    assert.ok(res.errors.length > 0, f);
    res.errors.forEach(function (e) {
      assert.strictEqual(typeof e.path, 'string', f);
      assert.ok(typeof e.msg === 'string' && e.msg.length > 0, f);
    });
    assert.ok(paths(res.errors).indexOf(exp.mustInclude) >= 0, f + ' has an error at ' + exp.mustInclude);
    assert.deepStrictEqual(res.errors, exp.errors, f);
  });
});

test('structural invalid fixtures point at the offending key, not the root', function () {
  Object.keys(invalidExpected).forEach(function (f) {
    var exp = invalidExpected[f];
    if (exp.mustInclude !== '') { assert.ok(exp.mustInclude.charAt(0) === '/', f); }
  });
});

test('non-object documents fail at the root', function () {
  [null, 5, 'x', [], true].forEach(function (v) {
    assert.deepStrictEqual(S.validate(v), { ok: false, errors: [{ path: '', msg: 'must be an object' }] });
  });
});

test('date-time format follows RFC 3339', function () {
  var good = ['2026-10-12T10:00:00Z', '2026-10-12t10:00:00z', '2024-02-29T23:59:60.123456+05:30', '2026-10-12T10:00:00-00:00'];
  var bad = ['2026-10-12 10:00:00Z', '2026-10-12T10:00:00', '2025-02-29T10:00:00Z', '2026-13-01T10:00:00Z',
    '2026-10-12T24:00:00Z', '2026-10-12T10:60:00Z', '2026-10-12T10:00:00+24:00', '2026-10-12', '2026-10-12T10:00:00.Z', 20261012];
  good.forEach(function (v) {
    var d = S.newDoc();
    d.created = v;
    assert.ok(S.validate(d).ok, v);
  });
  bad.forEach(function (v) {
    var d = S.newDoc();
    d.created = v;
    assert.deepStrictEqual(paths(S.validate(d).errors), ['/created'], String(v));
  });
});

test('any version >= 1 is accepted with unknown top-level keys, but known and nested keys stay strict', function () {
  var d = F.json('valid/future-version.bonis.json');
  assert.strictEqual(d.version, 2);
  assert.ok(S.validate(d).ok);
  d.ranges[0].extra = 1;
  assert.deepStrictEqual(paths(S.validate(d).errors), ['/ranges/0/extra']);
  d = F.json('valid/minimal.bonis.json');
  d.extra = 1;
  assert.deepStrictEqual(S.validate(d), { ok: true, errors: [] });
  d.version = 1.5;
  assert.deepStrictEqual(S.validate(d).errors, [{ path: '/version', msg: 'must be an integer' }]);
  d.version = 0;
  assert.deepStrictEqual(S.validate(d).errors, [{ path: '/version', msg: 'must be >= 1' }]);
  d.version = '1';
  assert.deepStrictEqual(S.validate(d).errors, [{ path: '/version', msg: 'must be an integer' }]);
});

test('maxLength counts Unicode code points, not UTF-16 units', function () {
  var d = F.json('valid/unicode-limits.bonis.json');
  assert.strictEqual(d.media.title.length, 750);
  assert.ok(S.validate(d).ok);
  d.media.title += '🎬';
  assert.deepStrictEqual(S.validate(d).errors, [{ path: '/media/title', msg: 'must be at most 500 characters' }]);
});

test('every schema rule has a failing case', function () {
  function errs(mut) {
    var d = F.json('valid/full.bonis.json');
    mut(d);
    return S.validate(d).errors;
  }
  assert.deepStrictEqual(errs(function (d) { d.generator = { app: 1 }; }),
    [{ path: '/generator/appVersion', msg: 'is required' }, { path: '/generator/app', msg: 'must be a string' }]);
  assert.deepStrictEqual(errs(function (d) { d.media.fingerprint.size = -1; }), [{ path: '/media/fingerprint/size', msg: 'must be >= 0' }]);
  assert.deepStrictEqual(errs(function (d) { d.media.fingerprint.size = 1.5; }), [{ path: '/media/fingerprint/size', msg: 'must be an integer' }]);
  assert.deepStrictEqual(errs(function (d) { d.media.fingerprint.headSha256 = 'abc'; }),
    [{ path: '/media/fingerprint/headSha256', msg: 'must match ^[0-9a-f]{64}$' }]);
  assert.deepStrictEqual(errs(function (d) { d.media.duration = -0.5; }), [{ path: '/media/duration', msg: 'must be >= 0' }]);
  assert.deepStrictEqual(errs(function (d) { d.media.offset = '1'; }), [{ path: '/media/offset', msg: 'must be a number' }]);
  assert.deepStrictEqual(errs(function (d) { d.media.year = 2201; }), [{ path: '/media/year', msg: 'must be <= 2200' }]);
  assert.deepStrictEqual(errs(function (d) { var s = ''; while (s.length < 1025) { s += 'x'; } d.media.filename = s; }),
    [{ path: '/media/filename', msg: 'must be at most 1024 characters' }]);
  assert.deepStrictEqual(errs(function (d) { var i; d.media.fingerprint.sceneCuts = []; for (i = 0; i < 20001; i++) { d.media.fingerprint.sceneCuts.push(i); } }),
    [{ path: '/media/fingerprint/sceneCuts', msg: 'must have at most 20000 items' }]);
  assert.deepStrictEqual(errs(function (d) { d.ranges[0].source = 'robot'; d.ranges[0].review = 'ok'; }), [
    { path: '/ranges/0/source', msg: 'must be one of: auto, manual, panic, imported' },
    { path: '/ranges/0/review', msg: 'must be one of: pending, approved, rejected' }]);
  assert.deepStrictEqual(errs(function (d) { d.ranges[0].note = new Array(302).join('n'); }), [{ path: '/ranges/0/note', msg: 'must be at most 300 characters' }]);
  assert.deepStrictEqual(errs(function (d) { d.ranges[0].cutStart = -1; d.ranges[0].cutEnd = 'x'; }), [
    { path: '/ranges/0/cutStart', msg: 'must be >= 0' }, { path: '/ranges/0/cutEnd', msg: 'must be a number' }]);
  assert.deepStrictEqual(errs(function (d) { d.ranges[0].intensity = 0; }), [{ path: '/ranges/0/intensity', msg: 'must be >= 1' }]);
  assert.deepStrictEqual(errs(function (d) { delete d.ranges[0].id; delete d.ranges[0].confidence; }), [
    { path: '/ranges/0/id', msg: 'is required' }, { path: '/ranges/0/confidence', msg: 'is required' }]);
  assert.deepStrictEqual(errs(function (d) { d.scan.status = 'done'; d.scan.device = 3; }), [
    { path: '/scan/status', msg: 'must be one of: none, partial, complete' }, { path: '/scan/device', msg: 'must be a string' }]);
  assert.deepStrictEqual(errs(function (d) { d.scan.stages.frames.progress = 1.01; d.scan.stages.frames.resumeAt = -1; d.scan.stages.audio.seconds = -1; }), [
    { path: '/scan/stages/frames/progress', msg: 'must be <= 1' }, { path: '/scan/stages/frames/resumeAt', msg: 'must be >= 0' },
    { path: '/scan/stages/audio/seconds', msg: 'must be >= 0' }]);
  assert.deepStrictEqual(errs(function (d) { d.scan.stages.fusion.status = 'ok'; d.scan.stages.fusion.colour = 1; }), [
    { path: '/scan/stages/fusion/colour', msg: 'is not allowed' }, { path: '/scan/stages/fusion/status', msg: 'must be one of: pending, running, done, skipped, failed' }]);
  assert.deepStrictEqual(errs(function (d) { d.scan.levels.other = 'strict'; }), [{ path: '/scan/levels/other', msg: 'is not allowed' }]);
  assert.deepStrictEqual(errs(function (d) { var i; d.scan.warnings = []; for (i = 0; i < 101; i++) { d.scan.warnings.push('w'); } }),
    [{ path: '/scan/warnings', msg: 'must have at most 100 items' }]);
  assert.deepStrictEqual(errs(function (d) { d.scan.warnings = [new Array(502).join('w'), 7]; }), [
    { path: '/scan/warnings/0', msg: 'must be at most 500 characters' }, { path: '/scan/warnings/1', msg: 'must be a string' }]);
  assert.deepStrictEqual(errs(function (d) { d.summary.gore.maxIntensity = 4; d.summary.gore.seconds = -1; d.summary.gore.x = 1; }), [
    { path: '/summary/gore/x', msg: 'is not allowed' }, { path: '/summary/gore/seconds', msg: 'must be >= 0' },
    { path: '/summary/gore/maxIntensity', msg: 'must be <= 3' }]);
  assert.deepStrictEqual(errs(function (d) { d.history[0] = { event: 'created', rangeId: 5, detail: new Array(202).join('d'), x: 1 }; }), [
    { path: '/history/0/at', msg: 'is required' }, { path: '/history/0/x', msg: 'is not allowed' },
    { path: '/history/0/rangeId', msg: 'must be a string' }, { path: '/history/0/detail', msg: 'must be at most 200 characters' }]);
  assert.deepStrictEqual(errs(function (d) { d.history[1].rangeId = 'rd00011'; d.history[2].rangeId = 'x1234'; }),
    [{ path: '/history/2/rangeId', msg: 'must match ^r[0-9a-z]{4,16}$' }]);
  assert.deepStrictEqual(errs(function (d) { d.ranges[0].start = Infinity; }), [{ path: '/ranges/0/start', msg: 'must be a number' }]);
  assert.deepStrictEqual(errs(function (d) { d.ranges[0].signals.audio = -0.1; }), [{ path: '/ranges/0/signals/audio', msg: 'must be >= 0' }]);
});

test('JSON Pointer paths escape ~ and /', function () {
  var d = F.json('valid/minimal.bonis.json');
  d.media['x/y~z'] = 1;
  assert.deepStrictEqual(S.validate(d).errors, [{ path: '/media/x~1y~0z', msg: 'is not allowed' }]);
});

test('the error list is capped at 100 entries', function () {
  var d = F.json('valid/minimal.bonis.json'), i;
  d.media.fingerprint.sceneCuts = [];
  for (i = 0; i < 500; i++) { d.media.fingerprint.sceneCuts.push(-1); }
  assert.strictEqual(S.validate(d).errors.length, 100);
});

test('newDoc and newRange produce valid structures', function () {
  var d = S.newDoc({ media: { title: 'T', duration: 10, fingerprint: { size: 1, oshash: '0000000000000001' } } }), r, i, ids = {};
  assert.deepStrictEqual(S.validate(d), { ok: true, errors: [] });
  assert.match(d.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.strictEqual(d.created, d.modified);
  assert.deepStrictEqual(d.ranges, []);
  assert.deepStrictEqual(d.history, [{ at: d.created, event: 'created' }]);
  assert.ok(S.validate(S.newDoc()).ok);
  assert.strictEqual(S.newDoc({}, { now: '2026-01-01T00:00:00Z' }).created, '2026-01-01T00:00:00Z');
  for (i = 0; i < 500; i++) {
    r = S.newRange({ start: 1, end: 2, bogus: 1 });
    assert.match(r.id, /^r[0-9a-z]{8}$/);
    assert.ok(!ids[r.id]);
    ids[r.id] = true;
  }
  assert.deepStrictEqual(Object.keys(r), ['id', 'start', 'end', 'category', 'confidence', 'action', 'source', 'review']);
  d.ranges.push(r);
  d.ranges.push(S.newRange({ start: 3, end: 4, category: 'gore', confidence: 0.5, source: 'auto', intensity: 2, note: 'n', locked: true }));
  assert.ok(S.validate(d).ok);
});
