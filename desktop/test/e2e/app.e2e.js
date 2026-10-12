/*
 * bonis oculis end-to-end (PLAN 8, M5): Playwright drives the real Electron app under xvfb.
 *
 *   xvfb-run -a node desktop/test/e2e/app.e2e.js
 *
 * Env: BONIS_E2E_DIR (work folder, default <tmp>/bonis-e2e), BONIS_SHOTS_DIR (screenshots,
 * default <work>/shots). Uses tools/fake-analyzer.js (no models), mpv with --vo=null --ao=null,
 * and synthetic testsrc2 videos only.
 *
 * Flow: first-run wizard in Spanish -> add two videos -> fake scan -> review (ranges, blurred
 * thumbnails and strip, approve, reject, adjust an edge, peek) -> export JSON + EDL + clean copy
 * (files asserted) -> Play in parent mode (mpv, now-playing ready) -> screenshots of every screen
 * in both languages and both themes at 1024x640 (no horizontal scroll) -> lock -> kid mode shows
 * only the protected title -> wrong PIN cooldown -> Play in kid mode -> ready -> Stop.
 * ES5: Playwright's promises are only consumed with .then through a small step runner.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var assert = require('assert');
var childProcess = require('child_process');
var playwright = require('playwright');

var ROOT = path.join(__dirname, '..', '..', '..');
var WORK = process.env.BONIS_E2E_DIR || path.join(os.tmpdir(), 'bonis-e2e');
var SHOTS = process.env.BONIS_SHOTS_DIR || path.join(WORK, 'shots');
var UD = path.join(WORK, 'userdata');
var MOVIES = path.join(WORK, 'movies');
var FFMPEG = process.env.BONIS_FFMPEG || '/usr/bin/ffmpeg';
var PIN = '2468';
var started = Date.now();

var app = null;
var page = null;
var ids = {};
var shots = [];

function log(msg) { process.stdout.write('[' + ((Date.now() - started) / 1000).toFixed(1) + 's] ' + msg + '\n'); }

function makeVideo(file, seconds, rate) {
  var r = childProcess.spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=' + rate, '-f', 'lavfi', '-i', 'sine=frequency=330',
    '-t', String(seconds), '-g', String(rate * 2), '-keyint_min', String(rate * 2), '-sc_threshold', '0', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { stdio: 'ignore' });
  if (r.status !== 0) { throw new Error('ffmpeg could not make ' + file); }
}

/* Runs steps in order; a step returns a promise (or nothing). */
function series(steps, done) {
  var i = 0;
  function next(err) {
    if (err) { done(err); return; }
    if (i >= steps.length) { done(null); return; }
    var step = steps[i++];
    var res;
    try { res = step(); } catch (e) { done(e); return; }
    if (res && typeof res.then === 'function') { res.then(function () { next(null); }, function (e) { next(e || new Error('step failed')); }); } else { next(null); }
  }
  next(null);
}

function sleep(ms) { return function () { return page.waitForTimeout(ms); }; }
function click(sel) { return function () { return page.click(sel); }; }
function waitSel(sel, opts) { return function () { return page.waitForSelector(sel, opts || { timeout: 20000 }); }; }
// page.waitForFunction needs eval, which the app's CSP (rightly) refuses: poll with evaluate.
function poll(fn, arg, timeout) {
  var limit = Date.now() + (timeout || 20000);
  return new Promise(function (resolve, reject) {
    (function tick() {
      page.evaluate(fn, arg).then(function (v) {
        if (v) { resolve(v); return; }
        if (Date.now() > limit) { reject(new Error('timed out waiting for ' + String(fn).slice(0, 160))); return; }
        setTimeout(tick, 100);
      }, reject);
    }());
  });
}
function waitText(text) {
  return function () { return poll(function (t) { return document.body.innerText.indexOf(t) >= 0; }, text); };
}
function keys(text) { return function () { return page.keyboard.type(text); }; }
function press(key) { return function () { return page.keyboard.press(key); }; }
function shot(name, keepToasts) {
  return function () {
    var file = path.join(SHOTS, name + '.png');
    shots.push(file);
    if (keepToasts) { return page.screenshot({ path: file }); }
    return page.evaluate(function () {
      var r = document.getElementById('toasts');
      while (r && r.firstChild) { r.removeChild(r.firstChild); }
    }).then(function () { return page.screenshot({ path: file }); });
  };
}
function evaluate(fn, arg) { return function () { return page.evaluate(fn, arg); }; }
function check(fn) { return fn; }

/* window.bo.invoke from the page, resolved with the {ok, error, data} answer. */
function invoke(channel, payload, onResult) {
  return function () {
    return page.evaluate(function (a) {
      return new Promise(function (resolve) { window.bo.invoke(a.c, a.p, resolve); });
    }, { c: channel, p: typeof payload === 'function' ? payload() : payload }).then(function (r) { if (onResult) { onResult(r); } });
  };
}

function waitFor(fn, arg, timeout) {
  return function () { return poll(fn, arg, timeout); };
}

function noHorizontalScroll(label) {
  return function () {
    return page.evaluate(function () {
      var bad = [];
      var nodes = [document.documentElement, document.body].concat(Array.prototype.slice.call(document.querySelectorAll('.bo-main, [data-view]:not([hidden]), .bo-review__main, .bo-panel__scroll, .bo-settings__content')));
      nodes.forEach(function (n) {
        if (n.offsetParent === null && n !== document.body && n !== document.documentElement) { return; }
        if (n.scrollWidth > n.clientWidth + 1) { bad.push((n.className || n.tagName) + ' ' + n.scrollWidth + '>' + n.clientWidth); }
      });
      return bad;
    }).then(function (bad) { assert.deepStrictEqual(bad, [], 'horizontal scroll in ' + label); });
  };
}

function noModal() {
  return function () {
    return page.$('.bo-modal').then(function (m) { assert.strictEqual(m, null, 'Escape closes the modal'); });
  };
}

// D8 / D18: nothing but blurred thumbnails (and a sharp poster only for a Protected, clean frame) on disk.
function imagesOnDisk() {
  var found = [];
  (function walk(d) {
    fs.readdirSync(d).forEach(function (n) {
      var f = path.join(d, n);
      var st = fs.lstatSync(f);
      if (st.isSymbolicLink()) { return; }
      if (st.isDirectory()) { walk(f); } else if (/\.(png|jpe?g|bmp|webp)$/i.test(n)) { found.push(path.relative(UD, f)); }
    });
  }(UD));
  found.forEach(function (f) {
    assert.ok(/^work\/[0-9a-f]{16}\/(thumbs\/r[0-9a-z]+\.jpg|strip\/\d+-\d+\.jpg|poster-blur\.jpg|poster-clear\.jpg)$/.test(f.replace(/\\/g, '/')), 'unexpected image on disk: ' + f);
    if (/poster-clear/.test(f)) { assert.ok(f.indexOf(ids['Family Picnic']) >= 0, 'sharp poster only for the protected title'); }
  });
  assert.ok(!found.some(function (f) { return /\.png$/.test(f); }), 'peek frames are never written');
  return found.length;
}

function setLang(lang) {
  return function () {
    return page.evaluate(function (l) {
      return new Promise(function (resolve) {
        window.bo.invoke('settings:set', { patch: { lang: l } }, function (r) {
          window.BO.store.set('settings', r.data.settings);
          if (r.data.strings) { window.BO.i18n.set(r.data.strings, l); }
          resolve();
        });
      });
    }, lang);
  };
}

function setTheme(theme) { return evaluate(function (t) { document.documentElement.setAttribute('data-theme', t); }, theme); }

function go(view, params) {
  return function () {
    return page.evaluate(function (a) { window.BO.router.go(a.v, a.p); }, { v: view, p: (typeof params === 'function' ? params() : params) || {} });
  };
}

function resize(w, h) {
  return function () {
    return app.evaluate(function (electron, size) {
      var win = electron.BrowserWindow.getAllWindows()[0];
      win.setSize(size[0], size[1]);
    }, [w, h]).then(function () { return page.waitForTimeout(250); });
  };
}

function mockOpenDialog(files) {
  return function () {
    return app.evaluate(function (electron, list) {
      electron.dialog.showOpenDialog = function () { return Promise.resolve({ canceled: false, filePaths: list }); };
    }, files);
  };
}

function rangeSel(i) { return '.bo-range-list li:nth-child(' + (i + 1) + ') .bo-range-row'; }

function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(MOVIES, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  var picnic = path.join(MOVIES, 'Family Picnic (2019).mp4');
  var river = path.join(MOVIES, 'River Trip.mp4');
  makeVideo(picnic, 60, 25);
  makeVideo(river, 30, 25);
  log('fixtures ready');
  var env = {};
  Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
  env.BONIS_USER_DATA = UD;
  env.BONIS_QUIET = '1';
  env.BONIS_PLAYER_VO = 'null';
  env.BONIS_PLAYER_AO = 'null';
  env.BONIS_ANALYZER = JSON.stringify({ cmd: process.execPath, args: [path.join(ROOT, 'tools', 'fake-analyzer.js')] });
  env.LANG = 'en_US.UTF-8';
  var args = [ROOT];
  if (process.getuid && process.getuid() === 0) { args.unshift('--no-sandbox'); }
  var recovery = null;
  var docBefore = null;

  var steps = [
    function () { return playwright._electron.launch({ args: args, env: env }).then(function (a) { app = a; return a.firstWindow(); }).then(function (p) { page = p; page.on('pageerror', function (e) { log('PAGE ERROR ' + e.message); }); }); },
    resize(1024, 640),
    waitSel('[data-lang="es-MX"]'),
    // ---- first run, in Spanish
    click('[data-lang="es-MX"]'),
    waitText('Te damos la bienvenida'),
    shot('es-light-setup-1-language'),
    click('[data-action="continue"]'),
    waitText('Elige un PIN para adultos'),
    shot('es-light-setup-2-pin'),
    keys(PIN), press('Enter'),
    waitText('Escribe el mismo PIN otra vez'),
    keys('1357'), press('Enter'),
    waitText('Los dos PIN no son iguales'),
    shot('es-light-setup-2-pin-mismatch'),
    keys(PIN), press('Enter'), keys(PIN), press('Enter'),
    waitText('Tu código de recuperación'),
    function () { return page.textContent('.bo-code__value').then(function (t) { recovery = t; assert.match(t, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/); }); },
    function () { return page.isDisabled('[data-action="code-continue"]').then(function (d) { assert.ok(d, 'Continue waits for "I wrote it down"'); }); },
    shot('es-light-setup-3-code'),
    click('.bo-code .bo-switch'),
    click('[data-action="code-continue"]'),
    waitText('¿Cuánto debemos omitir?'),
    click('[data-preset="custom"]'),
    shot('es-light-setup-4-preset-custom'),
    click('[data-preset="little-kids"]'),
    click('[data-action="continue"]'),
    waitText('Agrega tu primera película'),
    shot('es-light-setup-5-movie'),
    mockOpenDialog([picnic, river]),
    click('.bo-dropzone'),
    // ---- library + fake scan
    waitText('Biblioteca'),
    waitFor(function () { return document.querySelectorAll('.bo-title-card[data-status="needsReview"]').length === 2; }, null, 30000),
    invoke('library:list', {}, function (r) {
      r.data.forEach(function (it) { ids[it.title] = it.id; });
      assert.ok(ids['Family Picnic'], 'title parsed from the file name');
      assert.strictEqual(r.data.filter(function (it) { return it.year === 2019; }).length, 1);
    }),
    shot('es-light-library-toasts', true),
    noHorizontalScroll('library'),
    // ---- review
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="review"]'); },
    waitSel('.bo-range'),
    function () { return page.$$eval('.bo-range', function (n) { return n.length; }).then(function (n) { assert.strictEqual(n, 3, 'three ranges on the timeline'); }); },
    waitFor(function () { return document.querySelectorAll('.bo-strip-tile__img').length >= 20; }, null, 30000),
    shot('es-light-review-overview'),
    click(rangeSel(0)),
    waitSel('.bo-panel .bo-thumb__img'),
    function () { return page.$eval('.bo-panel .bo-thumb__img', function (img) { return img.src.slice(0, 22); }).then(function (s) { assert.strictEqual(s, 'data:image/jpeg;base64', 'blurred thumbnail from the scan'); }); },
    shot('es-light-review-panel'),
    noHorizontalScroll('review'),
    // peek: PIN entered at setup is fresh (5 minutes)
    function () { return page.hover('.bo-peek'); },
    function () { return page.mouse.down(); },
    waitSel('.bo-thumb.is-peeking'),
    shot('es-light-review-peek'),
    function () { return page.mouse.up(); },
    waitFor(function () { return !document.querySelector('.bo-thumb.is-peeking'); }),
    function () { return page.$eval('.bo-panel .bo-thumb__img', function (img) { return img.src.slice(0, 22); }).then(function (s) { assert.strictEqual(s, 'data:image/jpeg;base64', 'back to the blurred file after release'); }); },
    function () { return invoke('skip:get', { id: ids['Family Picnic'] }, function (r) { docBefore = r.data.doc; })(); },
    click('[data-act="approve"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range.is-approved').length === 1; }),
    waitFor(function () { return document.querySelector('.bo-range-list li:nth-child(2) .bo-range-row.is-selected'); }),
    click('[data-act="reject"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range.is-rejected').length === 1; }),
    click(rangeSel(2)),
    click('[data-nudge="end+0.5"]'),
    sleep(400),
    function () { return page.focus('.bo-range.is-selected .bo-handle--start'); },
    press('ArrowRight'),
    sleep(400),
    function () {
      return invoke('skip:get', { id: ids['Family Picnic'] }, function (r) {
        var d = r.data.doc;
        assert.strictEqual(d.ranges[0].review, 'approved', 'approved');
        assert.strictEqual(d.ranges[1].review, 'rejected', 'rejected');
        assert.strictEqual(d.ranges[2].end, Math.round((docBefore.ranges[2].end + 0.5) * 1000) / 1000, 'end moved +0.5 s');
        assert.strictEqual(d.ranges[2].start, Math.round((docBefore.ranges[2].start + 0.5) * 1000) / 1000, 'start moved +0.5 s with the keyboard');
        assert.ok(d.history.some(function (e) { return e.event === 'edited'; }));
      })();
    },
    click('[data-act="approve"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range.is-pending').length === 0; }),
    waitFor(function () { return document.querySelector('.bo-review__summary .bo-pill--protected'); }),
    shot('es-light-review-done'),
    // ---- export: JSON + EDL + clean copy
    click('[data-act="back"]'),
    click('[data-nav="export"]'),
    waitSel('[data-act="export-json"]'),
    function () { return page.selectOption('select[data-act="movie"]', ids['Family Picnic']); },
    click('[data-act="export-json"]'),
    waitFor(function () { return document.body.innerText.indexOf('Se guardó el archivo de escenas') >= 0; }),
    click('[data-act="export-edl"]'),
    waitFor(function () { return document.body.innerText.indexOf('Se guardó la lista para Kodi') >= 0; }),
    function () {
      var jsonFile = path.join(MOVIES, 'Family Picnic (2019).bonis.json');
      var edlFile = path.join(MOVIES, 'Family Picnic (2019).edl');
      assert.ok(fs.existsSync(jsonFile), 'skip file next to the movie');
      assert.ok(fs.existsSync(edlFile), 'Kodi list next to the movie');
      var BO = require(path.join(ROOT, 'shared', 'skipfile.js'));
      var parsed = BO.fromJson(fs.readFileSync(jsonFile, 'utf8'));
      assert.ok(parsed.ok, 'exported skip file validates');
      assert.strictEqual(parsed.doc.ranges.length, 3);
      var lines = fs.readFileSync(edlFile, 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 2, 'the rejected scene is not in the Kodi list');
      lines.forEach(function (l) { assert.match(l, /^\d+\.\d\d \d+\.\d\d 0$/); });
    },
    click('[data-act="export-clean"]'),
    waitFor(function () { return document.body.innerText.indexOf('La copia limpia está lista') >= 0; }, null, 60000),
    function () { assert.ok(fs.existsSync(path.join(MOVIES, 'Family Picnic (2019) (bonis oculis clean).mp4')), 'clean copy next to the movie'); },
    shot('es-light-export'),
    // ---- play in parent mode: mpv starts, the now-playing panel reaches "ready"
    click('[data-nav="library"]'),
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="play"]'); },
    waitSel('.bo-nowplaying'),
    waitSel('.bo-nowplaying__state[data-state="playing"]', { timeout: 30000 }),
    waitText('Reproduciendo en su propia ventana'),
    shot('es-light-nowplaying'),
    setTheme('dark'), shot('es-dark-nowplaying'),
    setLang('en-US'), shot('en-dark-nowplaying'),
    setTheme('light'), shot('en-light-nowplaying'),
    setLang('es-MX'),
    click('[data-act="stop"]'),
    waitSel('[data-view="library"]:not([hidden])', { timeout: 20000 })
  ];

  // ---- every screen, both languages, both themes, at the 1024x640 minimum
  [['es-MX', 'es'], ['en-US', 'en']].forEach(function (L) {
    ['light', 'dark'].forEach(function (theme) {
      var p = L[1] + '-' + theme + '-';
      steps.push(setLang(L[0]), setTheme(theme));
      steps.push(go('setup', { step: 'language' }), sleep(150), shot(p + 'setup-1-language'));
      steps.push(go('setup', { step: 'preset' }), sleep(150), shot(p + 'setup-4-preset'));
      steps.push(go('library'), sleep(500), shot(p + 'library'), noHorizontalScroll(p + 'library'));
      steps.push(function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="more"]'); }, sleep(150), shot(p + 'library-menu'), press('Escape'));
      steps.push(go('review', function () { return { id: ids['River Trip'] }; }), waitSel('.bo-range'), sleep(600), shot(p + 'review-overview'), noHorizontalScroll(p + 'review'));
      steps.push(function () { return page.click(rangeSel(0)); }, waitSel('.bo-panel .bo-thumb'), sleep(200), shot(p + 'review-panel'), noHorizontalScroll(p + 'review-panel'));
      steps.push(function () { return page.$eval('.bo-panel__scroll', function (n) { n.scrollTop = n.scrollHeight; }); }, sleep(100), shot(p + 'review-panel-edges'));
      steps.push(go('settings'), sleep(400), shot(p + 'settings-protection'), noHorizontalScroll(p + 'settings'));
      steps.push(click('[data-section="playback"]'), sleep(200), shot(p + 'settings-playback'));
      steps.push(click('[data-section="privacy"]'), sleep(200), shot(p + 'settings-privacy'));
      steps.push(click('[data-section="about"]'), sleep(400), shot(p + 'settings-about'));
      steps.push(go('export', function () { return { id: ids['Family Picnic'] }; }), sleep(300), shot(p + 'export'), noHorizontalScroll(p + 'export'));
      steps.push(go('help'), sleep(400), shot(p + 'help'), noHorizontalScroll(p + 'help'));
      steps.push(go('help', { anchor: 'tv' }), sleep(300), shot(p + 'help-tv'));
      steps.push(evaluate(function () { document.documentElement.setAttribute('data-mode', 'kid'); window.BO.router.go('kid'); }), sleep(600), shot(p + 'kid'), noHorizontalScroll(p + 'kid'));
      steps.push(evaluate(function () { window.BO.pinPad.ask({ purpose: 'peek' }, function () {}); }), sleep(300), shot(p + 'kid-pin'), press('Escape'), sleep(100), noModal());
      steps.push(evaluate(function () { document.documentElement.removeAttribute('data-mode'); window.BO.router.go('library'); }), sleep(200));
    });
  });

  // ---- a wide window too
  steps.push(setLang('es-MX'), setTheme('light'), resize(1600, 1000), go('library'), sleep(500), shot('es-light-1600-library'),
    go('review', function () { return { id: ids['River Trip'] }; }), waitSel('.bo-range'), sleep(500), function () { return page.click(rangeSel(0)); }, sleep(300), shot('es-light-1600-review'),
    go('settings'), sleep(300), shot('es-light-1600-settings'), resize(1024, 640));

  // ---- lock: kid mode with only the protected title; wrong PIN cooldown; play; stop
  steps.push(
    setLang('es-MX'), setTheme('light'), go('library'), sleep(300),
    click('[data-nav="lock"]'),
    waitSel('.bo-kid__grid .bo-play-tile'),
    function () { return page.$$eval('.bo-kid__grid .bo-play-tile', function (n) { return n.map(function (x) { return x.getAttribute('data-id'); }); }).then(function (list) { assert.deepStrictEqual(list, [ids['Family Picnic']], 'only the protected title'); }); },
    invoke('library:list', {}, function (r) { assert.strictEqual(r.data.length, 1, 'main serves only protected titles while locked'); }),
    invoke('settings:set', { patch: { lockOnStart: false } }, function (r) { assert.strictEqual(r.error, 'locked'); }),
    invoke('skip:get', function () { return { id: ids['River Trip'] }; }, function (r) { assert.strictEqual(r.error, 'locked'); }),
    invoke('player:play', function () { return { id: ids['River Trip'], kidMode: false }; }, function (r) { assert.strictEqual(r.error, 'kidRefused', 'kid mode never plays an unprotected title'); }),
    shot('es-light-kid-locked'),
    click('[data-act="parent"]'),
    waitSel('.bo-modal .bo-pin'),
    keys('1111'), press('Enter'), sleep(250), keys('1111'), press('Enter'), sleep(250), keys('1111'), press('Enter'), sleep(250),
    keys('1111'), press('Enter'), sleep(250),
    waitText('Te queda 1 intento'),
    keys('1111'), press('Enter'),
    waitText('Demasiados intentos. Espera'),
    shot('es-light-kid-pin-cooldown'),
    keys(PIN), press('Enter'), sleep(300),
    invoke('pin:status', {}, function (r) { assert.ok(r.data.locked, 'still locked: keys were disabled'); assert.ok(r.data.cooldownMs > 20000); }),
    press('Escape'),
    function () { return page.click('.bo-kid__grid .bo-play-tile'); },
    waitSel('.bo-nowplaying__state[data-state="playing"]', { timeout: 30000 }),
    function () { return page.$('.bo-nowplaying__marks').then(function (m) { assert.strictEqual(m, null, 'no marking section in kid mode'); }); },
    shot('es-light-kid-nowplaying'),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.kidMode, true); assert.notStrictEqual(r.data.state, 'idle'); }),
    click('[data-act="stop"]'),
    waitSel('[data-view="kid"]:not([hidden])', { timeout: 20000 }),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.state, 'idle', 'mpv stopped'); }),
    function () { log('images on disk, all blurred or proven clean: ' + imagesOnDisk()); },
    function () { return app.close(); }
  );

  series(steps, function (err) {
    if (err) {
      log('FAILED: ' + (err && err.stack ? err.stack : err));
      var p = page ? page.screenshot({ path: path.join(SHOTS, 'FAILURE.png') }).then(null, function () {}) : null;
      function quit() { if (app) { app.close().then(function () { process.exit(1); }, function () { process.exit(1); }); } else { process.exit(1); } }
      if (p) { p.then(quit, quit); } else { quit(); }
      return;
    }
    log('e2e passed: ' + shots.length + ' screenshots in ' + SHOTS);
    process.exit(0);
  });
}

main();
