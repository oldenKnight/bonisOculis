'use strict';
/* Static checks of the extension: manifest, ES5 syntax, shared copies, i18n
 * parity, no network code, adapters' URL handling. node --test, no browser. */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var lint = require('../../../tools/lint-es5.js');
var sync = require('../../tools/sync-shared.js');

var EXT = path.join(__dirname, '..', '..');

function read(p) { return fs.readFileSync(path.join(EXT, p), 'utf8'); }
function json(p) { return JSON.parse(read(p)); }
function walk(dir, out) {
  fs.readdirSync(dir).forEach(function (n) {
    var p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) { walk(p, out); } else { out.push(p); }
  });
  return out;
}
function rel(p) { return path.relative(EXT, p).split(path.sep).join('/'); }

var manifest = json('manifest.json');

test('manifest: MV3, minimal permissions, optional <all_urls>, panic command', function () {
  assert.strictEqual(manifest.manifest_version, 3);
  assert.deepStrictEqual(manifest.permissions.slice().sort(), ['activeTab', 'scripting', 'storage']);
  assert.deepStrictEqual(manifest.optional_host_permissions, ['<all_urls>']);
  manifest.host_permissions.forEach(function (h) {
    assert.ok(/^https:\/\/(www\.|m\.)?(youtube|youtube-nocookie|netflix|primevideo|amazon|disneyplus)\.[a-z.]+\/\*$/.test(h), h);
  });
  assert.strictEqual(manifest.commands.panic.suggested_key.default, 'Alt+Shift+P');
  assert.strictEqual(manifest.background.service_worker, 'background/background.js');
  assert.ok(!manifest.background.type, 'classic service worker, no modules');
  assert.ok(!manifest.web_accessible_resources, 'nothing is exposed to web pages');
  assert.ok(/connect-src 'self'/.test(manifest.content_security_policy.extension_pages));
});

test('manifest: per-site MAIN-world hook + isolated content script, every file exists', function () {
  var cs = manifest.content_scripts, files = [];
  assert.strictEqual(cs.length, 8);
  cs.forEach(function (c, i) {
    if (i % 2 === 0) {
      assert.strictEqual(c.world, 'MAIN');
      assert.deepStrictEqual(c.js, ['inject/hook.js']);
      assert.deepStrictEqual(c.matches, cs[i + 1].matches);
    } else {
      assert.ok(!c.world);
      assert.ok(c.js.indexOf('content/main.js') === c.js.length - 1);
    }
    assert.strictEqual(c.run_at, 'document_start');
    files = files.concat(c.js);
  });
  files = files.concat(['background/background.js', 'popup/popup.html', 'options/options.html']);
  Object.keys(manifest.icons).forEach(function (k) { files.push(manifest.icons[k]); });
  files.forEach(function (f) { assert.ok(fs.existsSync(path.join(EXT, f)), f); });
});

test('all extension JavaScript is ES5', function () {
  walk(EXT, []).filter(function (p) { return /\.js$/.test(p); }).forEach(function (p) {
    assert.deepStrictEqual(lint.scanSource(fs.readFileSync(p, 'utf8')).map(function (h) { return h.line + ':' + h.rule; }), [], rel(p));
  });
});

test('copies of shared files are identical to their sources', function () {
  assert.deepStrictEqual(sync.check(), []);
});

test('locales: en and es_MX have the same keys and placeholders; every used key exists', function () {
  var en = json('_locales/en/messages.json'), es = json('_locales/es_MX/messages.json'), used = {}, k;
  assert.deepStrictEqual(Object.keys(es).sort(), Object.keys(en).sort());
  /* Chrome picks es or es-419 for Spanish UIs, never es_MX: _locales/es is an identical copy. */
  assert.strictEqual(read('_locales/es/messages.json'), read('_locales/es_MX/messages.json'));
  for (k in en) {
    assert.deepStrictEqual(Object.keys(es[k].placeholders || {}).sort(), Object.keys(en[k].placeholders || {}).sort(), k);
    assert.ok(es[k].message.length > 0, k);
  }
  walk(EXT, []).filter(function (p) { return /\.(js|html)$/.test(p) && !/\/test\//.test(p); }).forEach(function (p) {
    var src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''), re = /data-i18n(?:-[a-z-]+)?="([A-Za-z0-9]+)"|\bt\('([A-Za-z0-9]+)'|__MSG_([A-Za-z0-9]+)__/g, m;
    while ((m = re.exec(src)) !== null) { used[m[1] || m[2] || m[3]] = rel(p); }
  });
  src(json('manifest.json'));
  function src(o) { JSON.stringify(o).replace(/__MSG_([A-Za-z0-9]+)__/g, function (x, key) { used[key] = 'manifest'; return x; }); }
  Object.keys(used).forEach(function (key) { assert.ok(en[key], 'missing string ' + key + ' (' + used[key] + ')'); });
});

test('Spanish strings follow the tone rules: no "usted", inverted question marks', function () {
  var es = json('_locales/es_MX/messages.json'), k, m;
  for (k in es) {
    m = es[k].message;
    assert.ok(!/\busted\b/i.test(m), k);
    if (/\?/.test(m)) { assert.ok(/¿/.test(m), k); }
    assert.ok(!/!/.test(m), k + ' has no exclamation marks');
  }
});

test('no network code: only the hook wraps fetch/XHR, only package files are read', function () {
  walk(EXT, []).filter(function (p) { return /\.js$/.test(p) && !/\/test\//.test(p) && !/\/tools\//.test(p); }).forEach(function (p) {
    var r = rel(p), s = fs.readFileSync(p, 'utf8');
    assert.ok(!/\b(WebSocket|EventSource|sendBeacon|RTCPeerConnection)\b/.test(s), r);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'http:\/\/www\.w3\.org\/2000\/svg'/g, '')), r + ' contains a URL');
    if (/\bfetch\(/.test(s)) { assert.ok(['inject/hook.js', 'common/i18n.js'].indexOf(r) >= 0, r + ' uses fetch'); }
    if (/new XMLHttpRequest/.test(s)) { assert.ok(r === 'common/i18n.js', r + ' uses XHR'); }
    assert.ok(!/getImageData|toDataURL|captureStream|drawImage|MediaRecorder|createMediaElementSource/.test(s), r + ' must never read frames or audio');
  });
});

/* Load the adapters in a sandbox to test their pure URL functions. */
function sandbox() {
  var win = { location: { href: 'https://example.org/' }, addEventListener: function () {} };
  var ctx = { window: win, self: win, document: { querySelector: function () { return null; } }, location: win.location, setInterval: function () {}, clearInterval: function () {}, console: console };
  vm.createContext(ctx);
  ['content/core.js', 'content/bridge.js', 'adapters/base.js', 'adapters/youtube.js', 'adapters/netflix.js', 'adapters/primevideo.js', 'adapters/disneyplus.js', 'adapters/generic.js'].forEach(function (f) {
    vm.runInContext(read(f), ctx, { filename: f });
  });
  return win.BO;
}

test('adapters: matching and video ids', function () {
  var BO = sandbox(), A = {};
  BO.adapters.list().forEach(function (a) { A[a.id] = a; });
  assert.strictEqual(BO.adapters.pick('https://www.youtube.com/watch?v=abcDEF12345&t=3').id, 'youtube');
  assert.strictEqual(A.youtube.videoIdFromUrl('https://www.youtube.com/watch?v=abcDEF12345&t=3'), 'abcDEF12345');
  assert.strictEqual(A.youtube.videoIdFromUrl('https://www.youtube.com/shorts/abcDEF12345'), 'abcDEF12345');
  assert.strictEqual(A.youtube.videoIdFromUrl('https://www.youtube-nocookie.com/embed/abcDEF12345?rel=0'), 'abcDEF12345');
  assert.strictEqual(BO.adapters.pick('https://www.netflix.com/watch/80100172?trackId=1').id, 'netflix');
  assert.strictEqual(A.netflix.videoIdFromUrl('https://www.netflix.com/watch/80100172?trackId=1'), '80100172');
  assert.strictEqual(A.netflix.seekMode, 'best-effort');
  assert.strictEqual(A.netflix.isDrm(), true);
  assert.strictEqual(BO.adapters.pick('https://www.primevideo.com/detail/0ABCDEF123/ref=x').id, 'primevideo');
  assert.strictEqual(A.primevideo.videoIdFromUrl('https://www.amazon.com/gp/video/detail/B0ABCDEF12/ref=atv'), 'B0ABCDEF12');
  assert.strictEqual(A.primevideo.videoIdFromUrl('https://www.amazon.com.mx/Some-Title/dp/B0ABCDEF12'), 'B0ABCDEF12');
  assert.strictEqual(BO.adapters.pick('https://www.disneyplus.com/video/1234abcd-12ab-34cd-56ef-1234567890ab').id, 'disneyplus');
  assert.strictEqual(A.disneyplus.videoIdFromUrl('https://www.disneyplus.com/play/1234abcd-12ab'), '1234abcd-12ab');
  assert.strictEqual(A.disneyplus.rolling, true);
  assert.strictEqual(BO.adapters.pick('https://video.example.org/films/42').id, 'generic');
  assert.strictEqual(BO.adapters.pick('chrome://settings'), null);
  assert.ok(/^g[0-9a-f]{8}$/.test(A.generic.videoIdFromUrl('https://video.example.org/films/42')));
});

test('bridge: segmented tracks share a key; YouTube tracks are per language', function () {
  var BO = sandbox();
  assert.strictEqual(BO.bridge.trackKey('https://cdn.example/sub/en/seg_00012.vtt?tok=1'), BO.bridge.trackKey('https://cdn.example/sub/en/seg_00013.vtt?tok=2'));
  assert.notStrictEqual(BO.bridge.trackKey('https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3'), BO.bridge.trackKey('https://www.youtube.com/api/timedtext?v=x&lang=es&fmt=json3'));
  assert.strictEqual(BO.bridge.langFromUrl('https://www.youtube.com/api/timedtext?v=x&lang=es-419'), 'es-419');
});
