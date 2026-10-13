#!/usr/bin/env node
/*
 * First-launch text files that ship NEXT TO the installer (board round 1 N6, round 2 decision 2):
 *   docs/INSTALL/en-US.md -> FIRST-LAUNCH.txt
 *   docs/INSTALL/es-MX.md -> PRIMER-INICIO.txt
 * A parent can read them before the unsigned app opens (Gatekeeper / SmartScreen). Plain text:
 * Markdown marks removed, headings underlined, lines wrapped at 76 characters, UTF-8 with a BOM and
 * CRLF line ends so Notepad and TextEdit both show the accents.
 *   node tools/make-first-launch.js [outDir]     (default build/first-launch)
 * CI runs it before electron-builder (the DMG lists both files, electron-builder.yml dmg.contents)
 * and copies both next to the installers afterwards. ES5, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var FILES = [
  { from: 'en-US.md', to: 'FIRST-LAUNCH.txt' },
  { from: 'es-MX.md', to: 'PRIMER-INICIO.txt' }
];
var WIDTH = 76;

function inline(s) {
  return s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s*\{#[\w-]+\}\s*$/, '');
}

// Wraps one paragraph; the first line starts with `first`, the others with `rest`.
function wrap(text, first, rest) {
  var words = text.split(/\s+/).filter(function (w) { return w; });
  var lines = [];
  var cur = first;
  var empty = true;
  words.forEach(function (w) {
    if (!empty && (cur + ' ' + w).length > WIDTH) {
      lines.push(cur);
      cur = rest + w;
    } else {
      cur = empty ? cur + w : cur + ' ' + w;
    }
    empty = false;
  });
  lines.push(cur);
  return lines;
}

function render(md) {
  var out = [];
  var para = [];
  function flush() {
    if (para.length) { out = out.concat(wrap(inline(para.join(' ')), '', ''), ['']); para = []; }
  }
  md.replace(/\r\n/g, '\n').split('\n').forEach(function (line) {
    var m;
    if (!line.trim()) { flush(); return; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flush();
      var t = inline(m[2]);
      out.push(t, new Array(t.length + 1).join(m[1].length === 1 ? '=' : '-'), '');
      return;
    }
    if ((m = /^(\d+)\.\s+(.*)$/.exec(line))) {
      flush();
      var lead = m[1] + '. ';
      out = out.concat(wrap(inline(m[2]), '  ' + lead, '  ' + new Array(lead.length + 1).join(' ')));
      return;
    }
    if ((m = /^[-*]\s+(.*)$/.exec(line))) {
      flush();
      out = out.concat(wrap(inline(m[1]), '  - ', '    '));
      return;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flush(); out = out.concat(wrap(inline(m[1]), '  ', '  ')); return; }
    para.push(line.trim());
  });
  flush();
  while (out.length && !out[out.length - 1]) { out.pop(); }
  // A list ends with a blank line before the next block.
  var tidy = [];
  out.forEach(function (l, i) {
    tidy.push(l);
    var next = out[i + 1];
    if (/^ {2}(\d+\.|-) /.test(l) || (/^ {2,}/.test(l) && tidy.length > 1)) {
      if (next !== undefined && next !== '' && !/^ {2}/.test(next)) { tidy.push(''); }
    }
  });
  return '﻿' + tidy.join('\r\n') + '\r\n';
}

// -> [{file, text}]
function make(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  return FILES.map(function (f) {
    var text = render(fs.readFileSync(path.join(ROOT, 'docs', 'INSTALL', f.from), 'utf8'));
    var file = path.join(outDir, f.to);
    fs.writeFileSync(file, text);
    return { file: file, text: text };
  });
}

if (require.main === module) {
  var dir = path.resolve(process.argv[2] || path.join(ROOT, 'build', 'first-launch'));
  make(dir).forEach(function (r) { process.stdout.write('wrote ' + path.relative(process.cwd(), r.file) + ' (' + Buffer.byteLength(r.text) + ' bytes)\n'); });
}

module.exports = { render: render, make: make, FILES: FILES };
