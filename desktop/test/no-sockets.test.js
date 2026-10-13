'use strict';
// No network, measured (brief 4.7; board review A2): a complete first launch of the real app
// (wizard, a first movie scanned, review, Help, About) runs with Electron under
// `strace -f -e trace=connect`. Any AF_INET / AF_INET6 connect from Electron or anything it starts
// fails the test, and no spell-check dictionary may be downloaded into userData/Dictionaries.
// (Electron creates that folder empty when the session starts; an empty folder is allowed.)
// Skipped when strace, xvfb-run or Playwright is missing.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var h = require('./helpers.js');

function have(cmd) { return childProcess.spawnSync('sh', ['-c', 'command -v ' + cmd], { stdio: 'ignore' }).status === 0; }
var hasPw = true;
try { require.resolve('playwright'); require.resolve('electron'); } catch (e) { hasPw = false; }
var skip = process.platform !== 'linux' ? 'Linux only' : (!have('strace') ? 'strace not installed' : (!have('xvfb-run') ? 'xvfb-run not installed' : (!hasPw ? 'playwright/electron not installed' : (!h.haveFfmpeg() ? 'ffmpeg not installed' : false))));

test('a whole first launch opens no IP socket and downloads no dictionary', { skip: skip, timeout: 180000 }, function () {
  var work = h.tmpDir('no-sockets');
  var log = path.join(work, 'connect.log');
  var r = childProcess.spawnSync('xvfb-run', ['-a', process.execPath, path.join(__dirname, 'e2e', 'no-sockets-driver.js'), work, log], { encoding: 'utf8', timeout: 170000 });
  assert.strictEqual(r.status, 0, 'driver: ' + r.stdout + r.stderr);
  var lines = fs.readFileSync(log, 'utf8').split('\n');
  var connects = lines.filter(function (l) { return /connect\(/.test(l); });
  assert.ok(connects.length > 0, 'strace saw the app (local sockets at least)');
  var ip = connects.filter(function (l) { return /AF_INET6?\b/.test(l); });
  assert.deepStrictEqual(ip, [], 'IP connects');
  var dict = path.join(work, 'userdata', 'Dictionaries');
  var files = fs.existsSync(dict) ? fs.readdirSync(dict) : [];
  assert.deepStrictEqual(files, [], 'no spell-check dictionary downloaded');
  assert.ok(fs.existsSync(path.join(work, 'userdata', 'library.json')), 'the first run completed');
});
