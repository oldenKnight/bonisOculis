'use strict';
// Scene notes in the UI language (board P9): every category and signal combination gives a
// sentence in both languages; the port equals analyzer/bonis_analyzer/notes.py; a stored template
// note is re-rendered in the UI language, a parent's own note is kept.

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var childProcess = require('child_process');
var notes = require('../renderer/js/notes.js');

var CATS = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language', 'other'];
var SIGS = ['frames', 'subtitles', 'speech', 'audio', 'captions'];

function subsets() {
  var out = [];
  var n;
  for (n = 0; n < (1 << SIGS.length); n++) {
    out.push(SIGS.filter(function (s, i) { return n & (1 << i); }));
  }
  return out;
}

test('every category and signal combination gives a sentence in English and Spanish', function () {
  CATS.forEach(function (c) {
    subsets().forEach(function (sig) {
      var en = notes.note(c, sig, 'en-US');
      var es = notes.note(c, sig, 'es-MX');
      [en, es].forEach(function (t) {
        assert.match(t, /^[A-ZÁÉÍÓÚÑ][^\n]{5,140}[.)]\.?$/, c + ' ' + sig.join('+') + ': ' + t);
        assert.ok(t.indexOf('{') < 0 && t.indexOf('undefined') < 0, t);
      });
      assert.notStrictEqual(en, es, 'two languages: ' + en);
    });
  });
});

test('a template note follows the UI language; a parent\'s note and manual marks stay as written', function () {
  var r = { category: 'kissing', source: 'auto', signals: { frames: 0.6, subtitles: 0.5, audio: 0.1 }, note: 'Posibles besos intensos. Se ve en la imagen y el diálogo lo confirma.' };
  assert.strictEqual(notes.text(r, 'en-US'), 'Possible heavy kissing. Seen in the picture; the dialogue agrees.');
  assert.strictEqual(notes.text(r, 'es-MX'), r.note);
  r.note = 'Kiss at the door, fine for us';
  assert.strictEqual(notes.text(r, 'es-MX'), 'Kiss at the door, fine for us', 'edited by a parent');
  assert.strictEqual(notes.text({ category: 'other', source: 'panic', note: 'Ocultada con la tecla de pánico.' }, 'en-US'), 'Ocultada con la tecla de pánico.');
  assert.strictEqual(notes.text({ category: 'gore', source: 'auto', signals: {} }, 'en-US'), 'Possible graphic violence or blood. Weak signals; worth a check.');
});

var py = childProcess.spawnSync('python3', ['-c', 'import bonis_analyzer.notes'], { cwd: path.join(__dirname, '..', '..', 'analyzer') });
test('the port gives exactly what notes.py gives', { skip: py.status === 0 ? false : 'Python analyzer not importable' }, function () {
  var cases = [];
  CATS.forEach(function (c) { subsets().forEach(function (sig) { ['en-US', 'es-MX'].forEach(function (l) { cases.push([c, sig, l]); }); }); });
  var r = childProcess.spawnSync('python3', ['-c', 'import json,sys\nfrom bonis_analyzer import notes\nprint(json.dumps([notes.note(c, s, l) for c, s, l in json.load(sys.stdin)]))'],
    { cwd: path.join(__dirname, '..', '..', 'analyzer'), input: JSON.stringify(cases), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  var want = JSON.parse(r.stdout);
  cases.forEach(function (cs, i) { assert.strictEqual(notes.note(cs[0], cs[1], cs[2]), want[i], cs.join(' ')); });
});
