'use strict';
// Locale files: identical key sets, no empty values, placeholders in step, and every literal key
// the code asks for exists (dynamic keys like 'cat.' + name are listed explicitly below).

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var dir = path.join(__dirname, '..', 'locales');
var en = JSON.parse(fs.readFileSync(path.join(dir, 'en-US.json'), 'utf8'));
var es = JSON.parse(fs.readFileSync(path.join(dir, 'es-MX.json'), 'utf8'));

function walk(p, out) {
  fs.readdirSync(p).forEach(function (n) {
    var f = path.join(p, n);
    if (fs.statSync(f).isDirectory()) { walk(f, out); } else if (/\.js$/.test(n)) { out.push(f); }
  });
  return out;
}

test('en-US and es-MX have identical key sets', function () {
  var a = Object.keys(en).sort();
  var b = Object.keys(es).sort();
  assert.deepStrictEqual(a.filter(function (k) { return !(k in es); }), [], 'missing in es-MX');
  assert.deepStrictEqual(b.filter(function (k) { return !(k in en); }), [], 'missing in en-US');
});

test('no empty values, and the same {placeholders} in both languages', function () {
  Object.keys(en).forEach(function (k) {
    assert.ok(typeof en[k] === 'string' && en[k].trim().length > 0, 'empty en ' + k);
    assert.ok(typeof es[k] === 'string' && es[k].trim().length > 0, 'empty es ' + k);
    var pa = (en[k].match(/\{\w+\}/g) || []).sort().join();
    var pb = (es[k].match(/\{\w+\}/g) || []).sort().join();
    assert.strictEqual(pb, pa, 'placeholders differ for ' + k);
  });
});

test('tone: no forbidden words in user-facing English (DESIGN 14.1)', function () {
  Object.keys(en).forEach(function (k) {
    assert.ok(!/\b(Oops|Error|Failed|Invalid|Warning)\b/.test(en[k]), k + ': ' + en[k]);
    assert.ok(en[k].indexOf('!') < 0, 'no exclamation marks: ' + k);
  });
});

test('every literal key used by the renderer and main exists', function () {
  var files = walk(path.join(__dirname, '..', 'renderer', 'js'), []).concat(walk(path.join(__dirname, '..', 'main'), []));
  var missing = [];
  files.forEach(function (f) {
    var src = fs.readFileSync(f, 'utf8');
    var m;
    var reT = /\b(?:BO\.t|BO\.i18n\.t|[^.\w]t)\('([a-zA-Z][\w.-]*\w)'\s*[,)]/g;
    while ((m = reT.exec(src))) { if (!(m[1] in en)) { missing.push(path.basename(f) + ': ' + m[1]); } }
    var reN = /BO\.tn\('([\w.-]*\w)'\s*,/g;
    while ((m = reN.exec(src))) {
      if (!((m[1] + '.one') in en) || !((m[1] + '.other') in en)) { missing.push(path.basename(f) + ': ' + m[1] + '.one/.other'); }
    }
    var reKey = /\bkey: '([\w.-]+)'/g;
    while ((m = reKey.exec(src))) {
      if (!(m[1] in en) && !((m[1] + '.title') in en)) { missing.push(path.basename(f) + ': toast ' + m[1]); }
    }
  });
  assert.deepStrictEqual(missing, []);
});

test('dynamic key families are complete', function () {
  var need = [];
  ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language', 'other'].forEach(function (c) { need.push('cat.' + c); });
  ['off', 'light', 'moderate', 'strict'].forEach(function (l) { need.push('level.' + l, 'level.' + l + '.desc'); });
  ['light', 'moderate', 'strict'].forEach(function (l) { need.push('level.' + l + '.descLanguage'); });
  ['skip', 'hide', 'blur', 'mute', 'none'].forEach(function (a) { need.push('action.' + a + '.desc'); if (a !== 'none') { need.push('action.' + a); } });
  ['subtitles', 'frames', 'audio', 'speech', 'captions', 'starting'].forEach(function (s) { need.push('stage.' + s); });
  ['user', 'player', 'battery'].forEach(function (r) { need.push('drawer.reason.' + r); });
  ['little-kids', 'teens', 'custom'].forEach(function (p) { need.push('preset.' + p, 'preset.' + p + '.desc'); });
  ['protection', 'playback', 'scanning', 'privacy', 'language', 'pin', 'about'].forEach(function (s) { need.push('settings.' + s); });
  ['scanFailed', 'badInput', 'modelMissing', 'fileMissing', 'badOutput', 'skipCorrupt'].forEach(function (a) { need.push('attention.' + a); });
  ['pending', 'approved', 'rejected'].forEach(function (s) { need.push('review.state.' + s); });
  ['json', 'edl', 'clean'].forEach(function (k) { need.push('export.' + k + '.title', 'export.' + k + '.text', 'export.' + k + '.button', 'export.saved.' + k); });
  ['headOnly', 'offsetUnknown'].forEach(function (w) { need.push('import.warning.' + w); });
  ['notVideo', 'notFound'].forEach(function (r) { need.push('add.failed.' + r + '.title', 'add.failed.' + r + '.text'); });
  ['mild', 'moderate', 'strong'].forEach(function (i) { need.push('intensity.' + i); });
  ['notFound', 'fileMissing', 'kidRefused', 'writeFailed', 'invalidSkip', 'badPayload', 'locked', 'internal', 'failed', 'playing', 'rangeNotFound',
    'badEdges', 'nothingToUndo', 'pinNeeded', 'peekFailed', 'noSkip', 'notWritable', 'exportFailed', 'busy', 'notVideo', 'noKeyframes', 'nothingLeft',
    'ffmpegFailed', 'tmpFailed', 'expired', 'dialogFailed', 'noPin', 'pinShape', 'pinExists', 'ipc', 'addFailed', 'unknownSetting', 'badValue'].forEach(function (e) {
    need.push('error.' + e + '.title', 'error.' + e + '.text');
  });
  ['recovered', 'lostFile', 'tampered', 'skipTampered', 'scanAttention', 'scanDoneProtected', 'scanDoneReview'].forEach(function (t) { need.push('toast.' + t + '.title', 'toast.' + t + '.text'); });
  assert.deepStrictEqual(need.filter(function (k) { return !(k in en); }), []);
});
