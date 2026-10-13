#!/usr/bin/env node
/*
 * The sha256 of the player script that ships with the app (player/bonis.lua), so the app can check
 * it at start (desktop/main/integrity.js; board security round 2, N3: the player refuses to launch
 * when mpv or bonis.lua does not match). CI runs it before electron-builder, which copies the result
 * to <resources>/player/player.lock.json (electron-builder.yml extraResources).
 *   node tools/make-player-lock.js [out]      (default build/player.lock.json)
 * ES5, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');

function make(out) {
  var buf = fs.readFileSync(path.join(ROOT, 'player', 'bonis.lua'));
  var lock = { schema: 1, files: { 'bonis.lua': { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length } } };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

if (require.main === module) {
  var out = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'player.lock.json'));
  make(out);
  process.stdout.write('wrote ' + path.relative(process.cwd(), out) + '\n');
}

module.exports = { make: make };
