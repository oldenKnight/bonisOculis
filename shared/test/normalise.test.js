'use strict';
var test = require('node:test');
var assert = require('node:assert');
var S = require('../skipfile.js');
var F = require('./fixtures.js');

var NOW = F.manifest.now;

function brief(doc) {
  return doc.ranges.map(function (r) { return [r.id, r.start, r.end, r.category, r.action, r.review]; });
}

test('normalise matches the expected file for every valid fixture', function () {
  F.manifest.valid.forEach(function (e) {
    var doc = F.json(e.fixture), before = JSON.stringify(doc), out = S.normalise(doc, { now: NOW });
    assert.deepStrictEqual(out, F.json(e.normalised), e.fixture);
    assert.strictEqual(JSON.stringify(doc), before, e.fixture + ' input untouched');
    assert.ok(S.validate(out).ok, e.fixture + ' output valid');
  });
});

test('normalise resolves the overlap fixture as hand-computed', function () {
  var out = S.normalise(F.json('valid/overlap.bonis.json'), { now: NOW });
  assert.deepStrictEqual(brief(out), [
    ['ru0001', 20, 30, 'implied', 'skip', 'pending'],
    ['ru00011', 25, 26, 'implied', 'skip', 'rejected'],   // duplicate id re-derived, rejected kept as is
    ['rl0001', 50, 50.5, 'other', 'none', 'pending'],     // action none: not enforced, untouched
    ['rb0001', 100, 120, 'nudity', 'skip', 'pending'],    // ra0001 + rb0001 merged (same category)
    ['rc0001', 120, 130, 'gore', 'skip', 'pending'],      // trimmed by the higher-confidence nudity
    ['rd0001', 200, 210, 'language', 'mute', 'pending'],  // mute split around a visual range
    ['re0001', 210, 215, 'sex', 'skip', 'pending'],       // visual beats mute despite lower confidence
    ['rd00011', 215, 230, 'language', 'mute', 'pending'],
    ['rf0001', 300, 310, 'kissing', 'skip', 'approved'],  // locked: never merged or trimmed
    ['rg0001', 310, 320, 'kissing', 'skip', 'pending'],
    ['rh0001', 400, 410, 'implied', 'skip', 'rejected'],
    ['ri0001', 402, 408, 'implied', 'skip', 'pending'],   // overlap with a rejected range is fine
    ['rp0001', 450, 460, 'gore', 'skip', 'pending'],      // split around a contained nudity range
    ['rq0001', 460, 465, 'nudity', 'skip', 'pending'],
    ['rp00011', 465, 480, 'gore', 'skip', 'pending'],
    ['rn0001', 500, 506, 'sex', 'hide', 'pending'],       // merged: strongest action, max confidence
    ['rs0001', 550, 570, 'gore', 'skip', 'pending'],      // approved + pending merged -> pending
    ['rj0001', 590, 600, 'nudity', 'skip', 'pending']     // clamped to duration; rk0001 dropped
  ]);
  var rn = out.ranges[15], rb = out.ranges[3], rc = out.ranges[4];
  assert.strictEqual(rn.confidence, 0.95);
  assert.strictEqual(rn.intensity, 3);
  assert.deepStrictEqual(rn.signals, { frames: 0.6, subtitles: 0.7, audio: 0.9 });
  assert.strictEqual(rb.cutStart, 100);
  assert.strictEqual(rb.intensity, 2);
  assert.strictEqual(rb.confidence, 0.9);
  assert.strictEqual(rc.cutStart, undefined);
  assert.strictEqual(rc.cutEnd, 130);
  assert.strictEqual(out.modified, NOW);
  assert.deepStrictEqual(out.summary.gore, { count: 4, seconds: 55, maxIntensity: 0 });
  assert.deepStrictEqual(out.summary.implied, { count: 2, seconds: 16, maxIntensity: 0 });
  assert.deepStrictEqual(Object.keys(out.summary), S.CATEGORIES);
  // rl0001 (action none) and the rejected ranges are not counted
  assert.deepStrictEqual(out.summary.other, { count: 0, seconds: 0, maxIntensity: 0 });
});

test('normalise is idempotent apart from modified', function () {
  F.manifest.valid.forEach(function (e) {
    var once = S.normalise(F.json(e.fixture), { now: NOW });
    assert.deepStrictEqual(S.normalise(once, { now: NOW }), once, e.fixture);
  });
});

test('after normalise, enforced ranges only overlap where a locked range is involved', function () {
  F.manifest.valid.forEach(function (e) {
    var out = S.normalise(F.json(e.fixture), { now: NOW }), en = out.ranges.filter(S.isEnforced), i, j;
    for (i = 0; i < en.length; i++) {
      assert.ok(en[i].end > en[i].start);
      if (i) { assert.ok(out.ranges.indexOf(en[i - 1]) < out.ranges.indexOf(en[i])); }
      for (j = i + 1; j < en.length; j++) {
        if (en[j].start < en[i].end && en[i].start < en[j].end) {
          assert.ok(en[i].locked === true || en[j].locked === true, e.fixture + ' ' + en[i].id + '/' + en[j].id);
        }
      }
    }
  });
});

test('normalise sorts by start, clamps to [0, duration] and ignores the upper clamp for duration 0', function () {
  var d = S.newDoc({ media: { title: 't', duration: 0, fingerprint: { size: 0, oshash: '0000000000000000' } } });
  d.ranges = [S.newRange({ id: 'raaaa', start: 1e6, end: 9e9, category: 'gore' }), S.newRange({ id: 'rbbbb', start: 50, end: 60 })];
  assert.deepStrictEqual(brief(S.normalise(d)), [['rbbbb', 50, 60, 'other', 'skip', 'pending'], ['raaaa', 1e6, 9e9, 'gore', 'skip', 'pending']]);
  d.media.duration = 55;
  assert.deepStrictEqual(brief(S.normalise(d)), [['rbbbb', 50, 55, 'other', 'skip', 'pending']]);
});

test('normalise never lets a mute range weaken visual protection', function () {
  var d = S.newDoc({ media: { title: 't', duration: 100, fingerprint: { size: 0, oshash: '0000000000000000' } } });
  d.ranges = [
    S.newRange({ id: 'rmute', start: 10, end: 20, category: 'language', action: 'mute', confidence: 1, locked: true }),
    S.newRange({ id: 'rnude', start: 12, end: 18, category: 'nudity', confidence: 0.41, source: 'auto' })
  ];
  var out = S.normalise(d);
  assert.deepStrictEqual(brief(out), [['rmute', 10, 20, 'language', 'mute', 'pending'], ['rnude', 12, 18, 'nudity', 'skip', 'pending']]);
});

test('seeded random documents reproduce expected/differential.json (also checked by Python)', function () {
  var cases = F.json(F.manifest.differential);
  assert.strictEqual(cases.length, 40);
  cases.forEach(function (c, i) {
    assert.deepStrictEqual(S.normalise(c.a, { now: NOW }), c.normalised, 'normalise ' + i);
    assert.deepStrictEqual(S.enforced(c.a), c.enforced, 'enforced ' + i);
    assert.strictEqual(S.toKodiEdl(c.a), c.kodi, 'kodi ' + i);
    assert.strictEqual(S.toMpvEdl(c.a, c.mediaPath), c.mpv, 'mpv ' + i);
    assert.deepStrictEqual(S.merge(c.a, c.b, { now: NOW }), c.merged, 'merge ' + i);
    assert.deepStrictEqual(S.applyOffset(c.a, c.seconds, { now: NOW }), c.offset, 'offset ' + i);
    assert.ok(S.validate(c.normalised).ok && S.validate(c.merged).ok, 'valid ' + i);
  });
});
