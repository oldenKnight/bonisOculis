'use strict';
var test = require('node:test');
var assert = require('node:assert');
var S = require('../skipfile.js');
var F = require('./fixtures.js');

function checkShape(res, label) {
  assert.strictEqual(typeof res.ok, 'boolean', label);
  assert.ok(Array.isArray(res.errors), label);
  if (res.ok) {
    assert.strictEqual(res.errors.length, 0, label);
    assert.ok(S.validate(res.doc).ok, label);
    // whatever validates must survive every other function
    S.normalise(res.doc);
    S.toKodiEdl(res.doc);
    S.toMpvEdl(res.doc, 'x.mkv');
  } else {
    assert.strictEqual(res.doc, null, label);
    assert.ok(res.errors.length > 0, label);
    res.errors.forEach(function (e) { assert.strictEqual(typeof e.path, 'string', label); assert.strictEqual(typeof e.msg, 'string', label); });
  }
}

var CHARS = '{}[]":,0123456789.-eE tfnul\\abc\u00e9\ud83c\u0000\n';

function mutateText(text, r) {
  var i = r.int(text.length + 1), j, k, op = r.int(7);
  switch (op) {
    case 0: return text.slice(0, i) + text.slice(i + 1);
    case 1: return text.slice(0, i) + CHARS.charAt(r.int(CHARS.length)) + text.slice(i);
    case 2: return text.slice(0, i) + CHARS.charAt(r.int(CHARS.length)) + text.slice(i + 1);
    case 3: return text.slice(0, i);
    case 4: j = r.int(text.length + 1); k = Math.min(i, j); return text.slice(0, k) + text.slice(Math.max(i, j));
    case 5: j = r.int(text.length + 1); return text.slice(0, i) + text.slice(Math.min(i, j), Math.max(i, j)) + text.slice(i);
    default: return text.slice(i) + text.slice(0, i);
  }
}

var VALUES = [null, true, false, 0, -1, 1.5, 1e308, '', 'x', 'nudity', [], {}, [1, 2], { a: 1 }, 'rabcd', -0.0001];

function mutateValue(doc, r) {
  var node = doc, parent = null, key = null, keys, depth = 1 + r.int(5), d;
  for (d = 0; d < depth && node !== null && typeof node === 'object'; d++) {
    keys = Object.keys(node);
    if (!keys.length) { break; }
    parent = node;
    key = keys[r.int(keys.length)];
    node = node[key];
  }
  if (!parent) { return doc; }
  if (r.int(4) === 0) { delete parent[key]; } else { parent[key] = VALUES[r.int(VALUES.length)]; }
  return doc;
}

test('fromJson never throws on 2000 random text mutations of a valid document', function () {
  var base = F.text('valid/full.bonis.json'), r = new F.Rng(4242), i, text = base, accepted = 0;
  for (i = 0; i < 2000; i++) {
    text = r.int(3) === 0 ? base : text;
    text = mutateText(text, r);
    var res = S.fromJson(text);
    checkShape(res, 'mutation ' + i);
    if (res.ok) { accepted++; }
  }
  assert.ok(accepted < 2000);
});

test('fromJson never throws on 2000 random structural mutations', function () {
  var r = new F.Rng(777), i, doc, res, rejected = 0;
  for (i = 0; i < 2000; i++) {
    doc = mutateValue(F.json(i % 2 ? 'valid/full.bonis.json' : 'valid/overlap.bonis.json'), r);
    res = S.fromJson(JSON.stringify(doc));
    checkShape(res, 'structural ' + i);
    if (!res.ok) { rejected++; assert.ok(res.errors[0].path.length > 0 || res.errors[0].msg === 'must be an object'); }
  }
  assert.ok(rejected > 500);
});

test('fromJson rejects garbage and non-string input without throwing', function () {
  var deep = '', i;
  for (i = 0; i < 200000; i++) { deep += '['; }
  [undefined, null, 5, {}, [], Buffer.from('{}'), '', ' ', '\ufeff', 'NaN', '{"a":NaN}', 'Infinity', '[', '{"format":', '\u0000',
    deep, '"\\ud800"', '1e400', '{"__proto__": {"x": 1}}'].forEach(function (input, n) {
    var res = S.fromJson(input);
    checkShape(res, 'garbage ' + n);
    assert.strictEqual(res.ok, false);
  });
});

test('fromJson accepts a leading byte-order mark', function () {
  var res = S.fromJson('\ufeff' + F.text('valid/minimal.bonis.json'));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.doc, F.json('valid/minimal.bonis.json'));
});
