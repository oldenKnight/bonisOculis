/*
 * bonis oculis extension - test runner.
 *
 *   node extension/test/run.js            unit tests + real-browser test
 *   node extension/test/run.js --unit     unit tests only (no browser needed)
 *
 * Real-browser part: loads the extension unpacked into Chromium with
 * Playwright (launchPersistentContext, --load-extension) and plays a 60 s
 * synthetic colour-bar clip (ffmpeg testsrc2) with a WebVTT track from a tiny
 * HTTP server on 127.0.0.1. Asserts: badge and planned scenes from the page's
 * own track; playback jumps over a skip range; mute range mutes and restores;
 * black-out + mute when the page refuses the seek; panic command through the
 * service worker; a parent's .srt gives the same ranges as the page track;
 * auto-sync recovers a 2.5 s shift; skip-file import; Spanish strings; no
 * request leaves 127.0.0.1.
 * Live listening (M8): the popup switch reports Chrome's refusal when the
 * extension was not invoked on the tab (no user gesture in automation); the
 * offscreen document loads onnxruntime-web (wasm) and YAMNet and classifies
 * two generated clips through the real audio path (media element ->
 * AudioWorklet -> resampler -> 0.96 s windows): 2 s silence + 3 s of short
 * white-noise impulses + 2 s silence, and a 5 s sine; the impulses cover and
 * mute the test page's video and release after the quiet period; a fed
 * score stream covers and releases; the inference time per window is
 * printed. These use the BO_TEST path of the test copy (version_name), which
 * classifies a file from this server instead of capturing the tab.
 *
 * Needs (never installed into the repo):
 *   - playwright-core or playwright: set BO_PLAYWRIGHT to its node_modules
 *     folder, e.g. `npm i playwright-core` in a scratch folder, then
 *     BO_PLAYWRIGHT=/that/folder/node_modules node extension/test/run.js
 *   - Chromium: BO_CHROMIUM, else /opt/pw-browsers/chromium, else
 *     Playwright's own download
 *   - ffmpeg on PATH (or BO_FFMPEG)
 * Work files go to BO_SCRATCH (default: <os tmp>/bonis-oculis-ext-test).
 *
 * ES5 syntax. Playwright's API returns promises; they are turned into
 * node-style callbacks by `p()` and the steps run as a callback sequence.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var assert = require('assert');
var cp = require('child_process');
var crypto = require('crypto');

var EXT = path.join(__dirname, '..');
var ROOT = path.join(EXT, '..');
var SITE = path.join(__dirname, 'site');
var SCRATCH = process.env.BO_SCRATCH || path.join(os.tmpdir(), 'bonis-oculis-ext-test');
var FFMPEG = process.env.BO_FFMPEG || 'ffmpeg';
var HEADED = !!process.env.HEADED;
var t0 = Date.now();

/* ---------------------------------------------------------------------- */
/* tiny helpers                                                           */
/* ---------------------------------------------------------------------- */

function log(s) { process.stdout.write(s + '\n'); }

/* The running step's end(err); assertion errors thrown inside callbacks are routed to it. */
var currentEnd = null;

function failCurrent(e) {
  if (currentEnd) { currentEnd(e); } else { log(String(e && e.stack ? e.stack : e)); process.exit(1); }
}

process.on('uncaughtException', failCurrent);

/* promise -> callback(err, value); a throw inside cb fails the current step */
function p(promise, cb) {
  promise.then(function (v) { call(null, v); }, function (e) { call(e || new Error('rejected')); });
  function call(err, v) {
    try { cb(err, v); } catch (e) { failCurrent(e); }
  }
}

function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src).forEach(function (n) {
    var s = path.join(src, n), d = path.join(dst, n);
    if (skip && skip.indexOf(n) >= 0) { return; }
    if (fs.statSync(s).isDirectory()) { copyDir(s, d); } else { fs.copyFileSync(s, d); }
  });
}

function findPlaywright() {
  var dirs = [], i, name;
  if (process.env.BO_PLAYWRIGHT) { dirs.push(process.env.BO_PLAYWRIGHT); }
  dirs.push(path.join(SCRATCH, 'node_modules'), process.cwd());
  for (i = 0; i < dirs.length; i++) {
    for (name = 0; name < 2; name++) {
      try { return require(require.resolve(name ? 'playwright' : 'playwright-core', { paths: [dirs[i]] })); } catch (e) { /* next */ }
    }
  }
  return null;
}

function chromiumPath() {
  if (process.env.BO_CHROMIUM) { return process.env.BO_CHROMIUM; }
  if (fs.existsSync('/opt/pw-browsers/chromium')) { return '/opt/pw-browsers/chromium'; }
  return undefined;
}

/* ---------------------------------------------------------------------- */
/* unit tests                                                             */
/* ---------------------------------------------------------------------- */

function runUnit() {
  var r = cp.spawnSync(process.execPath, ['--test', 'extension/test/unit', 'shared/test/subscan.test.js'], { cwd: ROOT, encoding: 'utf8' });
  var out = (r.stdout || '') + (r.stderr || ''), pass = /# pass (\d+)/.exec(out), fail = /# fail (\d+)/.exec(out);
  log('unit tests: ' + (pass ? pass[1] : '?') + ' passed, ' + (fail ? fail[1] : '?') + ' failed');
  if (r.status !== 0) { log(out); }
  return r.status === 0;
}

/* ---------------------------------------------------------------------- */
/* media and server                                                       */
/* ---------------------------------------------------------------------- */

/* Live-listening clips (nothing explicit: impulses of white noise and a sine). */
function makeLiveMedia(dir) {
  var burst = path.join(dir, 'live-burst.wav'), sine = path.join(dir, 'live-sine.wav'), r;
  if (!fs.existsSync(burst)) {
    r = cp.spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2',
      '-f', 'lavfi', '-i', "aevalsrc='(random(0)*2-1)*exp(-35*mod(t,0.08))':s=48000:d=3,lowpass=f=3000,volume=4,alimiter=limit=0.95",
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2',
      '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'pcm_s16le', burst], { encoding: 'utf8' });
    if (r.status !== 0) { throw new Error('ffmpeg could not make the burst clip: ' + (r.stderr || r.error)); }
  }
  if (!fs.existsSync(sine)) {
    r = cp.spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=5', '-c:a', 'pcm_s16le', sine], { encoding: 'utf8' });
    if (r.status !== 0) { throw new Error('ffmpeg could not make the sine clip: ' + (r.stderr || r.error)); }
  }
}

/* index -> AudioSet display name, from the analyzer's copy of the official class map */
function yamnetNames() {
  var lines = fs.readFileSync(path.join(ROOT, 'analyzer', 'models', 'yamnet_class_map.csv'), 'utf8').split(/\r?\n/).slice(1), out = [];
  lines.forEach(function (l) {
    var m = /^(\d+),[^,]*,(.*)$/.exec(l);
    if (m) { out[+m[1]] = m[2].replace(/^"|"$/g, ''); }
  });
  return out;
}

function makeMedia() {
  var dir = path.join(SCRATCH, 'media'), mp4 = path.join(dir, 'clip.mp4'), webm = path.join(dir, 'clip.webm'), base, r;
  fs.mkdirSync(dir, { recursive: true });
  base = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60'];
  if (!fs.existsSync(mp4)) {
    r = cp.spawnSync(FFMPEG, base.concat(['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', mp4]), { encoding: 'utf8' });
    if (r.status !== 0) {
      r = cp.spawnSync(FFMPEG, base.concat(['-c:v', 'mpeg4', '-q:v', '8', '-g', '25', '-c:a', 'aac', '-shortest', mp4]), { encoding: 'utf8' });
    }
    if (r.status !== 0) { throw new Error('ffmpeg could not make the mp4: ' + (r.stderr || r.error)); }
  }
  /* Playwright's Chromium has no H.264 decoder; the page falls back to this. */
  if (!fs.existsSync(webm)) {
    r = cp.spawnSync(FFMPEG, base.concat(['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-g', '25', '-c:a', 'libvorbis', '-shortest', webm]), { encoding: 'utf8' });
    if (r.status !== 0) { throw new Error('ffmpeg could not make the webm: ' + (r.stderr || r.error)); }
  }
  makeLiveMedia(dir);
  return dir;
}

var TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.vtt': 'text/vtt; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav' };

function serve(roots, cb) {
  var server = http.createServer(function (req, res) {
    var name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html', file = null, i, stat, range, m, start, end, cors;
    if (name.indexOf('..') >= 0) { res.writeHead(400); res.end(); return; }
    if (name === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    for (i = 0; i < roots.length; i++) { if (fs.existsSync(path.join(roots[i], name))) { file = path.join(roots[i], name); break; } }
    if (!file) { res.writeHead(404); res.end(); return; }
    stat = fs.statSync(file);
    range = req.headers.range;
    m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    /* the offscreen document (chrome-extension:// origin) reads the audio clips through Web Audio: CORS */
    cors = path.extname(file) === '.wav' ? { 'Access-Control-Allow-Origin': '*' } : {};
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.writeHead(206, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 }, cors));
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }
    res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size }, cors));
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', function () { cb(server, 'http://127.0.0.1:' + server.address().port); });
}

/* The test copy grants <all_urls> at install (instead of the optional
   permission prompt a parent would answer), so the service worker registers
   the generic adapter exactly as it does after the parent says yes. It is
   marked BO_TEST (version_name), which enables the live-listening test path,
   and its pages may play media from this test server (media-src). */
function prepareExtension(name) {
  var dir = path.join(SCRATCH, name || 'ext'), mf;
  rmrf(dir);
  copyDir(EXT, dir, ['test', 'tools', 'README.md']);
  mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.host_permissions.push('<all_urls>');
  delete mf.optional_host_permissions;
  mf.version_name = mf.version_name + ' BO_TEST';
  mf.content_security_policy.extension_pages = mf.content_security_policy.extension_pages.replace("media-src 'self' blob:", "media-src 'self' blob: http://127.0.0.1:*");
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

function makeSkipFile() {
  var skipfile = require(path.join(ROOT, 'shared', 'skipfile.js')), file = path.join(SCRATCH, 'test-film.bonis.json');
  var doc = skipfile.newDoc({
    media: { title: 'Test film', duration: 60, fingerprint: { size: 1, oshash: '0123456789abcdef' } },
    ranges: [skipfile.newRange({ id: 'rtest0001', start: 15, end: 18, category: 'other', action: 'skip', review: 'approved' })]
  }, { now: '2026-10-12T00:00:00Z' });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

/* ---------------------------------------------------------------------- */
/* browser test                                                           */
/* ---------------------------------------------------------------------- */

function browserTest(pw, done) {
  var ctx = null, sw = null, page = null, popup = null, server = null, base = '', tabId = null, extId = '';
  var results = [], requests = [], pageErrors = [], steps, mediaDir, extDir, skipFile, pageRanges = null, liveTimes = [];

  /* ----- small async helpers (callback style) ----- */
  function swEval(fn, arg, cb) { p(sw.evaluate(fn, arg), cb); }
  function pgEval(fn, arg, cb) { p(page.evaluate(fn, arg), cb); }
  function state(cb) {
    swEval(function (id) {
      return new Promise(function (resolve) { chrome.tabs.sendMessage(id, { t: 'getState' }, function (s) { void chrome.runtime.lastError; resolve(s || null); }); });
    }, tabId, cb);
  }
  function badge(cb) {
    swEval(function (id) { return new Promise(function (resolve) { chrome.action.getBadgeText({ tabId: id }, resolve); }); }, tabId, cb);
  }
  function video(cb) {
    pgEval(function () {
      var v = document.getElementById('v'), o = document.getElementById('bonis-oculis-overlay'), r = v.getBoundingClientRect(), orr = o ? o.getBoundingClientRect() : null;
      return {
        t: v.currentTime, muted: v.muted, paused: v.paused, ready: v.readyState, src: v.currentSrc,
        overlay: !!o && getComputedStyle(o).display !== 'none',
        covers: !!orr && orr.left <= r.left && orr.top <= r.top && orr.right >= r.right && orr.bottom >= r.bottom
      };
    }, null, cb);
  }
  /* poll check(cb(err, bool)) until true */
  function waitFor(what, check, ms, cb) {
    var until = Date.now() + ms;
    (function again() {
      check(function (err, ok) {
        if (!err && ok) { cb(null); return; }
        if (Date.now() > until) { cb(new Error('timed out waiting for ' + what + (err ? ': ' + err.message : ''))); return; }
        setTimeout(again, 50);
      });
    }());
  }
  function waitTime(sec, ms, cb) {
    waitFor('video time >= ' + sec, function (k) { video(function (e, v) { k(e, v && v.t >= sec); }); }, ms, cb);
  }
  function play(at, cb) {
    pgEval(function (a) { var v = document.getElementById('v'); window.__test.clearLog(); v.muted = false; window.__test.seek(a); return v.play().then(function () { return true; }); }, at, cb);
  }
  function pause(cb) { pgEval(function () { document.getElementById('v').pause(); return true; }, null, cb); }
  function sleep(ms, cb) { setTimeout(function () { cb(null); }, ms); }
  function cmpRanges(list) {
    return list.map(function (r) { return [r.start, r.end, r.category, r.action].join(' '); }).sort();
  }
  function byPrefix(s, prefix) { return s.ranges.filter(function (r) { return String(r.id).indexOf(prefix) === 0; }); }
  function liveTest(opts, cb) {
    swEval(function (a) { return new Promise(function (resolve) { self.BO_BG.liveTest(a.id, a.opts, resolve); }); }, { id: tabId, opts: opts }, cb);
  }
  function offLog(cb) {
    swEval(function () { return new Promise(function (resolve) { self.BO_BG.toOffscreen({ t: 'offLog' }, resolve); }); }, null, cb);
  }
  function storedLive(cb) {
    swEval(function () { return new Promise(function (resolve) { chrome.storage.local.get(null, resolve); }); }, null, function (err, all) {
      var keys;
      if (err) { cb(err); return; }
      keys = Object.keys(all).filter(function (k) { return k.indexOf('video|127.0.0.1|') === 0; });
      cb(null, keys.length ? (all[keys[0]].live || []) : []);
    });
  }
  function liveNote(s) { log('    # ' + s); }

  steps = [
    ['set up: media, server, extension, browser', function (next) {
      mediaDir = makeMedia();
      extDir = prepareExtension();
      skipFile = makeSkipFile();
      serve([SITE, mediaDir], function (srv, url) {
        var profile = path.join(SCRATCH, 'profile');
        server = srv;
        base = url;
        rmrf(profile);
        p(pw.chromium.launchPersistentContext(profile, {
          executablePath: chromiumPath(),
          headless: !HEADED,
          viewport: { width: 1000, height: 700 },
          args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir, '--autoplay-policy=no-user-gesture-required', '--mute-audio']
        }), function (err, c) {
          if (err) { next(err); return; }
          ctx = c;
          ctx.on('request', function (r) { requests.push(r.url()); });
          sw = ctx.serviceWorkers()[0];
          if (sw) { next(); return; }
          p(ctx.waitForEvent('serviceworker', { timeout: 15000 }), function (e2, w) { sw = w; next(e2); });
        });
      });
    }],

    ['service worker registers the generic adapter; strict levels for the test', function (next) {
      extId = /chrome-extension:\/\/([a-z]+)\//.exec(sw.url())[1];
      swEval(function () {
        return new Promise(function (resolve) {
          chrome.storage.local.set({ settings: { levels: { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'strict' }, lang: 'en' } }, function () {
            self.BO_BG.syncGenericRegistration(function (on) {
              chrome.scripting.getRegisteredContentScripts(function (list) { resolve({ on: on, ids: list.map(function (x) { return x.id; }) }); });
            });
          });
        });
      }, null, function (err, r) {
        if (err) { next(err); return; }
        assert.strictEqual(r.on, true);
        assert.deepStrictEqual(r.ids.sort(), ['bo-generic', 'bo-generic-hook']);
        next();
      });
    }],

    ['page track is read; badge shows the planned scenes', function (next) {
      page = ctx.pages()[0];
      page.on('pageerror', function (e) { pageErrors.push(String(e)); });
      page.on('console', function (m) { if (m.type() === 'error') { pageErrors.push(m.text()); } });
      p(page.goto(base + '/index.html'), function (err) {
        if (err) { next(err); return; }
        swEval(function (b) {
          return new Promise(function (resolve) { chrome.tabs.query({}, function (tabs) { resolve(tabs.filter(function (x) { return (x.url || '').indexOf(b) === 0; }).map(function (x) { return x.id; })[0]); }); });
        }, base, function (e2, id) {
          if (e2) { next(e2); return; }
          tabId = id;
          waitFor('badge "3"', function (k) { badge(function (e, b) { k(e, b === '3'); }); }, 15000, function (e3) {
            if (e3) { next(e3); return; }
            state(function (e4, s) {
              if (e4) { next(e4); return; }
              assert.strictEqual(s.adapter, 'generic');
              assert.strictEqual(s.scenes, 2);
              assert.strictEqual(s.mutes, 1);
              pageRanges = byPrefix(s, 'rpage');
              assert.deepStrictEqual(cmpRanges(pageRanges), ['29.5 32.5 language mute', '43 48 kissing skip', '8 13 sex skip']);
              next();
            });
          });
        });
      });
    }],

    ['skip range: playback jumps from 8 s to 13 s', function (next) {
      play(6.5, function (err) {
        if (err) { next(err); return; }
        waitTime(13.2, 6000, function (e2) {
          if (e2) { next(e2); return; }
          sleep(300, function () {
            pgEval(function () { return window.__test.log(); }, null, function (e3, times) {
              if (e3) { next(e3); return; }
              var inside = times.filter(function (x) { return x > 8.3 && x < 12.95; });
              assert.deepStrictEqual(inside, [], 'played inside the skip range: ' + inside.join(', '));
              assert.ok(times.some(function (x) { return x >= 13; }));
              video(function (e4, v) {
                if (e4) { next(e4); return; }
                assert.strictEqual(v.overlay, false, 'no black-out after the jump');
                assert.strictEqual(v.muted, false, 'sound restored after the jump');
                next();
              });
            });
          });
        });
      });
    }],

    ['mute range: muted from 29.5 s, restored at 32.5 s', function (next) {
      play(28.5, function (err) {
        if (err) { next(err); return; }
        waitTime(30.3, 5000, function (e2) {
          if (e2) { next(e2); return; }
          video(function (e3, v) {
            if (e3) { next(e3); return; }
            assert.strictEqual(v.muted, true, 'muted inside the range');
            assert.strictEqual(v.overlay, false, 'mute only, no black-out');
            waitTime(32.8, 5000, function (e4) {
              if (e4) { next(e4); return; }
              video(function (e5, v2) {
                if (e5) { next(e5); return; }
                assert.strictEqual(v2.muted, false, 'sound restored after the range');
                next();
              });
            });
          });
        });
      });
    }],

    ['seek refused by the page: black-out covers the video and mutes, restored at 48 s', function (next) {
      pgEval(function () { window.__test.blockSeeks(true); return true; }, null, function () {
        play(41.6, function (err) {
          if (err) { next(err); return; }
          waitTime(44, 6000, function (e2) {
            if (e2) { next(e2); return; }
            video(function (e3, v) {
              if (e3) { next(e3); return; }
              assert.strictEqual(v.overlay, true, 'black-out shown');
              assert.strictEqual(v.covers, true, 'black-out covers the whole video box');
              assert.strictEqual(v.muted, true, 'muted while covered');
              assert.ok(v.t < 48, 'the page really refused the jump');
              pgEval(function () { return window.__test.reverted(); }, null, function (e4, n) {
                assert.ok(n >= 1, 'page reverted a seek');
                waitTime(48.3, 7000, function (e5) {
                  if (e5) { next(e5); return; }
                  video(function (e6, v2) {
                    if (e6) { next(e6); return; }
                    assert.strictEqual(v2.overlay, false, 'black-out removed at the range end');
                    assert.strictEqual(v2.muted, false, 'sound restored at the range end');
                    pgEval(function () { window.__test.blockSeeks(false); return true; }, null, function () {
                      state(function (e7, s) { assert.ok(s.blocked >= 1); next(e7); });
                    });
                  });
                });
              });
            });
          });
        });
      });
    }],

    ['panic command (service worker): hides at once, second press restores and saves the moment', function (next) {
      play(50.5, function (err) {
        if (err) { next(err); return; }
        sleep(400, function () {
          swEval(function () { return new Promise(function (resolve) { self.BO_BG.onCommand('panic', null, resolve); }); }, null, function (e2, s) {
            if (e2) { next(e2); return; }
            assert.ok(s && s.panic === true, 'panic on through the active tab');
            video(function (e3, v) {
              if (e3) { next(e3); return; }
              assert.strictEqual(v.overlay, true);
              assert.strictEqual(v.muted, true);
              sleep(800, function () {
                swEval(function (id) { return new Promise(function (resolve) { self.BO_BG.onCommand('panic', { id: id }, resolve); }); }, tabId, function (e4, s2) {
                  if (e4) { next(e4); return; }
                  assert.strictEqual(s2.panic, false);
                  sleep(300, function () {
                    video(function (e5, v2) {
                      if (e5) { next(e5); return; }
                      assert.strictEqual(v2.overlay, false, 'restored after the second press');
                      assert.strictEqual(v2.muted, false, 'sound restored after the second press');
                      swEval(function () { return new Promise(function (resolve) { chrome.storage.local.get(null, resolve); }); }, null, function (e6, all) {
                        if (e6) { next(e6); return; }
                        var keys = Object.keys(all).filter(function (k) { return k.indexOf('video|127.0.0.1|') === 0; });
                        assert.strictEqual(keys.length, 1);
                        assert.strictEqual(all[keys[0]].panic.length, 1, 'panic range stored for this video');
                        assert.ok(all[keys[0]].panic[0].end > all[keys[0]].panic[0].start);
                        state(function (e7, st) { assert.strictEqual(st.marks, 1); next(e7); });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    }],

    ['popup: shows planned scenes for the tab', function (next) {
      pause(function () {
        p(ctx.newPage(), function (err, pg) {
          if (err) { next(err); return; }
          popup = pg;
          popup.on('pageerror', function (e) { pageErrors.push('popup: ' + String(e)); });
          p(popup.goto('chrome-extension://' + extId + '/popup/popup.html?tab=' + tabId), function (e2) {
            if (e2) { next(e2); return; }
            p(popup.waitForSelector('#ready:not([hidden])', { timeout: 8000 }), function (e3) {
              if (e3) { next(e3); return; }
              p(popup.textContent('#scenesLine'), function (e4, txt) {
                if (e4) { next(e4); return; }
                assert.strictEqual(txt, '3 scenes will be skipped');
                p(popup.textContent('#mutesLine'), function (e5, m) { assert.strictEqual(m, '1 moment will be muted'); next(e5); });
              });
            });
          });
        });
      });
    }],

    ['a parent\'s .srt gives the same ranges as the page track', function (next) {
      p(popup.setInputFiles('#subInput', path.join(SITE, 'captions.srt')), function (err) {
        if (err) { next(err); return; }
        p(popup.waitForSelector('#toast:not([hidden])', { timeout: 5000 }), function (e2) {
          if (e2) { next(e2); return; }
          p(popup.textContent('#toast'), function (e3, txt) {
            assert.strictEqual(txt, 'Subtitle file added. We found 3 scenes.');
            state(function (e4, s) {
              if (e4) { next(e4); return; }
              assert.strictEqual(s.subFile, 'captions.srt');
              assert.deepStrictEqual(cmpRanges(byPrefix(s, 'rfile')), cmpRanges(pageRanges));
              next();
            });
          });
        });
      });
    }],

    ['auto-sync finds a 2.5 s shift and the ranges match again', function (next) {
      p(popup.setInputFiles('#subInput', path.join(SITE, 'captions-late.srt')), function (err) {
        if (err) { next(err); return; }
        waitFor('late file applied', function (k) { state(function (e, s) { k(e, s && s.subFile === 'captions-late.srt'); }); }, 5000, function (e2) {
          if (e2) { next(e2); return; }
          state(function (e3, s) {
            if (e3) { next(e3); return; }
            assert.notDeepStrictEqual(cmpRanges(byPrefix(s, 'rfile')), cmpRanges(pageRanges));
            p(popup.click('#timingBox > summary', { timeout: 5000 }).then(function () { return popup.click('#autoSync', { timeout: 5000 }); }), function (e4) {
              if (e4) { next(e4); return; }
              waitFor('offset -2.5', function (k) { state(function (e, s2) { k(e, s2 && s2.offset === -2.5); }); }, 5000, function (e5) {
                if (e5) { next(e5); return; }
                state(function (e6, s3) {
                  if (e6) { next(e6); return; }
                  assert.deepStrictEqual(cmpRanges(byPrefix(s3, 'rfile')), cmpRanges(pageRanges));
                  p(popup.textContent('#offValue-sub'), function (e7, v) { assert.strictEqual(v, '−2.5 s'); next(e7); });
                });
              });
            });
          });
        });
      });
    }],

    ['skip-file import is validated, stored and enforced', function (next) {
      p(popup.setInputFiles('#skipInput', skipFile), function (err) {
        if (err) { next(err); return; }
        waitFor('skip file stored', function (k) { state(function (e, s) { k(e, s && s.skipFiles.length === 1); }); }, 5000, function (e2) {
          if (e2) { next(e2); return; }
          state(function (e3, s) {
            if (e3) { next(e3); return; }
            assert.strictEqual(s.skipFiles[0].title, 'Test film');
            assert.ok(s.ranges.some(function (r) { return r.start === 15 && r.end === 18 && r.action === 'skip'; }));
            swEval(function () { return new Promise(function (resolve) { chrome.storage.local.get(null, function (a) { resolve(Object.keys(a)); }); }); }, null, function (e4, keys) {
              assert.ok(keys.some(function (k) { return /^skip\|127\.0\.0\.1\|g[0-9a-f]{8}\|0123456789abcdef$/.test(k); }), 'stored under site+video+fingerprint');
              play(14.2, function (e5) {
                if (e5) { next(e5); return; }
                waitTime(18.1, 5000, function (e6) {
                  if (e6) { next(e6); return; }
                  pgEval(function () { return window.__test.log(); }, null, function (e7, times) {
                    assert.deepStrictEqual(times.filter(function (x) { return x > 15.3 && x < 17.95; }), []);
                    pause(function () { next(e7); });
                  });
                });
              });
            });
          });
        });
      });
    }],

    ['an invalid skip file is refused with a plain message', function (next) {
      var bad = path.join(SCRATCH, 'broken.bonis.json');
      fs.writeFileSync(bad, '{"format":"something-else"}');
      p(popup.setInputFiles('#skipInput', bad), function (err) {
        if (err) { next(err); return; }
        waitFor('error toast', function (k) {
          p(popup.textContent('#toast'), function (e, txt) { k(e, /could not be used/.test(txt || '')); });
        }, 4000, next);
      });
    }],

    ['language toggle: the popup switches to Spanish', function (next) {
      p(popup.click('button[data-lang="es"]', { timeout: 5000 }), function (err) {
        if (err) { next(err); return; }
        waitFor('Spanish text', function (k) {
          p(popup.textContent('#scenesLine'), function (e, txt) { k(e, /^Se omitirán \d+ escenas$/.test(txt || '')); });
        }, 4000, function (e2) {
          if (e2) { next(e2); return; }
          p(popup.textContent('#panicLabel'), function (e3, txt) { assert.strictEqual(txt, 'Ocultar el video ahora'); next(e3); });
        });
      });
    }],

    ['live: the popup switch reports Chrome\'s refusal without a user gesture and stops everything', function (next) {
      p(popup.waitForSelector('#liveSwitch', { timeout: 5000 }), function (err) {
        if (err) { next(err); return; }
        p(popup.getAttribute('#liveSwitch', 'aria-checked'), function (e2, on) {
          if (e2) { next(e2); return; }
          assert.strictEqual(on, 'false', 'live listening starts off');
          p(popup.click('#liveSwitch', { timeout: 5000 }), function (e3) {
            if (e3) { next(e3); return; }
            waitFor('live error shown', function (k) {
              p(popup.evaluate(function () {
                var st = document.getElementById('liveStatus');
                return { hidden: st.hidden, error: st.classList.contains('is-error'), text: document.getElementById('liveStatusText').textContent, on: document.getElementById('liveSwitch').getAttribute('aria-checked') };
              }), function (e, r) { k(e, r && !r.hidden && r.error && r.on === 'false' && r.text.length > 10); });
            }, 8000, function (e4) {
              if (e4) { next(e4); return; }
              swEval(function (id) {
                return new Promise(function (resolve) {
                  self.BO_BG.liveState(id, function (ls) {
                    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }, function (list) { resolve({ ls: ls, offscreen: list.length }); });
                  });
                });
              }, tabId, function (e5, r) {
                if (e5) { next(e5); return; }
                assert.strictEqual(r.ls.on, false);
                assert.strictEqual(r.ls.error, 'liveNoCapture');
                assert.strictEqual(r.offscreen, 0, 'no offscreen document left after the error');
                next();
              });
            });
          });
        });
      });
    }],

    ['live: offscreen loads ORT wasm + YAMNet; impulses cover and mute the video, release after the quiet period', function (next) {
      var names = yamnetNames(), sawCover = null;
      play(33, function (err) {
        if (err) { next(err); return; }
        liveTest({ url: base + '/live-burst.wav' }, function (e2, res) {
          if (e2) { next(e2); return; }
          assert.ok(res && res.ok, 'test start: ' + JSON.stringify(res));
          assert.ok(/AudioWorklet|ScriptProcessor/.test(res.capture), 'capture ' + res.capture);
          liveNote('runtime + model loaded in ' + res.loadMs + ' ms; capture ' + res.capture + ' at ' + res.rate + ' Hz');
          waitFor('live cover from the impulses', function (k) {
            video(function (e, v) {
              if (v && v.overlay) { sawCover = v; }
              k(e, !!sawCover);
            });
          }, 12000, function (e3) {
            if (e3) { next(e3); return; }
            assert.strictEqual(sawCover.covers, true, 'live black-out covers the whole video box');
            assert.strictEqual(sawCover.muted, true, 'muted while covered (file test mutes the element)');
            pgEval(function () { return !!document.getElementById('bonis-oculis-listening'); }, null, function (e4, tag) {
              if (e4) { next(e4); return; }
              assert.strictEqual(tag, true, 'listening tag on the video corner');
              badge(function (e5, b) {
                if (e5) { next(e5); return; }
                assert.ok(/^●/.test(b), 'badge shows listening: ' + b);
                state(function (e6, st) {
                  if (e6) { next(e6); return; }
                  assert.strictEqual(st.live.listening, true);
                  assert.strictEqual(st.live.covered, true);
                  assert.strictEqual(st.enforcer.live.category, 'gore');
                  waitFor('live release', function (k) { video(function (e, v) { k(e, v && !v.overlay && !v.muted); }); }, 12000, function (e7) {
                    if (e7) { next(e7); return; }
                    offLog(function (e8, log) {
                      if (e8) { next(e8); return; }
                      var fr = log.frames, cls = fr.filter(function (f) { return !f.silent; }), sil = fr.filter(function (f) { return f.silent; }), i, gore = 0, gunTop = 0;
                      assert.ok(fr.length >= 14, 'windows: ' + fr.length);
                      for (i = 1; i < fr.length; i++) { assert.ok(Math.abs(fr[i].t - fr[i - 1].t - 0.48) < 0.02, 'hop ' + fr[i - 1].t + ' -> ' + fr[i].t); }
                      assert.ok(sil.length >= 4, 'silence windows are recognised: ' + sil.length);
                      cls.forEach(function (f) {
                        assert.strictEqual(f.n, 521, 'YAMNet returns 521 class scores');
                        ['sex', 'implied', 'gore'].forEach(function (c) { assert.ok(f[c] >= 0 && f[c] <= 1, c + '=' + f[c]); });
                        assert.ok(f.ms > 0 && f.top.length === 3);
                        gore = Math.max(gore, f.gore);
                        if ([420, 421, 422, 423].indexOf(f.top[0][0]) >= 0) { gunTop++; }
                      });
                      assert.ok(gore >= 0.6, 'gunfire-like impulses reach the violence threshold: ' + gore);
                      assert.ok(gunTop >= 2, 'top class gunfire/explosion on ' + gunTop + ' windows');
                      liveTimes.push(log.stats);
                      assert.deepStrictEqual(log.resources.filter(function (u) { return !/^chrome-extension:\/\//.test(u) && u.indexOf(base + '/') !== 0; }), [], 'offscreen loads only package files (and the test clip)');
                      log.frames.filter(function (f) { return !f.silent; }).slice(0, 12).forEach(function (f) {
                        log.top = (log.top || []).concat([f.t.toFixed(2) + 's ' + names[f.top[0][0]] + ' ' + f.top[0][1] + ' gore ' + f.gore.toFixed(2)]);
                      });
                      liveNote('impulses: ' + cls.length + ' windows classified, ' + sil.length + ' silent, avg ' + log.stats.avgMs + ' ms, max ' + log.stats.maxMs + ' ms per window (' + log.stats.capture + '); top: ' + log.top.slice(0, 6).join(' | '));
                      storedLive(function (e9, list) {
                        if (e9) { next(e9); return; }
                        assert.strictEqual(list.length, 1, 'one live moment stored');
                        assert.strictEqual(list[0].category, 'gore');
                        assert.ok(list[0].end > list[0].start && list[0].start >= 30 && list[0].end <= 44, JSON.stringify(list[0]));
                        state(function (e10, st2) {
                          if (e10) { next(e10); return; }
                          assert.strictEqual(st2.live.marks, 1);
                          assert.ok(st2.ranges.some(function (r) { return r.source === 'live' && r.action === 'skip'; }), 'live moment is part of the plan');
                          next();
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    }],

    ['live: a 5 s sine is heard as a tone and never covers', function (next) {
      var names = yamnetNames(), covered = false, until;
      pause(function () {
        liveTest({ url: base + '/live-sine.wav' }, function (err, res) {
          if (err) { next(err); return; }
          assert.ok(res && res.ok, JSON.stringify(res));
          until = Date.now() + 6200;
          (function poll() {
            video(function (e, v) {
              if (e) { next(e); return; }
              if (v.overlay) { covered = true; }
              if (Date.now() < until) { setTimeout(poll, 100); return; }
              offLog(function (e2, log) {
                if (e2) { next(e2); return; }
                var cls = log.frames.filter(function (f) { return !f.silent; }), tops = {};
                assert.strictEqual(covered, false, 'a tone never covers');
                assert.ok(cls.length >= 8, 'sine windows classified: ' + cls.length);
                cls.forEach(function (f) {
                  assert.ok(f.sex < 0.25 && f.gore < 0.3, 'tone scores stay low');
                  tops[names[f.top[0][0]]] = (tops[names[f.top[0][0]]] || 0) + 1;
                });
                assert.ok(!tops.Silence, 'the tone is heard, not silence');
                liveTimes.push(log.stats);
                liveNote('sine: ' + cls.length + ' windows, top classes ' + JSON.stringify(tops) + ', avg ' + log.stats.avgMs + ' ms');
                next();
              });
            });
          }());
        });
      });
    }],

    ['live: a fed score stream covers, never flaps, releases 3 s after the last loud window', function (next) {
      var frames = [], i, coverAt = null, releaseAt = null, t0 = Date.now();
      for (i = 0; i < 3; i++) { frames.push({ sex: 0.05 }); }
      frames.push({ sex: 0.9 }, { sex: 0.4 }, { sex: 0.8 }, { sex: 0.85 }, { sex: 0.3 }, { sex: 0.7 });
      for (i = 0; i < 9; i++) { frames.push({ sex: 0.1 }); }
      play(49, function (err) {
        if (err) { next(err); return; }
        liveTest({ frames: frames, intervalMs: 120 }, function (e2, res) {
          if (e2) { next(e2); return; }
          assert.ok(res && res.ok, JSON.stringify(res));
          (function poll() {
            video(function (e, v) {
              if (e) { next(e); return; }
              if (v.overlay && coverAt === null) { coverAt = Date.now() - t0; assert.strictEqual(v.muted, true, 'muted while covered'); }
              if (!v.overlay && coverAt !== null && releaseAt === null) { releaseAt = Date.now() - t0; }
              if (releaseAt === null && Date.now() - t0 < 6000) { setTimeout(poll, 40); return; }
              assert.ok(coverAt !== null, 'covered');
              assert.ok(releaseAt !== null, 'released');
              assert.strictEqual(v.muted, false, 'sound restored');
              waitFor('all fed windows', function (k) { offLog(function (e, l) { k(e, l && l.frames.length === frames.length); }); }, 4000, function (e3) {
                if (e3) { next(e3); return; }
                offLog(function (e3b, log) {
                  var f = log.frames, ev = log.events;
                  if (e3b) { next(e3b); return; }
                  /* cover on the 2nd window in a row >= 0.5 (index 6: 0.8, 0.85; 0.9 then 0.4 does not arm);
                     the last window >= 0.25 is index 8; release at the first window >= 3 s later (index 15) */
                  assert.deepStrictEqual(ev.map(function (x) { return [x.cover, x.category, x.t]; }), [[true, 'sex', f[6].t], [false, 'sex', f[15].t]]);
                  assert.ok(f[15].t - f[8].t >= 3 && f[14].t - f[8].t < 3, 'released exactly after the quiet period');
                storedLive(function (e4, list) {
                  if (e4) { next(e4); return; }
                  assert.strictEqual(list.length, 2);
                  assert.strictEqual(list[1].category, 'sex');
                  pause(function () { next(); });
                });
                });
              });
            });
          }());
        });
      });
    }],

    ['live: switching off closes the offscreen document, removes the tag and the badge dot', function (next) {
      swEval(function () { return new Promise(function (resolve) { self.BO_BG.liveStop(null, function () { chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }, function (l) { resolve(l.length); }); }); }); }, null, function (err, n) {
        if (err) { next(err); return; }
        assert.strictEqual(n, 0);
        sleep(300, function () {
          pgEval(function () { return !!document.getElementById('bonis-oculis-listening'); }, null, function (e2, tag) {
            if (e2) { next(e2); return; }
            assert.strictEqual(tag, false, 'listening tag removed');
            badge(function (e3, b) {
              assert.ok(!/●/.test(b), 'badge without the listening dot: ' + b);
              liveNote('inference per window: ' + liveTimes.map(function (s) { return 'avg ' + s.avgMs + ' ms / max ' + s.maxMs + ' ms over ' + s.classified; }).join('; '));
              next(e3);
            });
          });
        });
      });
    }],

    ['popup: two-step forget for hidden moments; no-PIN note with help link; shortcut warning matches Chrome\'s state', function (next) {
      function vis(sel, cb) { p(popup.evaluate(function (q) { var e = document.querySelector(q); return !!e && !e.closest('[hidden]') && e.getClientRects().length > 0; }, sel), cb); }
      function marks(cb) { state(function (e, st) { cb(e, st ? st.marks + st.live.marks : -1); }); }
      p(popup.reload(), function (err) {
        if (err) { next(err); return; }
        p(popup.waitForSelector('#ready:not([hidden])', { timeout: 8000 }), function (e2) {
          if (e2) { next(e2); return; }
          vis('#panicNoKey', function (e3, warn) {
            if (e3) { next(e3); return; }
            swEval(function () { return new Promise(function (r) { chrome.commands.getAll(function (l) { r(l.filter(function (c) { return c.name === 'panic'; })[0].shortcut || ''); }); }); }, null, function (e3b, key) {
            if (e3b) { next(e3b); return; }
            /* Chromium started with --load-extension may leave the suggested key unassigned: then the warning is right */
            assert.strictEqual(warn, !key, 'warning shown exactly when the panic key has no shortcut (' + JSON.stringify(key) + ')');
            if (!key) { liveNote('this Chromium left Alt+Shift+P unassigned; the popup warns, as it should'); }
            p(popup.evaluate(function () { var a = document.querySelector('a[data-i18n="noPinHelpLink"]'); return a ? [a.href, a.textContent, a.target] : null; }), function (e4, link) {
              if (e4) { next(e4); return; }
              assert.ok(link && /^https:\/\/support\.google\.com\/families\//.test(link[0]) && link[1].length > 10 && link[2] === '_blank', JSON.stringify(link));
              marks(function (e5, before) {
                if (e5) { next(e5); return; }
                assert.ok(before >= 2, 'hidden moments to forget: ' + before);
                p(popup.click('#forgetMarks', { timeout: 5000 }), function (e6) {
                  if (e6) { next(e6); return; }
                  vis('#forgetMarksConfirm', function (e7, shown) {
                    assert.strictEqual(shown, true, 'first click only asks');
                    marks(function (e8, still) {
                      assert.strictEqual(still, before, 'nothing forgotten yet');
                      p(popup.click('#forgetMarksNo', { timeout: 5000 }), function (e9) {
                        if (e9) { next(e9); return; }
                        vis('#forgetMarksConfirm', function (e10, shown2) {
                          assert.strictEqual(shown2, false);
                          p(popup.click('#forgetMarks', { timeout: 5000 }).then(function () { return popup.click('#forgetMarksYes', { timeout: 5000 }); }), function (e11) {
                            if (e11) { next(e11); return; }
                            waitFor('moments forgotten', function (k) { marks(function (e, n) { k(e, n === 0); }); }, 5000, next);
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
            });
          });
        });
      });
    }],

    ['popup: no warning with a shortcut; a missing one shows a warning that opens the shortcuts page', function (next) {
      /* shortcuts cannot be set from automation: stand in for both states */
      function stubbed(key, cb) {
        p(ctx.newPage(), function (err, pg) {
          if (err) { cb(err); return; }
          pg.on('pageerror', function (e) { pageErrors.push('popup2: ' + String(e)); });
          p(pg.addInitScript(function (k) { if (window.chrome && chrome.commands) { chrome.commands.getAll = function (f) { f([{ name: 'panic', shortcut: k }]); }; } }, key).then(function () {
            return pg.goto('chrome-extension://' + extId + '/popup/popup.html?tab=' + tabId);
          }).then(function () { return pg.waitForSelector('#ready:not([hidden])', { timeout: 8000 }); }), function (e2) { cb(e2, pg); });
        });
      }
      function missing() {
        stubbed('', function (err, pg) {
          if (err) { next(err); return; }
          p(pg.waitForSelector('#panicNoKey:not([hidden])', { timeout: 5000 }), function (e2) {
            if (e2) { next(e2); return; }
            p(Promise.all([ctx.waitForEvent('page', { timeout: 5000 }), pg.click('#openShortcuts')]), function (e3, r) {
              if (e3) { next(e3); return; }
              waitFor('shortcuts page', function (k) { k(null, /^chrome:\/\/extensions\/shortcuts/.test(r[0].url())); }, 3000, function (e4) {
                if (e4) { next(e4); return; }
                p(r[0].close().then(function () { return pg.close(); }), next);
              });
            });
          });
        });
      }
      stubbed('Alt+Shift+P', function (err, pg) {
        if (err) { next(err); return; }
        p(pg.evaluate(function () { return [document.getElementById('panicNoKey').hidden, document.getElementById('panicHint').textContent]; }), function (e2, r) {
          if (e2) { next(e2); return; }
          assert.strictEqual(r[0], true, 'no warning while a shortcut is set');
          assert.ok(/Alt\+Shift\+P/.test(r[1]), 'the hint names the keys');
          p(pg.close(), function () { missing(); });
        });
      });
    }],

    ['options: "Forget everything" asks first and names what is lost; the no-PIN note links to help', function (next) {
      p(ctx.newPage(), function (err, pg) {
        if (err) { next(err); return; }
        pg.on('pageerror', function (e) { pageErrors.push('options: ' + String(e)); });
        p(pg.goto('chrome-extension://' + extId + '/options/options.html').then(function () { return pg.click('#forget', { timeout: 5000 }); }), function (e2) {
          if (e2) { next(e2); return; }
          p(pg.evaluate(function () {
            return { confirm: !document.getElementById('forgetConfirm').hidden, text: document.getElementById('forgetConfirmText').textContent, first: document.getElementById('forget').hidden, link: !!document.querySelector('a[data-i18n="noPinHelpLink"][href^="https://support.google.com/"]') };
          }), function (e3, r) {
            if (e3) { next(e3); return; }
            assert.strictEqual(r.confirm, true);
            assert.ok(r.text.length > 40, 'the confirmation names the consequence');
            assert.strictEqual(r.first, true, 'the first button is replaced by the confirmation');
            assert.strictEqual(r.link, true);
            p(pg.click('#forgetNo', { timeout: 5000 }), function (e4) {
              if (e4) { next(e4); return; }
              swEval(function () { return new Promise(function (resolve) { chrome.storage.local.get('settings', function (x) { resolve(!!x.settings); }); }); }, null, function (e5, kept) {
                assert.strictEqual(kept, true, 'nothing forgotten after "Keep it"');
                p(pg.close(), function () { next(e5); });
              });
            });
          });
        });
      });
    }],

    ['hook channel: subtitles the page fetches arrive; forged messages and late handshakes get nothing (A10)', function (next) {
      state(function (err, s0) {
        if (err) { next(err); return; }
        pgEval(function () {
          var leaked = [], el = document.createElement('div');
          window.addEventListener('bonis-oculis:nonce', function (e) { leaked.push(e.detail); }, true);
          el.addEventListener('bonis-oculis:nonce', function (e) { leaked.push(e.detail); });
          document.documentElement.appendChild(el);
          el.dispatchEvent(new CustomEvent('bonis-oculis:hello', { bubbles: true }));
          window.dispatchEvent(new CustomEvent('bonis-oculis:ready'));
          el.remove();
          window.postMessage({ bo: 'bonis-oculis-hook', nonce: '0123456789abcdef0123456789abcdef', type: 'track', url: location.origin + '/forged.vtt', text: 'WEBVTT\n\n00:00:01.000 --> 00:00:59.000\n[moaning]\n', format: 'vtt' }, '*');
          return fetch('/hook-check.vtt').then(function (r) { return r.text(); }).then(function () { return leaked; });
        }, null, function (e2, leaked) {
          if (e2) { next(e2); return; }
          assert.deepStrictEqual(leaked, [], 'a late hello from the page gets no nonce');
          waitFor('the fetched subtitle arrives through the hook', function (k) { state(function (e, s) { k(e, s && s.pageCues === s0.pageCues + 1); }); }, 5000, function (e3) {
            if (e3) { next(e3); return; }
            sleep(300, function () {
              state(function (e4, s1) {
                if (e4) { next(e4); return; }
                assert.strictEqual(s1.pageCues, s0.pageCues + 1, 'the forged message added nothing');
                assert.deepStrictEqual(cmpRanges(byPrefix(s1, 'rpage')), cmpRanges(byPrefix(s0, 'rpage')), 'no range from the forged cue');
                next();
              });
            });
          });
        });
      });
    }],

    ['never left covered or muted; no request left 127.0.0.1; no page errors', function (next) {
      play(56.5, function (err) {
        if (err) { next(err); return; }
        sleep(600, function () {
          video(function (e2, v) {
            if (e2) { next(e2); return; }
            assert.strictEqual(v.overlay, false);
            assert.strictEqual(v.muted, false);
            /* chrome:// is the browser's own pages (the shortcuts page opened by the popup), never the network */
            var outside = requests.filter(function (u) { return !(u.indexOf(base) === 0 || /^(chrome-extension|chrome|data|blob|about):/.test(u)); });
            assert.deepStrictEqual(outside, []);
            assert.deepStrictEqual(pageErrors, []);
            next();
          });
        });
      });
    }]
  ];

  function finish(err) {
    function close() {
      if (server) { server.close(); }
      done(err, results);
    }
    if (ctx) { p(ctx.close(), close); } else { close(); }
  }

  (function runStep(i) {
    var name, timer, finished = false;
    if (i >= steps.length) { finish(null); return; }
    name = steps[i][0];
    timer = setTimeout(function () { end(new Error('step timed out')); }, 30000);
    currentEnd = end;
    function end(err) {
      if (finished) { return; }
      finished = true;
      currentEnd = null;
      clearTimeout(timer);
      results.push([name, err]);
      log((err ? 'not ok ' : 'ok ') + (i + 1) + ' - ' + name + (err ? '\n    ' + (err.stack || err).toString().split('\n').slice(0, 14).join('\n    ') : ''));
      if (err) { finish(err); return; }
      runStep(i + 1);
    }
    try { steps[i][1](end); } catch (e) { end(e); }
  }(0));
}


/* ---------------------------------------------------------------------- */
/* real tab capture (child run, headed)                                   */
/* ---------------------------------------------------------------------- */

/* Chrome derives an unpacked extension's id from its folder path. */
function extensionId(dir) {
  return crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, function (c) { return String.fromCharCode(97 + parseInt(c, 16)); });
}

/*
 * The live path exactly as a parent uses it, minus the click: the service
 * worker's liveStart (chrome.tabCapture.getMediaStreamId -> offscreen
 * getUserMedia of the tab), the page plays the impulse clip, the tab is
 * covered while its sound keeps reaching the listener (the element is NOT
 * muted; the offscreen route is), released after the quiet period, and
 * closing the tab stops everything. Chrome only hands out a tab stream after
 * a user gesture; --allowlisted-extension-id stands in for that click.
 * Captured sound is silent in headless mode and with --mute-audio, so this
 * runs headed (under xvfb-run when there is no display) and plays about
 * 8 s of test sound.
 */
function tabCaptureTest(pw, done) {
  var ctx = null, sw = null, page = null, server = null, base = '', tabId = null, extDir, mediaDir, requests = [], results = [], steps;
  function swEval(fn, arg, cb) { p(sw.evaluate(fn, arg), cb); }
  function pgEval(fn, arg, cb) { p(page.evaluate(fn, arg), cb); }
  function look(cb) {
    pgEval(function () {
      var v = document.getElementById('v'), o = document.getElementById('bonis-oculis-overlay');
      return { overlay: !!o && getComputedStyle(o).display !== 'none', muted: v.muted, t: v.currentTime, tag: !!document.getElementById('bonis-oculis-listening') };
    }, null, cb);
  }
  function waitFor(what, check, ms, cb) {
    var until = Date.now() + ms;
    (function again() {
      check(function (err, ok) {
        if (!err && ok) { cb(null); return; }
        if (Date.now() > until) { cb(new Error('timed out waiting for ' + what + (err ? ': ' + err.message : ''))); return; }
        setTimeout(again, 50);
      });
    }());
  }
  function offscreens(cb) {
    swEval(function () { return new Promise(function (r) { chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }, function (l) { r(l.length); }); }); }, null, cb);
  }

  steps = [
    ['tab capture: set up a headed browser that may capture without a click', function (next) {
      mediaDir = makeMedia();
      extDir = prepareExtension('ext-capture');
      serve([SITE, mediaDir], function (srv, url) {
        var profile = path.join(SCRATCH, 'profile-capture');
        server = srv;
        base = url;
        rmrf(profile);
        p(pw.chromium.launchPersistentContext(profile, {
          executablePath: chromiumPath(),
          headless: false,
          viewport: { width: 1000, height: 700 },
          args: ['--disable-extensions-except=' + extDir, '--load-extension=' + extDir, '--autoplay-policy=no-user-gesture-required', '--allowlisted-extension-id=' + extensionId(extDir)]
        }), function (err, c) {
          if (err) { next(err); return; }
          ctx = c;
          ctx.on('request', function (r) { requests.push(r.url()); });
          sw = ctx.serviceWorkers()[0];
          function go() {
            assert.strictEqual(/chrome-extension:\/\/([a-z]+)\//.exec(sw.url())[1], extensionId(extDir), 'extension id from the folder path');
            swEval(function () { return new Promise(function (resolve) { self.BO_BG.syncGenericRegistration(function () { resolve(true); }); }); }, null, function (e3) { next(e3); });
          }
          if (sw) { go(); return; }
          p(ctx.waitForEvent('serviceworker', { timeout: 15000 }), function (e2, w) { sw = w; if (e2) { next(e2); return; } go(); });
        });
      });
    }],

    ['tab capture: the tab\'s own sound is heard; impulses cover without muting the element; released after the quiet period', function (next) {
      page = ctx.pages()[0];
      p(page.goto(base + '/index.html'), function (err) {
        if (err) { next(err); return; }
        swEval(function (b) {
          return new Promise(function (resolve) { chrome.tabs.query({}, function (tabs) { resolve(tabs.filter(function (x) { return (x.url || '').indexOf(b) === 0; }).map(function (x) { return x.id; })[0]); }); });
        }, base, function (e2, id) {
          if (e2) { next(e2); return; }
          tabId = id;
          waitFor('content script', function (k) {
            swEval(function (i) { return new Promise(function (r) { chrome.tabs.sendMessage(i, { t: 'getState' }, function (s) { void chrome.runtime.lastError; r(!!(s && s.hasVideo)); }); }); }, tabId, k);
          }, 15000, function (e3) {
            if (e3) { next(e3); return; }
            swEval(function (i) { return new Promise(function (r) { self.BO_BG.liveStart(i, r); }); }, tabId, function (e4, res) {
              var covered = null;
              if (e4) { next(e4); return; }
              assert.ok(res && res.ok, 'liveStart through chrome.tabCapture: ' + JSON.stringify(res));
              log('    # tab capture started: ' + res.capture + ' at ' + res.rate + ' Hz, runtime + model loaded in ' + res.loadMs + ' ms');
              pgEval(function (b) {
                var v = document.getElementById('v');
                v.muted = false;
                window.__test.seek(33);
                return v.play().then(function () { var a = new Audio(b + '/live-burst.wav'); window.__clip = a; return a.play(); }).then(function () { return true; });
              }, base, function (e5) {
                if (e5) { next(e5); return; }
                waitFor('cover from the tab\'s sound', function (k) { look(function (e, v) { if (v && v.overlay) { covered = v; } k(e, !!covered); }); }, 12000, function (e6) {
                  if (e6) { next(e6); return; }
                  assert.strictEqual(covered.muted, false, 'the element stays unmuted: muting it would make the listener deaf');
                  assert.strictEqual(covered.tag, true, 'listening tag');
                  waitFor('release', function (k) { look(function (e, v) { k(e, v && !v.overlay); }); }, 12000, function (e7) {
                    if (e7) { next(e7); return; }
                    swEval(function () { return new Promise(function (r) { self.BO_BG.toOffscreen({ t: 'offLog' }, r); }); }, null, function (e8, lg) {
                      var fr, ev, lastLoud = null, heard;
                      if (e8) { next(e8); return; }
                      fr = lg.frames;
                      ev = lg.events;
                      heard = fr.filter(function (f) { return !f.silent; }).length;
                      assert.ok(heard >= 8, 'the tab\'s sound reaches the model: ' + heard + ' windows');
                      assert.strictEqual(ev.length, 2, JSON.stringify(ev));
                      assert.deepStrictEqual([ev[0].cover, ev[0].category, ev[1].cover], [true, 'gore', false]);
                      fr.forEach(function (f) { if (f.t <= ev[1].t && (f.gore >= 0.3 || f.sex >= 0.25)) { lastLoud = f.t; } });
                      assert.ok(ev[1].t - lastLoud >= 3 && ev[1].t - lastLoud < 3.48 + 0.01, 'released at the first window 3 s after the last loud one (' + lastLoud + ' -> ' + ev[1].t + ')');
                      log('    # tab capture: ' + heard + ' windows heard, cover at ' + ev[0].t + ' s, release at ' + ev[1].t + ' s, avg ' + lg.stats.avgMs + ' ms, max ' + lg.stats.maxMs + ' ms per window, ' + lg.stats.dropped + ' dropped');
                      next();
                    });
                  });
                });
              });
            });
          });
        });
      });
    }],

    ['tab capture: closing the tab stops listening and closes the offscreen document; nothing left 127.0.0.1', function (next) {
      p(ctx.newPage(), function (err, other) {
        if (err) { next(err); return; }
        p(page.close(), function (e2) {
          if (e2) { next(e2); return; }
          waitFor('offscreen closed', function (k) { offscreens(function (e, n) { k(e, n === 0); }); }, 5000, function (e3) {
            if (e3) { next(e3); return; }
            swEval(function (i) { return new Promise(function (r) { self.BO_BG.liveState(i, r); }); }, tabId, function (e4, ls) {
              if (e4) { next(e4); return; }
              assert.strictEqual(ls.on, false);
              assert.deepStrictEqual(requests.filter(function (u) { return !(u.indexOf(base) === 0 || /^(chrome-extension|data|blob|about):/.test(u)); }), []);
              void other;
              next();
            });
          });
        });
      });
    }]
  ];

  (function runStep(i) {
    var name, timer, finished = false;
    if (i >= steps.length) { finish(null); return; }
    name = steps[i][0];
    timer = setTimeout(function () { end(new Error('step timed out')); }, 30000);
    currentEnd = end;
    function end(err) {
      if (finished) { return; }
      finished = true;
      currentEnd = null;
      clearTimeout(timer);
      results.push([name, err]);
      log((err ? 'not ok ' : 'ok ') + 'c' + (i + 1) + ' - ' + name + (err ? '\n    ' + (err.stack || err).toString().split('\n').slice(0, 14).join('\n    ') : ''));
      if (err) { finish(err); return; }
      runStep(i + 1);
    }
    try { steps[i][1](end); } catch (e) { end(e); }
  }(0));

  function finish(err) {
    function close() { if (server) { server.close(); } done(err, results); }
    if (ctx) { p(ctx.close(), close); } else { close(); }
  }
}

/* Runs tabCaptureTest in a child process: headed, under xvfb-run when there
   is no display. -> true (passed), false (failed) or null (skipped). */
function runTabCapture() {
  var args = [__filename, '--tab-capture'], r, cmd = process.execPath, have;
  if (process.env.BO_NO_TAB_CAPTURE) { log('tab capture: skipped (BO_NO_TAB_CAPTURE)'); return null; }
  if (!process.env.DISPLAY) {
    have = cp.spawnSync('xvfb-run', ['--help'], { encoding: 'utf8' });
    if (have.error) { log('tab capture: skipped (no display and no xvfb-run; captured sound is silent in headless Chromium)'); return null; }
    args = ['-a', process.execPath].concat(args);
    cmd = 'xvfb-run';
  }
  r = cp.spawnSync(cmd, args, { stdio: 'inherit', env: process.env });
  return r.status === 0;
}

/* ---------------------------------------------------------------------- */
/* main                                                                   */
/* ---------------------------------------------------------------------- */

(function main() {
  var unitOk, pw;
  if (process.argv.indexOf('--tab-capture') >= 0) {
    pw = findPlaywright();
    if (!pw) { log('Playwright not found'); process.exit(2); }
    fs.mkdirSync(SCRATCH, { recursive: true });
    tabCaptureTest(pw, function (err, results) {
      log('tab capture test: ' + results.filter(function (r) { return !r[1]; }).length + '/' + results.length + ' steps passed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
      process.exit(err ? 1 : 0);
    });
    return;
  }
  unitOk = runUnit();
  if (process.argv.indexOf('--unit') >= 0) { process.exit(unitOk ? 0 : 1); }
  pw = findPlaywright();
  if (!pw) {
    log('Playwright not found. Install it OUTSIDE the repo, e.g.\n  mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core\n' +
      'then run: BO_PLAYWRIGHT=/tmp/pw/node_modules node extension/test/run.js');
    process.exit(2);
  }
  fs.mkdirSync(SCRATCH, { recursive: true });
  browserTest(pw, function (err, results) {
    var passed = results.filter(function (r) { return !r[1]; }).length, capture;
    log('browser test: ' + passed + '/' + results.length + ' steps passed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    capture = err ? null : runTabCapture();
    process.exit(unitOk && !err && capture !== false ? 0 : 1);
  });
}());
