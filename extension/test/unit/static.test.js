'use strict';
/* Static checks of the extension: manifest, ES5 syntax, shared copies, i18n
 * parity, no network code, adapters' URL handling. node --test, no browser. */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');
var lint = require('../../../tools/lint-es5.js');
var sync = require('../../tools/sync-shared.js');
var vendor = require('../../../tools/fetch-vendor.js');

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
/* Third-party files copied verbatim (onnxruntime-web) are exempt from our style checks. */
function ours(p) { return !/(^|\/)vendor\//.test(rel(p)); }

var manifest = json('manifest.json');

test('manifest: MV3, minimal permissions, optional <all_urls>, panic command', function () {
  var csp = manifest.content_security_policy.extension_pages;
  assert.strictEqual(manifest.manifest_version, 3);
  /* tabCapture + offscreen: live listening (M8), started only by the user from the popup */
  assert.deepStrictEqual(manifest.permissions.slice().sort(), ['activeTab', 'offscreen', 'scripting', 'storage', 'tabCapture']);
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, 'tabCapture.getMediaStreamId in the service worker needs Chrome 116');
  assert.deepStrictEqual(manifest.optional_host_permissions, ['<all_urls>']);
  manifest.host_permissions.forEach(function (h) {
    assert.ok(/^https:\/\/(www\.|m\.)?(youtube|youtube-nocookie|netflix|primevideo|amazon|disneyplus)\.[a-z.]+\/\*$/.test(h), h);
  });
  assert.strictEqual(manifest.commands.panic.suggested_key.default, 'Alt+Shift+P');
  assert.strictEqual(manifest.background.service_worker, 'background/background.js');
  assert.ok(!manifest.background.type, 'classic service worker, no modules');
  assert.ok(!manifest.web_accessible_resources, 'nothing is exposed to web pages');
  assert.ok(/connect-src 'self';/.test(csp));
  /* WebAssembly for onnxruntime-web, nothing else: no eval, no remote script, no remote media */
  assert.ok(/(^|; )script-src 'self' 'wasm-unsafe-eval';/.test(csp), csp);
  assert.ok(!/'unsafe-eval'|'unsafe-inline'|https?:|\*/.test(csp), csp);
  assert.ok(/media-src 'self' blob:;/.test(csp), csp);
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
  files = files.concat(['background/background.js', 'popup/popup.html', 'options/options.html', 'offscreen/offscreen.html', 'offscreen/offscreen.js',
    'audio/classmap.js', 'audio/live.js', 'audio/capture-worklet.js', 'models/yamnet.onnx', 'vendor/ort.wasm.min.js']);
  Object.keys(manifest.icons).forEach(function (k) { files.push(manifest.icons[k]); });
  files.forEach(function (f) { assert.ok(fs.existsSync(path.join(EXT, f)), f); });
});

test('all extension JavaScript is ES5 (vendored files excepted)', function () {
  walk(EXT, []).filter(function (p) { return /\.js$/.test(p) && ours(p); }).forEach(function (p) {
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
  walk(EXT, []).filter(function (p) { return /\.js$/.test(p) && !/\/test\//.test(p) && !/\/tools\//.test(p) && ours(p); }).forEach(function (p) {
    var r = rel(p), s = fs.readFileSync(p, 'utf8');
    assert.ok(!/\b(WebSocket|EventSource|sendBeacon|RTCPeerConnection)\b/.test(s), r);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/'http:\/\/www\.w3\.org\/2000\/svg'/g, '')), r + ' contains a URL');
    if (/\bfetch\(/.test(s)) { assert.ok(['inject/hook.js', 'common/i18n.js'].indexOf(r) >= 0, r + ' uses fetch'); }
    if (/new XMLHttpRequest/.test(s)) { assert.ok(r === 'common/i18n.js', r + ' uses XHR'); }
    assert.ok(!/getImageData|toDataURL|captureStream|drawImage|MediaRecorder|getDisplayMedia|<canvas|createElement\('canvas'\)/.test(s), r + ' must never read frames or record');
    /* Live listening: only the offscreen document hears sound (the tab it was given, or a test file). */
    if (r !== 'offscreen/offscreen.js') {
      assert.ok(!/getUserMedia|createMediaStreamSource|createMediaElementSource|AudioContext/.test(s), r + ' must never read audio');
    }
  });
});

test('live listening: the offscreen document keeps sound in memory only and needs a user gesture to start', function () {
  var off = read('offscreen/offscreen.js'), bg = read('background/background.js'), popup = read('popup/popup.js');
  assert.ok(!/chrome\.storage|indexedDB|localStorage|caches\.|fetch\(|XMLHttpRequest|sendBeacon/.test(off), 'offscreen stores and sends nothing');
  assert.ok(/chromeMediaSource: 'tab'/.test(off));
  /* the tab capture starts only from the popup's switch (the user's click) */
  assert.ok(/getMediaStreamId\(\{ targetTabId: tabId \}/.test(bg));
  assert.ok(/case 'liveStart':/.test(bg) && /t: on \? 'liveStop' : 'liveStart'/.test(popup));
  assert.ok(/reasons: \['USER_MEDIA'\]/.test(bg));
  /* the test-only paths are gated on the test build and a local URL */
  assert.ok(/function isTestBuild/.test(off) && /function isTestBuild/.test(bg));
  assert.ok(/\^http:\\\/\\\/\(127\\\.0\\\.0\\\.1\|localhost\)/.test(off), 'test files only from 127.0.0.1');
});

test('vendored files match the sha256 pinned in tools/fetch-vendor.js; nothing else in vendor/', function () {
  var listed = vendor.FILES.map(function (f) { return f.dest.replace(/^extension\//, ''); }), present;
  vendor.FILES.forEach(function (f) {
    var file = path.join(EXT, f.dest.replace(/^extension\//, ''));
    assert.ok(fs.existsSync(file), f.dest);
    assert.strictEqual(fs.statSync(file).size, f.size, f.dest);
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), f.sha256, f.dest);
  });
  present = walk(path.join(EXT, 'vendor'), []).concat(walk(path.join(EXT, 'models'), [])).map(rel).sort();
  assert.deepStrictEqual(present, listed.slice().sort());
  assert.ok(lint.isVendor('/x/extension/vendor/ort.wasm.min.js'));
  assert.ok(!lint.isVendor('/x/extension/audio/live.js'));
});

/* Load the adapters in a sandbox to test their pure URL functions. */
function sandbox() {
  var win = { location: { href: 'https://example.org/' }, addEventListener: function () {} };
  var ctx = { window: win, self: win, document: { querySelector: function () { return null; } }, location: win.location, setInterval: function () {}, clearInterval: function () {}, console: console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'shared', 'subscan.js'), 'utf8'), ctx, { filename: 'shared/subscan.js' });
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

test('bridge: HLS WebVTT X-TIMESTAMP-MAP shifts each segment onto the video timeline (Disney+)', function () {
  var BO = sandbox(), url = 'https://cdn.example/sub/en/seg_%.vtt', segA, segB, keyed, t;
  segA = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.500\n[door opens]\n';
  segB = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:1440000\n\n00:00:00.500 --> 00:00:01.500\nHello there.\n';
  function add(text, n) {
    var parsed = BO.subscan.parseAuto(text, 'x.vtt');
    return BO.bridge.addTrack({ url: url.replace('%', n), format: parsed.format, cues: parsed.cues, timestampMap: parsed.cues.timestampMap || null });
  }
  function times(track) { return JSON.parse(JSON.stringify(track.cues.map(function (c) { return [c.start, c.end, c.text]; }))); }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(BO.bridge.parseTimestampMap('MPEGTS:900000,LOCAL:00:00:10.500'))), { mpegts: 10, local: 10.5 });
  assert.strictEqual(BO.bridge.parseTimestampMap('LOCAL:00:00:00.000'), null);
  /* segment 2 arrives first (playback started mid-title), then segment 1: the track re-bases */
  add(segB, 2);
  t = add(segA, 1);
  assert.deepStrictEqual(times(t), [[1, 2.5, '[door opens]'], [6.5, 7.5, 'Hello there.']]);
  /* the same segments in order give the same track; repeats are not duplicated */
  BO = sandbox();
  add(segA, 1);
  add(segB, 2);
  t = add(segB, 2);
  assert.deepStrictEqual(times(t), [[1, 2.5, '[door opens]'], [6.5, 7.5, 'Hello there.']]);
  /* a constant map with LOCAL = 10 s: cue times are absolute and move back by LOCAL */
  BO = sandbox();
  keyed = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:10.000\n\n00:00:12.000 --> 00:00:13.000\nOne.\n\n00:00:20.000 --> 00:00:21.000\nTwo.\n';
  t = add(keyed, 7);
  assert.deepStrictEqual(times(t), [[2, 3, 'One.'], [10, 11, 'Two.']]);
  /* segments without a map are untouched */
  BO = sandbox();
  t = add('WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nPlain.\n', 3);
  assert.deepStrictEqual(times(t), [[5, 6, 'Plain.']]);
});

test('levels: fresh default is the Little kids preset (language strict, muted), as on the desktop; presets match the desktop app', function () {
  var ctx = { self: {} }, store, desk = fs.readFileSync(path.join(EXT, '..', 'desktop', 'main', 'settings.js'), 'utf8');
  ctx.self.self = ctx.self;
  vm.createContext(ctx);
  vm.runInContext(read('common/store.js'), ctx, { filename: 'common/store.js' });
  store = JSON.parse(JSON.stringify(ctx.self.BO.store));
  assert.deepStrictEqual(store.DEFAULT_LEVELS, { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'strict' });
  assert.deepStrictEqual(store.DEFAULT_LEVELS, store.PRESETS.little);
  assert.ok(/levels:\s*copy\(PRESETS\['little-kids'\]\)/.test(desk), 'desktop default is the little-kids preset');
  [['little', 'little-kids'], ['teens', 'teens']].forEach(function (p) {
    var m = new RegExp("'?" + p[1] + "'?:\\s*(\\{[^}]*\\})").exec(desk);
    assert.ok(m, 'desktop preset ' + p[1]);
    assert.deepStrictEqual(store.PRESETS[p[0]], JSON.parse(m[1].replace(/(\w+):/g, '"$1":').replace(/'/g, '"')), p[0]);
  });
});
