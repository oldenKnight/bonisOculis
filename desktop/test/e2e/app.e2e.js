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

// srt: optional subtitle file muxed in as mov_text (the clean copy leaves subtitles out and says so).
function makeVideo(file, seconds, rate, srt) {
  var subIn = srt ? ['-i', srt] : [];
  var subOut = srt ? ['-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:s', 'mov_text'] : [];
  var r = childProcess.spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=' + rate, '-f', 'lavfi', '-i', 'sine=frequency=330'].concat(subIn,
    ['-t', String(seconds), '-g', String(rate * 2), '-keyint_min', String(rate * 2), '-sc_threshold', '0', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac'], subOut, srt ? [file] : ['-shortest', file]), { stdio: 'ignore' });
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
    if (/poster-clear/.test(f)) { assert.ok(f.indexOf(ids['Family Picnic']) >= 0 || f.indexOf(ids.garden) >= 0 || f.indexOf(ids.lake) >= 0, 'sharp poster only for protected titles'); }
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

// Board decision 5: toasts never cover the review panel's buttons.
function toastClearOfPanel(label) {
  return function () {
    return poll(function () { return document.querySelectorAll('#toasts .bo-toast').length > 0; }, null, 5000).then(function () { return page.evaluate(function () {
      var toasts = Array.prototype.slice.call(document.querySelectorAll('#toasts .bo-toast')).map(function (n) { return n.getBoundingClientRect(); });
      var btns = Array.prototype.slice.call(document.querySelectorAll('.bo-panel__footer button, .bo-panel__footer [data-act]')).map(function (n) { return n.getBoundingClientRect(); });
      var hits = [];
      toasts.forEach(function (t) {
        btns.forEach(function (b) {
          if (b.width && b.height && t.left < b.right && b.left < t.right && t.top < b.bottom && b.top < t.bottom) { hits.push([t.left, t.top, t.right, t.bottom, b.left, b.top, b.right, b.bottom].map(Math.round).join(',')); }
        });
      });
      var region = document.getElementById('toasts');
      return { toasts: toasts.length, buttons: btns.length, hits: hits, pe: region ? getComputedStyle(region).pointerEvents : '', tpe: toasts.length ? getComputedStyle(document.querySelector('#toasts .bo-toast')).pointerEvents : 'none' };
    }); }).then(function (r) {
      assert.ok(r.toasts >= 1, label + ': a toast is showing');
      assert.ok(r.buttons >= 2, label + ': panel buttons found');
      assert.deepStrictEqual(r.hits, [], label + ': toast overlaps a panel button');
      assert.strictEqual(r.tpe, 'none', 'only the toast buttons take the pointer');
    });
  };
}

// Round 2, X1: category names in the parents card never break inside a word.
function namesWhole(label) {
  return function () {
    return page.$$eval('.bo-parents-row__name, .bo-preplay__cat', function (nodes) {
      return nodes.filter(function (n) {
        var r = document.createRange();
        r.selectNodeContents(n);
        var tops = {};
        Array.prototype.forEach.call(r.getClientRects(), function (q) { if (q.width > 1) { tops[Math.round(q.top)] = true; } });
        return n.textContent.indexOf(' ') < 0 && Object.keys(tops).length > 1;
      }).map(function (n) { return n.textContent; });
    }).then(function (broken) { assert.deepStrictEqual(broken, [], label + ': category names broken mid-word'); });
  };
}

function activeAct() { return page.evaluate(function () { return document.activeElement ? document.activeElement.getAttribute('data-act') : null; }); }

// Presses keys in the running mpv over its own IPC socket, as a parent at the keyboard would.
function mpvKeys(list, gapMs) {
  return function () {
    return page.evaluate(function () { return new Promise(function (res) { window.bo.invoke('player:status', {}, res); }); }).then(function (r) {
      assert.ok(r.data && r.data.ipcPath, 'test hook: mpv IPC socket');
      return new Promise(function (resolve, reject) {
        var sock = require('net').connect(r.data.ipcPath);
        var i = 0;
        sock.on('error', reject);
        sock.on('connect', function next() {
          if (i >= list.length) { sock.end(); setTimeout(resolve, 300); return; }
          sock.write(JSON.stringify({ command: ['keypress', list[i++]] }) + '\n');
          setTimeout(next, gapMs || 1200);
        });
      });
    });
  };
}

// X6: no visible library button sits under a toast.
function buttonsClearOfToasts(label) {
  return function () {
    return page.evaluate(function () {
      var toasts = Array.prototype.map.call(document.querySelectorAll('#toasts .bo-toast'), function (n) { return n.getBoundingClientRect(); });
      var main = document.getElementById('main').getBoundingClientRect();
      var hits = [];
      Array.prototype.forEach.call(document.querySelectorAll('.bo-title-card button'), function (b) {
        var r = b.getBoundingClientRect();
        var top = Math.max(r.top, main.top), bottom = Math.min(r.bottom, main.bottom);
        if (bottom <= top || !r.width) { return; } // scrolled out of the visible area
        toasts.forEach(function (t) {
          if (r.left < t.right && t.left < r.right && top < t.bottom && t.top < bottom) { hits.push((b.getAttribute('data-act') || b.textContent).slice(0, 30)); }
        });
      });
      return { toasts: toasts.length, hits: hits };
    }).then(function (r) {
      assert.strictEqual(r.toasts, 2, label + ': two toasts showing');
      assert.deepStrictEqual(r.hits, [], label + ': buttons under a toast');
    });
  };
}

function rangeSel(i) { return '.bo-range-list li:nth-child(' + (i + 1) + ') .bo-range-row'; }

function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(MOVIES, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  var picnic = path.join(MOVIES, 'Family Picnic (2019).mp4');
  var river = path.join(MOVIES, 'River Trip.mp4');
  var srt = path.join(WORK, 'picnic.srt');
  fs.writeFileSync(srt, '1\n00:00:02,000 --> 00:00:04,000\nHello there.\n\n2\n00:00:30,000 --> 00:00:32,000\nLook at the lake.\n');
  makeVideo(picnic, 60, 25, srt);
  makeVideo(river, 30, 25);
  var garden = path.join(MOVIES, 'Garden Walk [clean].mp4');
  makeVideo(garden, 20, 25);
  var lake = path.join(MOVIES, 'Lake Day.mp4');
  makeVideo(lake, 12, 25);
  // A bundled-files tree (board A9, security round 2 N3). At first run one licence text is damaged:
  // the banner names it but nothing stops. Later a model is damaged and "Check installed files"
  // finds it: scans stop.
  var RES = path.join(WORK, 'resources');
  fs.mkdirSync(path.join(RES, 'models'), { recursive: true });
  fs.mkdirSync(path.join(RES, 'bin', 'licenses'), { recursive: true });
  fs.writeFileSync(path.join(RES, 'models', 'good.onnx'), 'good model bytes');
  fs.writeFileSync(path.join(RES, 'models', 'nsfw-vit-int8.onnx'), 'original model bytes');
  fs.writeFileSync(path.join(RES, 'bin', 'licenses', 'GPL-3.0.txt'), 'changed licence');
  var sha = function (t) { return require('crypto').createHash('sha256').update(t).digest('hex'); };
  fs.writeFileSync(path.join(RES, 'models', 'manifest.json'), JSON.stringify({ files: [
    { file: 'good.onnx', sha256: sha('good model bytes'), size: 16 }, { file: 'nsfw-vit-int8.onnx', sha256: sha('original model bytes'), size: 20 }] }));
  fs.writeFileSync(path.join(RES, 'bin', 'binaries.lock.json'), JSON.stringify({ files: { 'licenses/GPL-3.0.txt': { sha256: sha('the licence'), size: 11 } } }));
  log('fixtures ready');
  var env = {};
  Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
  env.BONIS_USER_DATA = UD;
  env.BONIS_QUIET = '1';
  env.BONIS_PLAYER_VO = 'null';
  env.BONIS_PLAYER_AO = 'null';
  env.BONIS_ANALYZER = JSON.stringify({ cmd: process.execPath, args: [path.join(ROOT, 'tools', 'fake-analyzer.js')] });
  env.LANG = 'en_US.UTF-8';
  env.BONIS_VERIFY_RESOURCES = RES;
  env.BONIS_TEST_HOOKS = '1'; // player:status reports mpv's IPC socket, so keys can be pressed in the player
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
    // round 3, N2.2: the code can be saved as a text file (to print or keep)
    function () {
      return app.evaluate(function (electron, f) { electron.dialog.showSaveDialog = function () { return Promise.resolve({ canceled: false, filePath: f }); }; }, path.join(WORK, 'recovery.txt'));
    },
    click('[data-action="save-code"]'),
    waitText('Se guardó el código de recuperación'),
    function () {
      var t = fs.readFileSync(path.join(WORK, 'recovery.txt'), 'utf8');
      assert.ok(t.indexOf(recovery) > 0 && t.indexOf('Olvidé mi PIN') > 0, 'the code and what to do with it');
    },
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
    waitSel('[data-banner="integrity"]'),
    waitText('Requiere atención: un archivo incluido está dañado.'),
    waitText('bin/licenses/GPL-3.0.txt'),
    shot('es-light-library-integrity'),
    // ---- review
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="review"]'); },
    waitSel('.bo-range'),
    function () { return page.$$eval('.bo-range', function (n) { return n.length; }).then(function (n) { assert.strictEqual(n, 3, 'three ranges on the timeline'); }); },
    waitFor(function () { return document.querySelectorAll('.bo-strip-tile__img').length >= 20; }, null, 30000),
    shot('es-light-review-overview'),
    // round 3, P3: a strength filter on the list (fake scan: nudity strong, gore moderate, kissing mild)
    click('[data-intensity="strong"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range-list .bo-range-row').length === 1; }),
    click('[data-intensity="moderate"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range-list .bo-range-row').length === 2; }),
    shot('es-light-review-filter'),
    click('[data-intensity="all"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range-list .bo-range-row').length === 3; }),
    // round 3, N3: "?" opens the key sheet
    function () { return page.focus('[data-act="back"]'); },
    press('?'),
    waitSel('.bo-modal .bo-hotkeys'),
    waitText('Escena siguiente o anterior'),
    sleep(300), shot('es-light-key-sheet'),
    press('Escape'), noModal(),
    // round 2, X2: nobody has checked this yet, and the card says so
    waitSel('.bo-parents-card__footer [data-footer="unchecked"]'),
    waitText('ningún adulto las ha revisado todavía'),
    namesWhole('es review overview'),
    // decision 6: with Kissing at Light, the 0.66 kissing scene is below the level and says so
    invoke('settings:set', { patch: { levels: { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'light', gore: 'strict', language: 'strict' } } }, function (r) { assert.ok(r.ok); }),
    evaluate(function () { return new Promise(function (res) { window.bo.invoke('settings:get', {}, function (r) { window.BO.store.set('settings', r.data); res(); }); }); }),
    click(rangeSel(1)),
    waitSel('.bo-panel [data-below]'),
    waitText('Por debajo de tu nivel de Besos: se verá a menos que la omitas'),
    function () { return page.$eval(rangeSel(1), function (n) { return n.textContent; }).then(function (t) { assert.ok(/debajo de tu nivel/i.test(t), 'the list says it too: ' + t); }); },
    shot('es-light-review-below'),
    invoke('settings:set', { patch: { preset: 'little-kids' } }, function (r) { assert.ok(r.ok); }),
    evaluate(function () { return new Promise(function (res) { window.bo.invoke('settings:get', {}, function (r) { window.BO.store.set('settings', r.data); res(); }); }); }),
    click(rangeSel(0)),
    // decision 14: picking a scene moves the keyboard to the panel's first action
    function () { return activeAct().then(function (a) { assert.strictEqual(a, 'approve', 'focus on "Skip this scene"'); }); },
    waitSel('.bo-review__keys'),
    waitSel('.bo-panel .bo-thumb__img'),
    function () { return page.$eval('.bo-panel .bo-thumb__img', function (img) { return img.src.slice(0, 22); }).then(function (s) { assert.strictEqual(s, 'data:image/jpeg;base64', 'blurred thumbnail from the scan'); }); },
    shot('es-light-review-panel'),
    noHorizontalScroll('review'),
    // peek: only a PIN typed for peeking opens it (board A10), then the real frame while held
    function () { return page.hover('.bo-peek'); },
    function () { return page.mouse.down(); },
    waitSel('.bo-modal .bo-pin'),
    function () { return page.mouse.up(); },
    keys(PIN), press('Enter'),
    waitFor(function () { return !document.querySelector('.bo-modal'); }),
    function () { return page.hover('.bo-peek'); },
    function () { return page.mouse.down(); },
    waitSel('.bo-thumb.is-peeking'),
    shot('es-light-review-peek'),
    function () { return page.mouse.up(); },
    waitFor(function () { return !document.querySelector('.bo-thumb.is-peeking'); }),
    function () { return page.$eval('.bo-panel .bo-thumb__img', function (img) { return img.src.slice(0, 22); }).then(function (s) { assert.strictEqual(s, 'data:image/jpeg;base64', 'back to the blurred file after release'); }); },
    function () { return invoke('skip:get', { id: ids['Family Picnic'] }, function (r) { docBefore = r.data.doc; })(); },
    // decision 14: S skips, then the next scene is selected with focus on its first action
    function () { return page.focus('[data-act="approve"]'); },
    press('s'),
    waitFor(function () { return document.querySelectorAll('.bo-range.is-approved').length === 1; }),
    waitFor(function () { return document.querySelector('.bo-range-list li:nth-child(2) .bo-range-row.is-selected'); }),
    function () { return activeAct().then(function (a) { assert.strictEqual(a, 'approve', 'focus moved to the next scene\'s first action'); }); },
    toastClearOfPanel('after Skip'),
    sleep(400),
    shot('es-light-review-toast', true),
    press('n'),
    waitFor(function () { return document.querySelector('.bo-range-list li:nth-child(3) .bo-range-row.is-selected'); }),
    press('p'),
    waitFor(function () { return document.querySelector('.bo-range-list li:nth-child(2) .bo-range-row.is-selected'); }),
    press('l'),
    waitFor(function () { return document.querySelectorAll('.bo-range.is-rejected').length === 1; }),
    toastClearOfPanel('after Let it play'),
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
    function () { return page.focus('.bo-range.is-selected .bo-handle--start'); },
    press('Home'),
    sleep(400),
    function () {
      return invoke('skip:get', { id: ids['Family Picnic'] }, function (r) {
        var rr = r.data.doc.ranges[2];
        assert.strictEqual(rr.start, Math.floor(docBefore.ranges[2].start / 5) * 5, 'Home jumps to the scene cut before the edge');
      })();
    },
    click('[data-act="approve"]'),
    waitFor(function () { return document.querySelectorAll('.bo-range.is-pending').length === 0; }),
    waitFor(function () { return document.querySelector('.bo-review__summary .bo-pill--protected'); }),
    shot('es-light-review-done'),
    function () { return page.click('[data-act="back"]').then(function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="more"]'); }); },
    click('[data-menu="review"]'),
    waitSel('.bo-parents-card__footer [data-footer="checked"]'),
    waitText('y las revisaste el'),
    shot('es-light-review-checked'),
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
    // third batch: the exact re-encode asks first, with the measured time and what is left out
    click('[data-act="export-clean"]'),
    waitSel('.bo-modal [data-estimate]'),
    waitText('¿Hacer una copia limpia?'),
    waitFor(function () { var n = document.querySelector('.bo-modal [data-estimate] strong'); return n && /Más o menos/.test(n.textContent); }, null, 60000),
    waitSel('.bo-modal [data-note="subtitles"]'),
    waitText('Los subtítulos no se incluyen en la copia limpia'),
    function () { return page.$('.bo-modal [data-setting="aac"]').then(function (n) { assert.strictEqual(n, null, 'no AAC switch: audio is always AAC'); }); },
    shot('es-light-clean-confirm'),
    click('.bo-modal [data-action="ok"]'),
    waitFor(function () { return document.body.innerText.indexOf('La copia limpia está lista') >= 0 || !!document.querySelector('[data-progress]'); }, null, 60000),
    function () { return page.$('[data-progress]').then(function (n) { return n ? page.textContent('[data-progress]').then(function (t) { assert.match(t, /^Haciendo la copia… \d+%/); }) : null; }); },
    waitFor(function () { return document.body.innerText.indexOf('La copia limpia está lista') >= 0; }, null, 120000),
    function () { assert.ok(fs.existsSync(path.join(MOVIES, 'Family Picnic (2019) (bonis oculis clean).mp4')), 'clean copy next to the movie'); },
    shot('es-light-export'),
    // ---- check accuracy against a hand-marked file (mocked file dialog)
    invoke('library:list', {}, function (r) {
      var it = r.data.filter(function (x) { return x.id === ids['Family Picnic']; })[0];
      var BO = require(path.join(ROOT, 'shared', 'skipfile.js'));
      var truth = BO.newDoc({
        media: { title: 'Family Picnic', duration: 60, fingerprint: { size: it.size, oshash: it.oshash } },
        ranges: [BO.newRange({ id: 'rhand0001', start: 11, end: 16, category: 'nudity', review: 'approved' }),
          BO.newRange({ id: 'rhand0002', start: 26, end: 30, category: 'kissing', review: 'approved' }),
          BO.newRange({ id: 'rhand0003', start: 41, end: 46, category: 'gore', review: 'approved' })],
        scan: { status: 'complete' }
      });
      fs.writeFileSync(path.join(WORK, 'hand-marked.bonis.json'), JSON.stringify(truth));
    }),
    function () { return mockOpenDialog([path.join(WORK, 'hand-marked.bonis.json')])(); },
    click('[data-nav="library"]'),
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="more"]'); },
    click('[data-menu="accuracy"]'),
    waitText('Comprobar la precisión'),
    shot('es-light-accuracy-empty'),
    // decision 13: the movie's own list (here its exported sidecar) is refused
    function () { return mockOpenDialog([path.join(MOVIES, 'Family Picnic (2019).bonis.json')])(); },
    click('[data-act="pick-truth"]'),
    waitText('Ese archivo es la lista propia de esta película'),
    shot('es-light-accuracy-same-list'),
    function () { return mockOpenDialog([path.join(WORK, 'hand-marked.bonis.json')])(); },
    click('[data-act="pick-truth"]'),
    waitSel('.bo-acc__table'),
    function () {
      return page.$$eval('.bo-acc__table tbody tr', function (rows) { return rows.map(function (r) { return r.getAttribute('data-category'); }); }).then(function (cats) {
        assert.deepStrictEqual(cats, ['nudity', 'kissing', 'gore', 'all'], 'one row per kind plus the total');
      });
    },
    function () {
      return page.$eval('.bo-acc__table tr[data-category="kissing"]', function (r) { return r.textContent; }).then(function (t) {
        assert.ok(t.indexOf('0%') >= 0, 'the rejected kissing scene shows as caught 0%');
      });
    },
    waitText('Se pasaron = escenas que marcaste y que no detectamos'),
    waitSel('[data-compared]'),
    function () { return page.textContent('[data-compared]').then(function (t) { assert.ok(t.indexOf('análisis automático') >= 0 && t.indexOf('hand-marked.bonis.json') >= 0, t); }); },
    shot('es-light-accuracy'),
    noHorizontalScroll('accuracy'),
    click('[data-act="copy"]'),
    sleep(200),
    function () {
      return app.evaluate(function (electron) { return electron.clipboard.readText(); }).then(function (txt) {
        assert.ok(txt.indexOf('| category | precision | recall | F1 |') >= 0, 'markdown table copied');
        assert.ok(txt.indexOf('Family Picnic') >= 0);
      });
    },
    invoke('library:list', {}, function (r) {
      var it = r.data.filter(function (x) { return x.id === ids['Family Picnic']; })[0];
      assert.ok(it.accuracy && it.accuracy.report.categories.all, 'last result stored per title');
    }),
    setLang('en-US'),
    waitText('Missed = scenes you marked that we did not catch'),
    waitText('Caught'),
    shot('en-light-accuracy'),
    setTheme('dark'), shot('en-dark-accuracy'), setLang('es-MX'), shot('es-dark-accuracy'), setTheme('light'),
    // ---- X13: "Mark by hand": nothing skipped, marks kept apart, then Check accuracy uses them
    click('[data-nav="library"]'),
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="more"]'); },
    click('[data-menu="handmark"]'),
    waitSel('.bo-modal [data-action="ok"]'),
    click('.bo-modal [data-action="ok"]'),
    waitSel('.bo-nowplaying [data-handmark]'),
    waitText('Marcando a mano: tus marcas no cambian lo que ven los niños.'),
    waitSel('.bo-nowplaying__state[data-state="playing"]', { timeout: 30000 }),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.handMark, true); }),
    mpvKeys(['i', 'o'], 1500),
    waitSel('[data-mark-category]', { timeout: 15000 }),
    function () { return page.selectOption('[data-mark-category]', 'nudity'); },
    sleep(300),
    shot('es-light-handmark'),
    click('[data-act="stop"]'),
    waitSel('[data-view="library"]:not([hidden])', { timeout: 20000 }),
    invoke('skip:get', function () { return { id: ids['Family Picnic'] }; }, function (r) { assert.strictEqual(r.data.doc.ranges.length, 3, 'hand marks never enter the title\'s list'); }),
    invoke('truth:get', function () { return { id: ids['Family Picnic'] }; }, function (r) {
      assert.strictEqual(r.data.ranges.length, 1);
      assert.strictEqual(r.data.ranges[0].category, 'nudity');
      assert.strictEqual(r.data.ranges[0].source, 'manual');
    }),
    go('accuracy', function () { return { id: ids['Family Picnic'] }; }),
    waitFor(function () { var b = document.querySelector('[data-act="use-hand"]'); return b && !b.disabled; }),
    waitText('Marcaste 1 escena a mano en esta película.'),
    click('[data-act="use-hand"]'),
    waitSel('.bo-acc__table'),
    function () { return page.textContent('[data-compared]').then(function (t) { assert.ok(t.indexOf('tus marcas a mano') >= 0, t); }); },
    sleep(200), shot('es-light-accuracy-hand'),
    // ---- X6: two error toasts on the library never cover a button
    go('library'), sleep(400),
    evaluate(function () { window.BO.toast.error('notFound'); window.BO.toast.error('fileMissing'); }),
    sleep(400),
    buttonsClearOfToasts('library with two toasts'),
    shot('es-light-library-two-toasts', true),
    evaluate(function () { window.BO.toast.clearAll(); }),
    // ---- play in parent mode: mpv starts, the now-playing panel reaches "ready"
    click('[data-nav="library"]'),
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="play"]'); },
    // decision 7: parent mode shows what will happen first
    waitSel('.bo-modal [data-action="play"]'),
    waitText('Se omitirán 2 escenas · 1 que dejaste ver'),
    function () { return page.$$eval('.bo-preplay__row', function (n) { return n.map(function (x) { return x.getAttribute('data-category'); }); }).then(function (c) { assert.ok(c.indexOf('nudity') >= 0 && c.indexOf('gore') >= 0, c.join(',')); }); },
    sleep(400),
    shot('es-light-preplay'),
    setTheme('dark'), shot('es-dark-preplay'), setTheme('light'),
    click('.bo-modal [data-action="play"]'),
    waitSel('.bo-nowplaying'),
    waitSel('.bo-nowplaying__state[data-state="playing"]', { timeout: 30000 }),
    waitText('Reproduciendo en su propia ventana'),
    shot('es-light-nowplaying'),
    setTheme('dark'), shot('es-dark-nowplaying'),
    setLang('en-US'), shot('en-dark-nowplaying'),
    setTheme('light'), shot('en-light-nowplaying'),
    setLang('es-MX'),
    // board A7: locking while a parent-mode movie plays turns it into a kid-mode movie
    waitSel('.bo-nowplaying__marks'),
    invoke('pin:lock', {}, function (r) { assert.ok(r.ok); }),
    waitFor(function () { return !document.querySelector('.bo-nowplaying__marks') && document.querySelector('.bo-nowplaying'); }),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.kidMode, true, 'running player switched to kid mode'); assert.notStrictEqual(r.data.state, 'idle'); }),
    shot('es-light-nowplaying-locked'),
    click('[data-act="stop"]'),
    waitSel('[data-view="kid"]:not([hidden])', { timeout: 20000 }),
    click('[data-act="parent"]'),
    waitSel('.bo-modal .bo-pin'),
    keys(PIN), press('Enter'),
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
      steps.push(go('review', function () { return { id: ids['River Trip'] }; }), waitSel('.bo-range'), sleep(600), shot(p + 'review-overview'), noHorizontalScroll(p + 'review'), namesWhole(p + 'review'));
      // round 3, N2.6: at 1024x640 at least three scene rows are fully visible
      steps.push(function () {
        return page.evaluate(function () {
          var box = document.querySelector('.bo-review__list').getBoundingClientRect();
          return Array.prototype.filter.call(document.querySelectorAll('.bo-range-list .bo-range-row'), function (r) {
            var b = r.getBoundingClientRect();
            return b.top >= box.top - 1 && b.bottom <= box.bottom + 1 && b.bottom <= window.innerHeight;
          }).length;
        }).then(function (n) { assert.ok(n >= 3, 'scene rows visible at 1024x640: ' + n); });
      });
      steps.push(function () { return page.click(rangeSel(0)); }, waitSel('.bo-panel .bo-thumb'), sleep(200), shot(p + 'review-panel'), noHorizontalScroll(p + 'review-panel'));
      // round 2, P9: the scan ran in Spanish; the note follows the UI language
      steps.push((function (lang) {
        return function () {
          return page.textContent('.bo-panel__note').then(function (t) {
            assert.strictEqual(t, lang === 'en-US' ? 'Possible nudity. Seen in the picture.' : 'Posible desnudez. Se ve en la imagen.', 'note in ' + lang);
          });
        };
      }(L[0])));
      steps.push(function () { return page.$eval('.bo-panel__scroll', function (n) { n.scrollTop = n.scrollHeight; }); }, sleep(100), shot(p + 'review-panel-edges'));
      steps.push(go('settings'), sleep(400), shot(p + 'settings-protection'), noHorizontalScroll(p + 'settings'));
      steps.push(click('[data-section="playback"]'), sleep(200), shot(p + 'settings-playback'));
      steps.push(click('[data-section="privacy"]'), sleep(200), shot(p + 'settings-privacy'));
      steps.push(click('[data-section="about"]'), sleep(400), shot(p + 'settings-about'));
      steps.push(go('export', function () { return { id: ids['Family Picnic'] }; }), sleep(300), shot(p + 'export'), noHorizontalScroll(p + 'export'));
      steps.push(go('help'), sleep(400), shot(p + 'help'), noHorizontalScroll(p + 'help'));
      steps.push(go('help', { anchor: 'accuracy' }), sleep(300), shot(p + 'help-accuracy'));
      steps.push(go('accuracy', function () { return { id: ids['Family Picnic'] }; }), waitSel('.bo-acc__table'), sleep(200), shot(p + 'accuracy-matrix'), noHorizontalScroll(p + 'accuracy'));
      steps.push(go('settings', { section: 'scanning' }), sleep(300), shot(p + 'settings-scanning'));
      steps.push(go('help', { anchor: 'tv' }), sleep(300), shot(p + 'help-tv'));
      steps.push(go('help', { anchor: 'install' }), sleep(300), shot(p + 'help-install'));
      steps.push(go('activity'), waitSel('.bo-activity__row'), sleep(200), shot(p + 'activity'), noHorizontalScroll(p + 'activity'));
      steps.push(evaluate(function () { document.documentElement.setAttribute('data-mode', 'kid'); window.BO.router.go('kid'); }), sleep(600), shot(p + 'kid'), noHorizontalScroll(p + 'kid'));
      steps.push(evaluate(function () { window.BO.pinPad.ask({ purpose: 'peek' }, function () {}); }), sleep(300), shot(p + 'kid-pin'), press('Escape'), sleep(100), noModal());
      steps.push(evaluate(function () { document.documentElement.removeAttribute('data-mode'); window.BO.router.go('library'); }), sleep(200));
    });
  });

  // ---- round 3, N-R4: a toast follows a language change instead of staying in the old language
  steps.push(setLang('es-MX'), go('library'), sleep(200),
    evaluate(function () { window.BO.toast.error('notFound'); }),
    waitText('No encontramos esa película'),
    setLang('en-US'),
    waitFor(function () { var t = document.getElementById('toasts').textContent; return t.indexOf('We could not find that movie') >= 0 && t.indexOf('No encontramos') < 0; }),
    evaluate(function () { window.BO.toast.clearAll(); }), setLang('es-MX'));

  // ---- a wide window too
  steps.push(setLang('es-MX'), setTheme('light'), resize(1600, 1000), go('library'), sleep(500), shot('es-light-1600-library'),
    go('review', function () { return { id: ids['River Trip'] }; }), waitSel('.bo-range'), sleep(500), function () { return page.click(rangeSel(0)); }, sleep(300), shot('es-light-1600-review'),
    go('settings'), sleep(300), shot('es-light-1600-settings'), resize(1024, 640));

  // ---- decision 2: a scan that finds nothing waits for a parent click; kids see only approved
  // titles; a list damaged while locked disappears from the kids' screen at once (fail closed);
  // in parent mode it never shows Protected and Play asks first (decision 1); activity; auto-relock.
  function lakeFiles() { return [path.join(UD, 'library', ids.lake + '.bonis.json'), path.join(UD, 'library', ids.lake + '.bonis.json.bak')]; }
  steps.push(
    // round 2, decision 6: "For this movie" levels from the review header, then back to the usual ones
    setLang('es-MX'), setTheme('light'),
    go('review', function () { return { id: ids['River Trip'] }; }), waitSel('.bo-range'),
    click('[data-act="movie-levels"]'),
    waitSel('.bo-modal .bo-level[data-category="kissing"]'),
    function () { return page.click('.bo-modal .bo-level[data-category="kissing"] .bo-segmented__opt--off'); },
    sleep(200), shot('es-light-movie-levels'),
    click('.bo-modal [data-action="save-levels"]'),
    waitFor(function () { var b = document.querySelector('[data-act="movie-levels"]'); return b && b.getAttribute('aria-pressed') === 'true'; }),
    waitSel('.bo-range-row [data-below]'),
    waitText('Besos está desactivado para esta película: se verá a menos que la omitas'),
    invoke('library:list', {}, function (r) {
      var it = r.data.filter(function (x) { return x.id === ids['River Trip']; })[0];
      assert.strictEqual(it.levels.kissing, 'off', 'kept in the library entry');
    }),
    invoke('settings:get', {}, function (r) { assert.strictEqual(r.data.levels.kissing, 'strict', 'the usual levels did not change'); }),
    shot('es-light-review-movie-levels'),
    click('[data-act="movie-levels"]'),
    click('.bo-modal [data-action="use-usual"]'),
    waitFor(function () { var b = document.querySelector('[data-act="movie-levels"]'); return b && b.getAttribute('aria-pressed') === 'false'; }),
    function () { return page.$('.bo-range-row [data-below]').then(function (n) { assert.strictEqual(n, null, 'usual levels again'); }); },
    // round 3, N-R6: Send to TV with scenes still waiting: every button above the fold in Spanish
    go('export', function () { return { id: ids['River Trip'] }; }), sleep(400),
    waitSel('[data-banner="waiting"]'),
    function () {
      return page.evaluate(function () {
        return ['export-clean', 'export-edl', 'export-json'].map(function (a) { var n = document.querySelector('[data-act="' + a + '"]'); return n ? Math.round(n.getBoundingClientRect().bottom) : 9999; });
      }).then(function (b) { b.forEach(function (y) { assert.ok(y <= 640, 'button bottom ' + y + ' within 640'); }); });
    },
    shot('es-light-export-waiting'),
    go('library'), sleep(300),
    invoke('library:add', { paths: [garden, lake] }, function (r) { assert.strictEqual(r.data.added.length, 2); ids.garden = r.data.added[0]; ids.lake = r.data.added[1]; }),
    function () { return poll(function (id) { var c = document.querySelector('.bo-title-card[data-id="' + id + '"]'); return c && c.getAttribute('data-status') === 'needsReview'; }, ids.lake, 40000); },
    function () { return poll(function (id) { return !!document.querySelector('.bo-title-card[data-id="' + id + '"] [data-act="approve-clean"]'); }, ids.garden, 40000); },
    invoke('library:list', {}, function (r) {
      var g = r.data.filter(function (x) { return x.id === ids.garden; })[0];
      assert.strictEqual(g.status, 'needsReview', 'nothing found is not Protected');
      assert.strictEqual(g.cleanPending, true);
    }),
    waitText('No se encontró nada: revísala'),
    shot('es-light-library-clean'),
    invoke('skip:approve', function () { return { id: ids.lake, rangeIds: 'all' }; }, function (r) { assert.ok(r.ok); }),
    click('[data-nav="lock"]'),
    waitSel('.bo-kid__grid .bo-play-tile'),
    sleep(500),
    function () {
      return page.$$eval('.bo-kid__grid .bo-play-tile', function (n) { return n.map(function (x) { return x.getAttribute('data-id'); }); }).then(function (list) {
        assert.deepStrictEqual(list.sort(), [ids['Family Picnic'], ids.lake].sort(), 'only approved titles; the clean one waits for a parent');
      });
    },
    // the list of Lake Day is damaged on disk (and its backup): the kid presses it, it does not play,
    // a kid-friendly message shows, and the tile leaves the screen without a reload
    function () { lakeFiles().forEach(function (f) { fs.writeFileSync(f, '{ damaged'); }); },
    function () { return page.click('.bo-kid__grid .bo-play-tile[data-id="' + ids.lake + '"]'); },
    waitText('Esta película no se puede ver ahora. Pídele ayuda a un adulto.'),
    function () { return poll(function (id) { return !document.querySelector('.bo-kid__grid .bo-play-tile[data-id="' + id + '"]'); }, ids.lake, 20000); },
    sleep(400),
    shot('es-light-kid-refused', true),
    invoke('library:list', {}, function (r) { assert.deepStrictEqual(r.data.map(function (x) { return x.id; }), [ids['Family Picnic']], 'main serves only protected titles while locked'); }),
    invoke('settings:set', { patch: { lockOnStart: false } }, function (r) { assert.strictEqual(r.error, 'locked'); }),
    invoke('skip:get', function () { return { id: ids['River Trip'] }; }, function (r) { assert.strictEqual(r.error, 'locked'); }),
    invoke('activity:list', {}, function (r) { assert.strictEqual(r.error, 'locked', 'the activity log is for parents'); }),
    invoke('player:play', function () { return { id: ids['River Trip'], kidMode: false }; }, function (r) { assert.strictEqual(r.error, 'kidRefused', 'kid mode never plays an unprotected title'); }),
    shot('es-light-kid-locked'),
    function () { return page.click('.bo-kid__grid .bo-play-tile'); },
    waitSel('.bo-nowplaying__state[data-state="playing"]', { timeout: 30000 }),
    function () { return page.$('.bo-nowplaying__marks').then(function (m) { assert.strictEqual(m, null, 'no marking section in kid mode'); }); },
    shot('es-light-kid-nowplaying'),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.kidMode, true); assert.notStrictEqual(r.data.state, 'idle'); }),
    click('[data-act="stop"]'),
    waitSel('[data-view="kid"]:not([hidden])', { timeout: 20000 }),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.state, 'idle', 'mpv stopped'); }),
    click('[data-act="parent"]'),
    waitSel('.bo-modal .bo-pin'),
    keys(PIN), press('Enter'),
    waitSel('[data-view="library"]:not([hidden])', { timeout: 20000 }),
    // decision 1, parent side: damaged, never Protected, and Play asks before an unprotected play
    function () { return poll(function (id) { var c = document.querySelector('.bo-title-card[data-id="' + id + '"]'); return c && c.getAttribute('data-status') === 'needsAttention'; }, ids.lake, 20000); },
    function () {
      return page.$eval('.bo-title-card[data-id="' + ids.lake + '"]', function (c) { return c.textContent; }).then(function (t) {
        assert.ok(t.indexOf('Requiere atención: lista de escenas dañada') >= 0, t);
        assert.ok(t.indexOf('Protegida') < 0, 'never Protected');
      });
    },
    function () { return page.$eval('.bo-title-card[data-id="' + ids.lake + '"]', function (c) { c.scrollIntoView({ block: 'center' }); }); },
    sleep(200),
    shot('es-light-library-damaged'),
    function () { return page.click('.bo-title-card[data-id="' + ids.lake + '"] [data-act="more"]'); },
    click('[data-menu="play"]'),
    waitSel('.bo-modal [data-action="play-unprotected"]'),
    waitText('La lista de escenas de esta película está dañada. ¿Verla sin protección?'),
    sleep(400),
    shot('es-light-play-unprotected'),
    click('.bo-modal [data-action="cancel"]'),
    noModal(),
    invoke('player:status', {}, function (r) { assert.strictEqual(r.data.state, 'idle', 'nothing played'); }),
    // decision 2: one click approves the clean title for kids
    function () { return page.click('.bo-title-card[data-id="' + ids.garden + '"] [data-act="approve-clean"]'); },
    function () { return poll(function (id) { var c = document.querySelector('.bo-title-card[data-id="' + id + '"]'); return c && c.getAttribute('data-status') === 'protected'; }, ids.garden, 10000); },
    // decision 3: the activity log
    go('activity'),
    waitSel('.bo-activity__row'),
    function () {
      return page.$$eval('.bo-activity__row', function (n) { return n.map(function (x) { return x.getAttribute('data-type'); }); }).then(function (types) {
        ['setup', 'unlock', 'lock', 'damaged', 'approveClean', 'skip', 'letPlay', 'play', 'settings', 'integrity'].forEach(function (t) { assert.ok(types.indexOf(t) >= 0, 'activity has ' + t + ': ' + types.join(',')); });
        assert.strictEqual(types[0], 'approveClean', 'newest first');
      });
    },
    waitText('Un archivo incluido no coincidió: bin/licenses/GPL-3.0.txt'),
    shot('es-light-activity-log'),
    // round 3, P2: "I trust the automatic list" is what the card says
    go('review', function () { return { id: ids['River Trip'] }; }), waitSel('.bo-range'),
    click('[data-act="mark-reviewed"]'),
    waitSel('.bo-modal [data-action="trusted"]'),
    sleep(300), shot('es-light-mark-reviewed'),
    click('.bo-modal [data-action="trusted"]'),
    waitSel('.bo-parents-card__footer [data-footer="trusted"]'),
    waitText('Lista automática, aceptada por ti el'),
    // round 3, X8: a list damaged on disk shows "Needs attention" as soon as the library shows
    go('settings'), sleep(200),
    function () { [path.join(UD, 'library', ids['River Trip'] + '.bonis.json'), path.join(UD, 'library', ids['River Trip'] + '.bonis.json.bak')].forEach(function (f) { fs.writeFileSync(f, '{ damaged'); }); },
    go('library'),
    function () { return poll(function (id) { var c = document.querySelector('.bo-title-card[data-id="' + id + '"]'); return c && c.getAttribute('data-status') === 'needsAttention' && c.textContent.indexOf('lista de escenas dañada') >= 0; }, ids['River Trip'], 10000); },
    // security round 2, N3: a damaged model found by "Check installed files" stops scans
    function () { fs.writeFileSync(path.join(RES, 'models', 'nsfw-vit-int8.onnx'), 'changed model bytes!'); },
    go('settings', { section: 'about' }), sleep(300),
    click('[data-act="check-files"]'),
    waitText('models/nsfw-vit-int8.onnx no coincide'),
    sleep(200), shot('es-light-settings-check-files'),
    invoke('scan:queue', function () { return { id: ids['River Trip'] }; }),
    function () { return poll(function (id) { var it = (window.BO.store.get('library') || []).filter(function (x) { return x.id === id; })[0]; return it && it.status === 'needsAttention' && it.error === 'bundleDamaged'; }, ids['River Trip'], 15000); },
    function () { fs.writeFileSync(path.join(RES, 'models', 'nsfw-vit-int8.onnx'), 'original model bytes'); fs.writeFileSync(path.join(RES, 'bin', 'licenses', 'GPL-3.0.txt'), 'the licence'); },
    click('[data-act="check-files"]'),
    waitText('coinciden con las copias'),
    // decision 10: auto-relock after the chosen minutes, with a 30 s warning
    go('settings', { section: 'pin' }), sleep(300),
    function () { return page.selectOption('[data-setting="autoLockMinutes"]', '5'); },
    sleep(300),
    invoke('settings:get', {}, function (r) { assert.strictEqual(r.data.autoLockMinutes, 5); }),
    shot('es-light-settings-autolock'),
    // round 2, K5: a movie never locks mid-way, but its time counts: when it ends, the app locks at once
    go('library'), sleep(200),
    function () { return page.click('.bo-title-card[data-id="' + ids['Family Picnic'] + '"] [data-act="play"]'); },
    waitSel('.bo-modal [data-action="play"]'),
    click('.bo-modal [data-action="play"]'),
    waitSel('.bo-nowplaying__state[data-state="playing"]', { timeout: 30000 }),
    waitText('Atrás o adelante 5 segundos'),
    evaluate(function () { window.BO.idle._setLast(Date.now() - 6 * 60000); window.BO.idle.tick(); }),
    sleep(1500),
    invoke('pin:status', {}, function (r) { assert.ok(!r.data.locked, 'not while the movie plays'); }),
    evaluate(function () { window.BO.idle._setLast(Date.now() - 6 * 60000); }),
    // round 3, N-R1: the app's Stop button: the time ran out during the movie, so it locks first
    click('[data-act="stop"]'),
    waitSel('[data-view="kid"]:not([hidden])', { timeout: 20000 }),
    invoke('pin:status', {}, function (r) { assert.ok(r.data.locked, 'locked as soon as the movie ended'); }),
    click('[data-act="parent"]'),
    waitSel('.bo-modal .bo-pin'),
    keys(PIN), press('Enter'),
    waitSel('[data-view="library"]:not([hidden])', { timeout: 20000 }),
    go('library'), sleep(200),
    evaluate(function () { window.BO.idle._setLast(Date.now() - 5 * 60000 + 20000); window.BO.idle.tick(); }),
    waitText('Se bloqueará para niños en 30 segundos'),
    sleep(400),
    shot('es-light-idle-warning', true),
    evaluate(function () { window.BO.idle._setLast(Date.now() - 5 * 60000 - 1000); window.BO.idle.tick(); }),
    waitSel('[data-view="kid"]:not([hidden])', { timeout: 10000 }),
    invoke('pin:status', {}, function (r) { assert.ok(r.data.locked, 'locked after 5 idle minutes'); }),
    invoke('library:list', {}, function (r) {
      assert.deepStrictEqual(r.data.map(function (x) { return x.id; }).sort(), [ids['Family Picnic'], ids.garden].sort(), 'the approved clean title is for kids now');
    }),
    // wrong PIN cooldown (kept last: it blocks the PIN pad for 30 s)
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
