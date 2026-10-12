/*
 * bonis oculis - check a built app before it is shipped.
 *
 *   node tools/verify-bundle.js <built app dir> [--target win32-x64] [--run-analyzer]
 *                               [--allow-missing-build] [--no-repo-checks]
 *   node tools/verify-bundle.js --repo-only     only the source checks (lint, no-network)
 *
 * <built app dir> is what electron-builder leaves in its output folder: win-unpacked/,
 * mac-arm64/ (or the .app inside it), linux-unpacked/. The Resources folder is found inside it.
 *
 * Bundle checks (packaging/README.md, "Resource layout"):
 *   bin/       every file of bin/<target>/binaries.lock.json present with its sha256; the
 *              shipped lock equals the repository's; mpv, ffmpeg, ffprobe, whisper-cli present;
 *              the lock's archives match the pins in packaging/binaries.json
 *   analyzer/  bonis-analyzer[.exe] + _internal/ with lexicon/{en,es}.json and the committed
 *              model sidecars identical to the repository; --run-analyzer runs `version`
 *   models/    exactly tools/fetch-models.js shipped(): sha256 + size of every file, nothing more
 *   player/bonis.lua, spec/lexicon/{en,es}.json, help/{en-US,es-MX}.md, help/LICENSES.md,
 *              help/BINARIES.md identical to the repository
 *   app.asar   package.json main, desktop/main, renderer, locales, shared, the two fonts with the
 *              repository's sha256; no tests, fixtures, docs, design preview or source maps;
 *              our own code (node_modules and vendor folders excluded) never mentions "api.",
 *              "telemetry", "sentry" or "analytics" outside comments and locale keys; ES5 lint
 *              and the no-network rules (desktop/test/no-network.test.js) on the shipped files
 * Repository checks (unless --no-repo-checks): tools/lint-es5.js on shared, desktop, player,
 * packaging and the tools written for packaging; the no-network rules on desktop/ and shared/.
 *
 * Exit 0 when everything holds, 1 otherwise (each problem on its own PROBLEM line).
 * ES5, CommonJS, Node >= 20, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var lib = require('../packaging/lib/fetchlib.js');
var lint = require('./lint-es5.js');
var models = require('./fetch-models.js');
var binaries = require('./fetch-binaries.js');

var ROOT = path.join(__dirname, '..');
var problems = [];
var oks = 0;

function problem(s) { problems.push(s); lib.log('PROBLEM   ' + s); }
function ok(s) { oks++; if (process.env.BONIS_VERBOSE) { lib.log('ok        ' + s); } }

/* ---------- asar (Electron archive: pickled JSON header + concatenated files) ---------- */

function readAsar(file) {
  var fd = fs.openSync(file, 'r'), head = Buffer.alloc(16), headerSize, json, header, base;
  try {
    fs.readSync(fd, head, 0, 16, 0);
    headerSize = head.readUInt32LE(4);
    var strLen = head.readUInt32LE(12);
    var buf = Buffer.alloc(strLen);
    fs.readSync(fd, buf, 0, strLen, 16);
    json = buf.toString('utf8');
    header = JSON.parse(json);
    base = 8 + headerSize;
  } finally { fs.closeSync(fd); }
  var files = {};
  (function walk(node, prefix) {
    Object.keys(node.files || {}).forEach(function (name) {
      var e = node.files[name], p = prefix ? prefix + '/' + name : name;
      if (e.files) { walk(e, p); } else if (e.link) { files[p] = { link: e.link }; } else { files[p] = { size: e.size, offset: e.offset != null ? Number(e.offset) : null, unpacked: !!e.unpacked }; }
    });
  }(header, ''));
  return {
    files: files,
    read: function (p) {
      var e = files[p], b, fd2;
      if (!e) { return null; }
      if (e.unpacked) { return fs.readFileSync(path.join(file + '.unpacked', p)); }
      b = Buffer.alloc(e.size);
      fd2 = fs.openSync(file, 'r');
      try { fs.readSync(fd2, b, 0, e.size, base + e.offset); } finally { fs.closeSync(fd2); }
      return b;
    }
  };
}

/* ---------- locating things ---------- */

function findResources(dir) {
  var cands = [dir, path.join(dir, 'resources'), path.join(dir, 'Contents', 'Resources')], i, apps;
  for (i = 0; i < cands.length; i++) {
    if (fs.existsSync(path.join(cands[i], 'app.asar')) || fs.existsSync(path.join(cands[i], 'app'))) { return cands[i]; }
  }
  try { apps = fs.readdirSync(dir).filter(function (n) { return /\.app$/.test(n); }); } catch (e) { apps = []; }
  if (apps.length === 1) { return findResources(path.join(dir, apps[0])); }
  return null;
}

function sameAsRepo(file, repoFile, label) {
  if (!fs.existsSync(file)) { problem(label + ' missing (' + file + ')'); return; }
  if (!fs.existsSync(repoFile)) { problem(label + ': repository file ' + repoFile + ' missing'); return; }
  if (lib.sha256File(file) !== lib.sha256File(repoFile)) { problem(label + ' differs from ' + path.relative(ROOT, repoFile)); return; }
  ok(label);
}

/* ---------- source rules shared by bundle and repository ---------- */

var FORBIDDEN = /api\.|telemetry|sentry|analytics/i;
var NET_REQUIRE = /require\(\s*['"](?:node:)?(net|http|https|http2|dns|dgram|tls)['"]\s*\)/;
var RENDERER_NET = /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|RTCPeerConnection)/;
var MAIN_FORBIDDEN = /autoUpdater|crashReporter|electron-updater|net\.request|session\.[a-zA-Z]+\.fetch/;
var NET_ALLOWED = ['desktop/main/player-controller.js'];

/* JS with comments blanked (strings and regexes kept, so URLs inside strings are still seen). */
function stripJsComments(src) {
  var out = [], i = 0, n = src.length, ch, nx, q;
  while (i < n) {
    ch = src.charAt(i); nx = src.charAt(i + 1);
    if (ch === '/' && nx === '/') { while (i < n && src.charAt(i) !== '\n') { out.push(' '); i++; } continue; }
    if (ch === '/' && nx === '*') {
      i += 2; out.push('  ');
      while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) { out.push(src.charAt(i) === '\n' ? '\n' : ' '); i++; }
      i += 2; out.push('  ');
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      q = ch; out.push(ch); i++;
      while (i < n && src.charAt(i) !== q) {
        if (src.charAt(i) === '\\') { out.push(src.charAt(i), src.charAt(i + 1)); i += 2; continue; }
        if (src.charAt(i) === '\n' && q !== '`') { break; }
        out.push(src.charAt(i)); i++;
      }
      if (i < n) { out.push(src.charAt(i)); i++; }
      continue;
    }
    out.push(ch); i++;
  }
  return out.join('');
}

function stripOtherComments(src, ext) {
  if (ext === '.html') { return src.replace(/<!--[\s\S]*?-->/g, function (m) { return m.replace(/[^\n]/g, ' '); }); }
  if (ext === '.css') { return src.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ' '); }); }
  if (ext === '.lua') { return src.replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, function (m) { return m.replace(/[^\n]/g, ' '); }); }
  return src;
}

var localeKeys = null;
function isLocaleKey(s) {
  if (!localeKeys) {
    localeKeys = {};
    try {
      fs.readdirSync(path.join(ROOT, 'desktop', 'locales')).forEach(function (f) {
        if (/\.json$/.test(f)) { Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'locales', f), 'utf8'))).forEach(function (k) { localeKeys[k] = true; }); }
      });
    } catch (e) { /* none */ }
  }
  return !!localeKeys[s];
}

/* Forbidden words in code (comments removed), JSON values (keys ignored), CSS, HTML, Lua. */
function forbiddenHits(rel, text) {
  var ext = path.extname(rel).toLowerCase(), code, hits = [];
  if (ext === '.json') {
    try {
      (function scan(v) {
        if (typeof v === 'string') { if (FORBIDDEN.test(v)) { hits.push(JSON.stringify(v).slice(0, 80)); } } else if (Array.isArray(v)) { v.forEach(scan); } else if (v && typeof v === 'object') { Object.keys(v).forEach(function (k) { scan(v[k]); }); }
      }(JSON.parse(text)));
    } catch (e) { if (FORBIDDEN.test(text)) { hits.push('(unparsable JSON)'); } }
    return hits;
  }
  code = ext === '.js' ? stripJsComments(text) : stripOtherComments(text, ext);
  code.split('\n').forEach(function (line, i) {
    var cleaned;
    if (!FORBIDDEN.test(line)) { return; }
    // string literals that are locale keys ('privacy.never.telemetry') are not endpoints
    cleaned = line.replace(/(['"])([a-zA-Z0-9_.-]+)\1/g, function (m, q, s) { return isLocaleKey(s) ? q + q : m; });
    if (FORBIDDEN.test(cleaned)) { hits.push((i + 1) + ': ' + line.trim().slice(0, 100)); }
  });
  return hits;
}

/* files: [{rel (forward slashes, repo-relative), text}] */
function sourceRules(files, label) {
  var lintHits = 0, netHits = [];
  files.forEach(function (f) {
    var isVendor = /(^|\/)(vendor|node_modules)\//.test(f.rel), ext = path.extname(f.rel);
    if (isVendor) { return; }
    forbiddenHits(f.rel, f.text).forEach(function (h) { problem(label + ': ' + f.rel + ':' + h + ' mentions api./telemetry/sentry/analytics'); });
    if (ext === '.js') {
      lint.scanSource(f.text).forEach(function (h) { lintHits++; problem(label + ': ES5 ' + f.rel + ':' + h.line + ':' + h.col + ' ' + h.rule); });
    }
    if (/^(desktop|shared)\//.test(f.rel) && /\.(js|html)$/.test(f.rel) && !/(^|\/)test\//.test(f.rel)) {
      if (NET_REQUIRE.test(f.text) && NET_ALLOWED.indexOf(f.rel) < 0) { netHits.push(f.rel); }
      if ((/^desktop\/renderer\//.test(f.rel) || f.rel === 'desktop/preload.js') && !/design-preview\.html$/.test(f.rel) && RENDERER_NET.test(f.text)) { problem(label + ': ' + f.rel + ' uses a network API in the renderer'); }
      if (/^desktop\/main\//.test(f.rel) && MAIN_FORBIDDEN.test(f.text)) { problem(label + ': ' + f.rel + ' references an updater, crash reporter or net request'); }
    }
  });
  netHits.forEach(function (r) { problem(label + ': ' + r + ' requires a network module (only ' + NET_ALLOWED.join(', ') + ' may, for the mpv pipe)'); });
  files.forEach(function (f) {
    if (NET_ALLOWED.indexOf(f.rel) >= 0) {
      if (/net\.(createServer|Server)\b/.test(f.text) || /net\.connect\(\s*\{?\s*port/.test(f.text)) { problem(label + ': ' + f.rel + ' opens a server or TCP connection'); }
    }
  });
  ok(label + ' source rules (' + files.length + ' files, ' + lintHits + ' lint hits)');
}

function repoFiles(dirs, exts) {
  var out = [];
  dirs.forEach(function (d) {
    var abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) { return; }
    if (fs.statSync(abs).isFile()) { out.push({ rel: d, text: fs.readFileSync(abs, 'utf8') }); return; }
    lib.walkFiles(abs).forEach(function (r) {
      var rel = d + '/' + r;
      if (/(^|\/)(node_modules|\.git)\//.test(rel)) { return; }
      if (exts.indexOf(path.extname(r).toLowerCase()) >= 0) { out.push({ rel: rel, text: fs.readFileSync(path.join(abs, r), 'utf8') }); }
    });
  });
  return out;
}

function repoChecks() {
  // ES5 lint + no-network + forbidden words over what we wrote and ship (tests excluded from
  // the forbidden-word rule: they may name the words they forbid).
  var shippedSrc = repoFiles(['desktop', 'shared', 'player'], ['.js', '.html', '.css', '.json', '.lua']).filter(function (f) {
    return !/(^|\/)test\//.test(f.rel) && !/design-preview\.html$/.test(f.rel);
  });
  sourceRules(shippedSrc, 'repo');
  var tooling = repoFiles(['packaging', 'tools/fetch-binaries.js', 'tools/fetch-models.js', 'tools/verify-bundle.js', 'tools/lint-es5.js'], ['.js']);
  tooling.forEach(function (f) {
    lint.scanSource(f.text).forEach(function (h) { problem('repo: ES5 ' + f.rel + ':' + h.line + ':' + h.col + ' ' + h.rule); });
  });
  // the whole default lint target set, tests included, exactly as `npm run lint` sees it
  repoFiles(['shared', 'desktop', 'player'], ['.js']).forEach(function (f) {
    if (lint.isVendor && lint.isVendor(f.rel)) { return; }
    if (/(^|\/)test\//.test(f.rel)) { lint.scanSource(f.text).forEach(function (h) { problem('repo: ES5 ' + f.rel + ':' + h.line + ':' + h.col + ' ' + h.rule); }); }
  });
}

/* ---------- bundle checks ---------- */

function targetOf(res, given) {
  var lock;
  if (given) { return given; }
  try { lock = JSON.parse(fs.readFileSync(path.join(res, 'bin', binaries.LOCK), 'utf8')); } catch (e) { return null; }
  return lock.target;
}

function checkBin(res, target, opts) {
  var dir = path.join(res, 'bin'), shippedLock, repoLock, exe = target.indexOf('win32') === 0 ? '.exe' : '', table = binaries.loadTable();
  try { shippedLock = JSON.parse(fs.readFileSync(path.join(dir, binaries.LOCK), 'utf8')); } catch (e) { problem('bin/' + binaries.LOCK + ' missing or unreadable'); return; }
  try { repoLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'bin', target, binaries.LOCK), 'utf8')); } catch (e2) { repoLock = null; }
  if (repoLock && JSON.stringify(repoLock) !== JSON.stringify(shippedLock)) { problem('bin/' + binaries.LOCK + ' differs from bin/' + target + '/' + binaries.LOCK); }
  if (shippedLock.target !== target) { problem('bin/ is for ' + shippedLock.target + ', expected ' + target); }
  Object.keys(shippedLock.archives || {}).forEach(function (id) {
    var a = table.archives[id];
    if (!a) { problem('bin lock names unknown archive ' + id); return; }
    if (/^[0-9a-f]{64}$/.test(a.sha256)) {
      if (a.sha256 !== shippedLock.archives[id].sha256) { problem('bin/' + id + ' came from sha256 ' + shippedLock.archives[id].sha256 + ' but the pin is ' + a.sha256); }
    } else if (lib.isCI()) { problem('bin/' + id + ' is not pinned in packaging/binaries.json'); }
  });
  Object.keys(shippedLock.files).forEach(function (rel) {
    var f = shippedLock.files[rel];
    if (!lib.fileMatches(path.join(dir, rel), f.sha256, f.size)) { problem('bin/' + rel + (fs.existsSync(path.join(dir, rel)) ? ' does not match its lock' : ' is missing')); } else { ok('bin/' + rel); }
  });
  ['mpv', 'ffmpeg', 'ffprobe', 'whisper-cli'].forEach(function (n) {
    var p = path.join(dir, n + exe), st;
    if (!fs.existsSync(p)) {
      if (n === 'whisper-cli' && opts.allowMissingBuild) { lib.log('warning   bin/whisper-cli' + exe + ' missing (allowed)'); return; }
      problem('bin/' + n + exe + ' missing');
      return;
    }
    st = fs.statSync(p);
    if (!exe && !(st.mode & 73)) { problem('bin/' + n + ' is not executable'); }
    if (!shippedLock.files[n + exe]) { problem('bin/' + n + exe + ' is not covered by the lock'); }
  });
  lib.walkFiles(dir).forEach(function (rel) {
    if (rel !== binaries.LOCK && !shippedLock.files[rel]) { problem('bin/' + rel + ' is not in the lock'); }
  });
}

function checkAnalyzer(res, target, opts) {
  var dir = path.join(res, 'analyzer'), exe = path.join(dir, 'bonis-analyzer' + (target.indexOf('win32') === 0 ? '.exe' : ''));
  var internal = path.join(dir, '_internal'), r, line, v;
  if (!fs.existsSync(exe)) { problem('analyzer/' + path.basename(exe) + ' missing'); return; }
  if (!fs.existsSync(internal)) { problem('analyzer/_internal missing (PyInstaller onedir)'); return; }
  ['en.json', 'es.json'].forEach(function (n) { sameAsRepo(path.join(internal, 'lexicon', n), path.join(ROOT, 'spec', 'lexicon', n), 'analyzer lexicon ' + n); });
  ['clip_prompts.npz', 'yamnet_class_map.csv', 'florence_prompts.json'].forEach(function (n) { sameAsRepo(path.join(internal, 'models', n), path.join(ROOT, 'analyzer', 'models', n), 'analyzer models/' + n); });
  if (lib.walkFiles(internal).some(function (r2) { return /(^|\/)(torch|tkinter|_tkinter)/i.test(r2) || /libtorch|tcl8|tk8/i.test(r2); })) { problem('analyzer bundle contains PyTorch or tkinter'); }
  if (opts.runAnalyzer) {
    r = childProcess.spawnSync(exe, ['version'], { encoding: 'utf8', timeout: 120000, env: process.env });
    line = String(r.stdout || '').trim().split('\n').pop();
    try { v = JSON.parse(line); } catch (e) { v = null; }
    if (r.status !== 0 || !v || v.t !== 'version' || !v.onnxruntime) { problem('analyzer `version` failed (exit ' + r.status + '): ' + String(r.stderr || '').slice(-300)); } else {
      ok('analyzer version ' + v.analyzer + ', onnxruntime ' + v.onnxruntime + ', llama.cpp ' + (v.llamaCpp || 'absent'));
      lib.log('analyzer  ' + line);
    }
  }
}

function checkModels(res) {
  var dir = path.join(res, 'models'), want = models.shipped(), names = {};
  if (!fs.existsSync(dir)) { problem('models/ missing'); return; }
  want.forEach(function (f) {
    names[f.file] = true;
    if (!lib.fileMatches(path.join(dir, f.file), f.sha256, f.size)) { problem('models/' + f.file + (fs.existsSync(path.join(dir, f.file)) ? ' does not match the manifest' : ' is missing')); } else { ok('models/' + f.file); }
  });
  lib.walkFiles(dir).forEach(function (rel) { if (!names[rel]) { problem('models/' + rel + ' is not a shipped model (build-only or stray file)'); } });
}

function checkResources(res) {
  sameAsRepo(path.join(res, 'player', 'bonis.lua'), path.join(ROOT, 'player', 'bonis.lua'), 'player/bonis.lua');
  ['en.json', 'es.json'].forEach(function (n) { sameAsRepo(path.join(res, 'spec', 'lexicon', n), path.join(ROOT, 'spec', 'lexicon', n), 'spec/lexicon/' + n); });
  fs.readdirSync(path.join(ROOT, 'docs', 'HELP')).forEach(function (n) { sameAsRepo(path.join(res, 'help', n), path.join(ROOT, 'docs', 'HELP', n), 'help/' + n); });
  sameAsRepo(path.join(res, 'help', 'LICENSES.md'), path.join(ROOT, 'docs', 'LICENSES.md'), 'help/LICENSES.md');
  sameAsRepo(path.join(res, 'help', 'BINARIES.md'), path.join(ROOT, 'packaging', 'BINARIES.md'), 'help/BINARIES.md');
}

function checkAsar(res) {
  var asarFile = path.join(res, 'app.asar'), a, pkg, files = [], rels;
  if (!fs.existsSync(asarFile)) { problem('app.asar missing (asar must be on)'); return; }
  a = readAsar(asarFile);
  rels = Object.keys(a.files);
  try { pkg = JSON.parse(a.read('package.json').toString('utf8')); } catch (e) { problem('app.asar has no readable package.json'); return; }
  if (!a.files[pkg.main]) { problem('package.json main ' + pkg.main + ' is not in app.asar'); }
  ['desktop/main/main.js', 'desktop/preload.js', 'desktop/renderer/index.html', 'desktop/locales/en-US.json', 'desktop/locales/es-MX.json', 'shared/skipfile.js', 'shared/fingerprint.js'].forEach(function (p) {
    if (!a.files[p]) { problem('app.asar lacks ' + p); }
  });
  fs.readdirSync(path.join(ROOT, 'desktop', 'renderer', 'assets', 'fonts')).forEach(function (n) {
    var b = a.read('desktop/renderer/assets/fonts/' + n);
    if (!b) { problem('font ' + n + ' missing from app.asar'); return; }
    if (lib.sha256Buffer(b) !== lib.sha256File(path.join(ROOT, 'desktop', 'renderer', 'assets', 'fonts', n))) { problem('font ' + n + ' differs from the repository'); } else { ok('font ' + n); }
  });
  rels.forEach(function (r) {
    if (/(^|\/)(test|tests|fixtures|e2e)\//.test(r) || /^docs\//.test(r) || /design-preview\.html$/.test(r) || /\.map$/.test(r) ||
        /^(analyzer|extension|packaging|tools|spec|bin|dist|build)\//.test(r)) { problem('app.asar contains ' + r + ' (should be excluded)'); }
    if (/\.(js|html|css|json)$/.test(r) && !a.files[r].link) { files.push({ rel: r, text: a.read(r).toString('utf8') }); }
  });
  sourceRules(files, 'app.asar');
  lib.log('app.asar  ' + rels.length + ' file(s)');
}

function dirSize(d) {
  var t = 0;
  lib.walkFiles(d).forEach(function (r) { t += fs.lstatSync(path.join(d, r)).size; });
  return t;
}

function parseArgs(argv) {
  var o = { dir: null, target: null, runAnalyzer: false, allowMissingBuild: false, repoChecks: true, repoOnly: false }, i;
  for (i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') { o.target = argv[++i]; } else if (argv[i] === '--run-analyzer') { o.runAnalyzer = true; } else if (argv[i] === '--allow-missing-build') { o.allowMissingBuild = true; } else if (argv[i] === '--no-repo-checks') { o.repoChecks = false; } else if (argv[i] === '--repo-only') { o.repoOnly = true; } else if (argv[i].charAt(0) === '-') { throw new Error('unknown option ' + argv[i]); } else { o.dir = argv[i]; }
  }
  return o;
}

function main(argv) {
  var o, res, target;
  try { o = parseArgs(argv); } catch (e) { lib.log(e.message); process.exitCode = 2; return; }
  if (o.repoChecks || o.repoOnly) { repoChecks(); }
  if (!o.repoOnly) {
    if (!o.dir) { lib.log('usage: node tools/verify-bundle.js <built app dir> [--target win32-x64] [--run-analyzer]'); process.exitCode = 2; return; }
    res = findResources(path.resolve(o.dir));
    if (!res) { problem('no Resources folder with app.asar under ' + o.dir); } else {
      target = targetOf(res, o.target);
      if (!target) { problem('cannot tell the target: pass --target or ship bin/' + binaries.LOCK); } else {
        lib.log('bundle    ' + res + ' (' + target + ')');
        checkBin(res, target, o);
        checkAnalyzer(res, target, o);
        checkModels(res);
        checkResources(res);
        checkAsar(res);
        ['bin', 'analyzer', 'models'].forEach(function (d) {
          if (fs.existsSync(path.join(res, d))) { lib.log('size      ' + d + '/ ' + (dirSize(path.join(res, d)) / 1048576).toFixed(1) + ' MiB'); }
        });
      }
    }
  }
  lib.log(problems.length ? problems.length + ' problem(s)' : (o.repoOnly ? 'repository checks ok' : 'bundle ok (' + oks + ' checks)'));
  process.exitCode = problems.length ? 1 : 0;
}

module.exports = { readAsar: readAsar, forbiddenHits: forbiddenHits, stripJsComments: stripJsComments, findResources: findResources };

if (require.main === module) { main(process.argv.slice(2)); }
