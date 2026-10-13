'use strict';
// help.js: the Markdown subset is escaped, anchors stay inside the help, both languages have every topic.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var help = require('../main/help.js');

test('markdown subset renders and escapes', function () {
  var r = help.render('# T\n\n## Watch on TV {#tv}\n\nUse **VLC** and `exFAT`. <script>x</script>\n\n- a\n- b [see](#tv) [web](https://example.com)\n\n1. one\n2. two\n\n> note\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.ok(r.html.indexOf('<h2 id="tv" tabindex="-1">Watch on TV</h2>') >= 0);
  assert.strictEqual(r.title, 'T', 'the level-1 heading is the page title, not part of the body');
  assert.ok(r.html.indexOf('<strong>VLC</strong>') >= 0);
  assert.ok(r.html.indexOf('<code>exFAT</code>') >= 0);
  assert.ok(r.html.indexOf('&lt;script&gt;') >= 0 && r.html.indexOf('<script>') < 0);
  assert.ok(r.html.indexOf('<a href="#tv" data-help-anchor="tv">see</a>') >= 0);
  assert.ok(r.html.indexOf('https://') < 0, 'external links become plain text');
  assert.ok(/<ol class="bo-help__list"><li>one<\/li><li>two<\/li><\/ol>/.test(r.html));
  assert.ok(r.html.indexOf('<div class="bo-notice"><p>note</p></div>') >= 0);
  assert.ok(r.html.indexOf('<th scope="col">a</th>') >= 0 && r.html.indexOf('<td>2</td>') >= 0);
  assert.deepStrictEqual(r.toc, [{ id: 'tv', text: 'Watch on TV', level: 2 }]);
});

test('both help files cover every required topic with the same anchors', function () {
  var dir = path.join(__dirname, '..', '..', 'docs', 'HELP');
  var need = ['requirements', 'install', 'start', 'scanning', 'review', 'kids', 'panic', 'tv', 'limits', 'pin', 'privacy', 'accuracy'];
  ['en-US.md', 'es-MX.md'].forEach(function (f) {
    var r = help.render(fs.readFileSync(path.join(dir, f), 'utf8'));
    var ids = r.toc.filter(function (e) { return e.level === 2; }).map(function (e) { return e.id; });
    assert.deepStrictEqual(ids, need, f);
  });
  var en = fs.readFileSync(path.join(dir, 'en-US.md'), 'utf8');
  ['Privacy & Security', 'Open Anyway', 'SmartScreen', 'More info', 'Run anyway', 'VLC', 'Amazon Appstore', 'Kodi', '.edl', 'DRM', 'administrator',
    '7 times', 'Install unknown apps', 'Downloader', 'ARMV7A (32BIT)', 'exFAT', 'FAT32', 'internal storage', 'real frame'].forEach(function (w) {
    assert.ok(en.indexOf(w) >= 0, w);
  });
  assert.ok(en.indexOf('(F1)') < 0, 'no jargon');
  assert.ok(en.indexOf('None found \u2713') < 0 && en.indexOf('None found ✓') < 0);
  var es = fs.readFileSync(path.join(dir, 'es-MX.md'), 'utf8');
  ['Privacidad y seguridad', 'Abrir de todos modos', 'Más información', 'Ejecutar de todas formas', '7 veces', 'Instalar apps desconocidas', 'ARMV7A (32BIT)', 'imagen real'].forEach(function (w) {
    assert.ok(es.indexOf(w) >= 0, w);
  });
});

test('install files outside the app carry the same first-launch steps', function () {
  var inst = path.join(__dirname, '..', '..', 'docs', 'INSTALL');
  var en = fs.readFileSync(path.join(inst, 'en-US.md'), 'utf8');
  var es = fs.readFileSync(path.join(inst, 'es-MX.md'), 'utf8');
  ['Privacy & Security', 'Open Anyway', 'More info', 'Run anyway', 'FIRST-LAUNCH'].forEach(function (w) { assert.ok(en.indexOf(w) >= 0, w); });
  ['Privacidad y seguridad', 'Abrir de todos modos', 'Más información', 'Ejecutar de todas formas', 'PRIMER-INICIO'].forEach(function (w) { assert.ok(es.indexOf(w) >= 0, w); });
});
