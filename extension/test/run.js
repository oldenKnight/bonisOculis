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
  return dir;
}

var TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.vtt': 'text/vtt; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };

function serve(roots, cb) {
  var server = http.createServer(function (req, res) {
    var name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html', file = null, i, stat, range, m, start, end;
    if (name.indexOf('..') >= 0) { res.writeHead(400); res.end(); return; }
    if (name === 'favicon.ico') { res.writeHead(204); res.end(); return; }
    for (i = 0; i < roots.length; i++) { if (fs.existsSync(path.join(roots[i], name))) { file = path.join(roots[i], name); break; } }
    if (!file) { res.writeHead(404); res.end(); return; }
    stat = fs.statSync(file);
    range = req.headers.range;
    m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      res.writeHead(206, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', function () { cb(server, 'http://127.0.0.1:' + server.address().port); });
}

/* The test copy grants <all_urls> at install (instead of the optional
   permission prompt a parent would answer), so the service worker registers
   the generic adapter exactly as it does after the parent says yes. */
function prepareExtension() {
  var dir = path.join(SCRATCH, 'ext'), mf;
  rmrf(dir);
  copyDir(EXT, dir, ['test', 'tools', 'README.md']);
  mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.host_permissions.push('<all_urls>');
  delete mf.optional_host_permissions;
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
  var results = [], requests = [], pageErrors = [], steps, mediaDir, extDir, skipFile, pageRanges = null;

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

    ['never left covered or muted; no request left 127.0.0.1; no page errors', function (next) {
      play(56.5, function (err) {
        if (err) { next(err); return; }
        sleep(600, function () {
          video(function (e2, v) {
            if (e2) { next(e2); return; }
            assert.strictEqual(v.overlay, false);
            assert.strictEqual(v.muted, false);
            var outside = requests.filter(function (u) { return !(u.indexOf(base) === 0 || /^(chrome-extension|data|blob|about):/.test(u)); });
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
/* main                                                                   */
/* ---------------------------------------------------------------------- */

(function main() {
  var unitOk = runUnit(), pw;
  if (process.argv.indexOf('--unit') >= 0) { process.exit(unitOk ? 0 : 1); }
  pw = findPlaywright();
  if (!pw) {
    log('Playwright not found. Install it OUTSIDE the repo, e.g.\n  mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright-core\n' +
      'then run: BO_PLAYWRIGHT=/tmp/pw/node_modules node extension/test/run.js');
    process.exit(2);
  }
  fs.mkdirSync(SCRATCH, { recursive: true });
  browserTest(pw, function (err, results) {
    var passed = results.filter(function (r) { return !r[1]; }).length;
    log('browser test: ' + passed + '/' + results.length + ' steps passed in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    process.exit(unitOk && !err ? 0 : 1);
  });
}());
