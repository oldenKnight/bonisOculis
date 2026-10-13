/*
 * Driver for desktop/test/no-sockets.test.js (run under xvfb-run by that test). Launches the real
 * app through a wrapper that runs Electron under `strace -f -e trace=connect`, walks a complete
 * first run (language, PIN twice, recovery code, levels, first movie scanned by the fake
 * analyzer), opens the review and Help, and quits. The test then reads the strace log.
 * Args: <work dir> <strace log>. ES5; Playwright promises consumed with .then.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var playwright = require('playwright');

var ROOT = path.join(__dirname, '..', '..', '..');
var WORK = process.argv[2];
var LOG = process.argv[3];
var UD = path.join(WORK, 'userdata');
var PIN = '2468';

function fail(e) { process.stderr.write('driver failed: ' + (e && e.stack ? e.stack : e) + '\n'); process.exit(1); }

function series(steps, done) {
  var i = 0;
  function next() {
    if (i >= steps.length) { done(); return; }
    var r;
    try { r = steps[i++](); } catch (e) { fail(e); return; }
    if (r && typeof r.then === 'function') { r.then(next, fail); } else { next(); }
  }
  next();
}

fs.mkdirSync(UD, { recursive: true });
var movie = path.join(WORK, 'Short Clip.mp4');
var mk = childProcess.spawnSync(process.env.BONIS_FFMPEG || '/usr/bin/ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330',
  '-t', '10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', movie], { stdio: 'ignore' });
if (mk.status !== 0) { fail('ffmpeg'); }

var wrapper = path.join(WORK, 'electron-under-strace.sh');
fs.writeFileSync(wrapper, '#!/bin/sh\nexec strace -f -qq -e trace=connect -o "' + LOG + '" "' + require('electron') + '" "$@"\n');
fs.chmodSync(wrapper, 493);

var env = {};
Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
env.BONIS_USER_DATA = UD;
env.BONIS_QUIET = '1';
env.BONIS_ANALYZER = JSON.stringify({ cmd: process.execPath, args: [path.join(ROOT, 'tools', 'fake-analyzer.js'), '--steps', '5'] });
var args = [ROOT];
if (process.getuid && process.getuid() === 0) { args.unshift('--no-sandbox'); }

var app = null;
var page = null;
function poll(fn, arg, ms) {
  var limit = Date.now() + (ms || 30000);
  return new Promise(function (resolve, reject) {
    (function tick() {
      page.evaluate(fn, arg).then(function (v) {
        if (v) { resolve(v); return; }
        if (Date.now() > limit) { reject(new Error('timed out: ' + String(fn).slice(0, 120))); return; }
        setTimeout(tick, 100);
      }, reject);
    }());
  });
}
function text(t) { return function () { return poll(function (x) { return document.body.innerText.indexOf(x) >= 0; }, t); }; }

series([
  function () { return playwright._electron.launch({ executablePath: wrapper, args: args, env: env }).then(function (a) { app = a; return a.firstWindow(); }).then(function (p) { page = p; }); },
  function () { return page.waitForSelector('[data-lang="en-US"]', { timeout: 30000 }); },
  function () { return page.click('[data-lang="en-US"]'); },
  function () { return page.click('[data-action="continue"]'); },
  text('Choose a parent PIN'),
  function () { return page.keyboard.type(PIN); }, function () { return page.keyboard.press('Enter'); },
  function () { return page.waitForTimeout(300); },
  function () { return page.keyboard.type(PIN); }, function () { return page.keyboard.press('Enter'); },
  text('Your recovery code'),
  function () { return page.click('.bo-code .bo-switch'); },
  function () { return page.click('[data-action="code-continue"]'); },
  text('How much should we skip?'),
  function () { return page.click('[data-action="continue"]'); },
  text('Add your first movie'),
  function () { return app.evaluate(function (electron, f) { electron.dialog.showOpenDialog = function () { return Promise.resolve({ canceled: false, filePaths: [f] }); }; }, movie); },
  function () { return page.click('.bo-dropzone'); },
  function () { return poll(function () { return document.querySelectorAll('.bo-title-card[data-status="needsReview"]').length === 1; }, null, 60000); },
  function () { return page.click('.bo-title-card [data-act="review"]'); },
  function () { return page.waitForSelector('.bo-range', { timeout: 20000 }); },
  function () { return page.waitForTimeout(1500); },
  function () { return page.evaluate(function () { window.BO.router.go('help'); }); },
  function () { return page.waitForTimeout(1500); },
  function () { return page.evaluate(function () { window.BO.router.go('settings', { section: 'about' }); }); },
  function () { return page.waitForTimeout(3000); },
  function () { return app.close(); }
], function () { process.stdout.write('driver done\n'); process.exit(0); });
