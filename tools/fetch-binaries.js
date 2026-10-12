/*
 * bonis oculis - fetch the pinned third-party executables into bin/<platform>-<arch>/.
 *
 *   node tools/fetch-binaries.js                        current platform/arch
 *   node tools/fetch-binaries.js --platform win32 --arch x64
 *   node tools/fetch-binaries.js --all                  every target in packaging/binaries.json
 *   node tools/fetch-binaries.js --check [...]          verify bin/<target>/ against its lock and
 *                                                       the pins; no network; exit 1 on a problem
 *   node tools/fetch-binaries.js --add-built whisper-cli=PATH --built-commit SHA
 *                                                       adopt a binary built from source (macOS CI)
 *   node tools/fetch-binaries.js --write-pins           (not in CI) record hashes of entries still
 *                                                       marked PIN_ON_FIRST_FETCH in binaries.json
 *   node tools/fetch-binaries.js --sources DIR          download the GPL source list (release time)
 *   options: --cache DIR (default bin/.cache), --out DIR (default bin), --allow-missing-build,
 *            --table FILE (default packaging/binaries.json; tests)
 *
 * What, from where, which version and licence: packaging/binaries.json (data) and
 * packaging/BINARIES.md (prose, GPL source offer). Archives are verified by sha256 + size before
 * anything is extracted; only the listed members are written, under names taken from the table
 * (never from the archive), so a hostile archive cannot write outside bin/<target>/. Each target
 * gets bin/<target>/binaries.lock.json with the sha256 of every file written; verify-bundle.js
 * checks the packaged app against it.
 *
 * In CI (CI=true) an entry whose sha256 is PIN_ON_FIRST_FETCH is refused: pin it once on a
 * machine that can reach the upstream (`--write-pins`) and commit packaging/binaries.json.
 *
 * ES5, CommonJS, Node >= 20, no dependencies (packaging/lib/fetchlib.js). 7z archives need an
 * external 7-Zip (preinstalled on GitHub's Windows runners; `p7zip` / `brew install sevenzip`).
 */
'use strict';

var fs = require('fs');
var path = require('path');
var lib = require('../packaging/lib/fetchlib.js');

var ROOT = path.join(__dirname, '..');
var TABLE_FILE = path.join(ROOT, 'packaging', 'binaries.json');
var tableFile = TABLE_FILE;
var LOCK = 'binaries.lock.json';

function loadTable() { return JSON.parse(fs.readFileSync(tableFile, 'utf8')); }

function fail(msg) { var e = new Error(msg); e.userFacing = true; throw e; }

function parseArgs(argv) {
  var o = { platform: process.platform, arch: process.arch, all: false, check: false, addBuilt: [], builtCommit: null,
    writePins: false, sources: null, cache: path.join(ROOT, 'bin', '.cache'), out: path.join(ROOT, 'bin'), allowMissingBuild: false };
  var i, a, kv;
  for (i = 0; i < argv.length; i++) {
    a = argv[i];
    if (a === '--platform') { o.platform = argv[++i]; } else if (a === '--arch') { o.arch = argv[++i]; } else if (a === '--all') { o.all = true; } else if (a === '--check') { o.check = true; } else if (a === '--add-built') {
      kv = String(argv[++i] || '').split('=');
      if (kv.length < 2 || !kv[0]) { fail('--add-built expects NAME=PATH'); }
      o.addBuilt.push({ name: kv[0], file: kv.slice(1).join('=') });
    } else if (a === '--built-commit') { o.builtCommit = argv[++i]; } else if (a === '--write-pins') { o.writePins = true; } else if (a === '--sources') { o.sources = path.resolve(argv[++i]); } else if (a === '--cache') { o.cache = path.resolve(argv[++i]); } else if (a === '--out') { o.out = path.resolve(argv[++i]); } else if (a === '--allow-missing-build') { o.allowMissingBuild = true; } else if (a === '--table') { tableFile = path.resolve(argv[++i]); } else { fail('unknown argument ' + a); }
  }
  return o;
}

function pinned(sha) { return typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha); }

/* ---------- download into the cache ---------- */

function fetchArchive(table, id, o, pinsFound, cb) {
  var a = table.archives[id], dest;
  if (!a) { cb(new Error('unknown archive ' + id)); return; }
  if (lib.safeRelative(a.file) !== a.file || a.file.indexOf('/') >= 0) { cb(new Error('bad cache file name ' + a.file)); return; }
  dest = path.join(o.cache, a.file);
  if (pinned(a.sha256) && lib.fileMatches(dest, a.sha256, typeof a.size === 'number' ? a.size : undefined)) {
    lib.log('cached    ' + a.file);
    cb(null, dest);
    return;
  }
  if (!pinned(a.sha256)) {
    if (lib.isCI()) {
      cb(new Error(id + ' has no pinned sha256 (' + a.sha256 + '). Refusing in CI: run `node tools/fetch-binaries.js --platform ' +
        o.platform + ' --arch ' + o.arch + ' --write-pins` on a machine that can reach ' + new URL(a.url).hostname + ' and commit packaging/binaries.json.'));
      return;
    }
    lib.log('UNPINNED  ' + id + ': downloading ' + a.url + ' without a hash to check (allowed outside CI only)');
  }
  lib.log('fetching  ' + a.url);
  lib.download(a.url, dest, pinned(a.sha256) ? { sha256: a.sha256, size: typeof a.size === 'number' ? a.size : undefined } : null, function (err, got) {
    if (err) { cb(err); return; }
    if (!pinned(a.sha256)) {
      lib.log('PIN       ' + id + ' sha256=' + got.sha256 + ' size=' + got.size + (o.writePins ? ' (written)' : ' (re-run with --write-pins to record)'));
      pinsFound[id] = got;
    }
    cb(null, dest);
  });
}

/* ---------- extraction ---------- */

function writeFile(stage, rel, data, mode, written, from) {
  var safe = lib.safeRelative(rel), p;
  if (safe !== rel) { fail('refusing unsafe destination ' + JSON.stringify(rel)); }
  if (written[rel]) { fail('two entries write ' + rel); }
  p = lib.inside(stage, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  try { fs.chmodSync(p, (mode & 511) | 384); } catch (e) { /* windows */ }
  written[rel] = { sha256: lib.sha256Buffer(data), size: data.length, from: from };
}

function extractTarget(table, target, files, stage, written) {
  var cacheZip = {}, cacheTar = {}, seven = {}, entries = table.targets[target];
  entries.forEach(function (t) {
    var a = t.archive ? table.archives[t.archive] : null, file = t.archive ? files[t.archive] : null;
    var list, hits, re, data, i;
    if (t.build) { return; }
    if (t.script) {
      if (!table.scripts[t.script]) { fail('unknown script ' + t.script); }
      writeFile(stage, t.dest, Buffer.from(table.scripts[t.script], 'utf8'), 493, written, 'script:' + t.script);
      return;
    }
    if (a.format === 'file') {
      writeFile(stage, t.dest, fs.readFileSync(file), t.mode || 420, written, t.archive);
      return;
    }
    if (a.format === '7z') {
      if (!t.member) { fail('7z entries need an exact member (' + t.archive + ')'); }
      (seven[t.archive] = seven[t.archive] || []).push(t);
      return;
    }
    if (a.format === 'zip') {
      if (!cacheZip[t.archive]) { cacheZip[t.archive] = { buf: fs.readFileSync(file) }; cacheZip[t.archive].list = lib.readZip(cacheZip[t.archive].buf); }
      list = cacheZip[t.archive].list;
      if (t.member) {
        hits = list.filter(function (e) { return e.name === t.member && !e.isDir; });
        if (hits.length !== 1) { fail(t.member + ' not found (exactly once) in ' + a.file); }
        if (hits[0].isLink) { fail(t.member + ' is a symlink in ' + a.file); }
        writeFile(stage, t.dest, lib.zipData(cacheZip[t.archive].buf, hits[0]), t.mode || hits[0].mode || 420, written, t.archive);
        return;
      }
      re = new RegExp(t.match);
      hits = list.filter(function (e) { return !e.isDir && !e.isLink && re.test(e.name); });
      if (hits.length < (t.min || 1)) { fail('pattern ' + t.match + ' matched ' + hits.length + ' member(s) of ' + a.file + ', need ' + (t.min || 1)); }
      if (t.dest && hits.length !== 1) { fail('pattern ' + t.match + ' must match exactly one member of ' + a.file + ' (got ' + hits.length + ')'); }
      for (i = 0; i < hits.length; i++) {
        data = lib.zipData(cacheZip[t.archive].buf, hits[i]);
        writeFile(stage, t.dest || path.posix.join(t.destDir === '.' ? '' : t.destDir, path.posix.basename(hits[i].name)), data, t.mode || hits[i].mode || 493, written, t.archive);
      }
      return;
    }
    if (a.format === 'tar.gz') {
      if (!cacheTar[t.archive]) { cacheTar[t.archive] = lib.readTarGz(file); }
      list = cacheTar[t.archive];
      if (t.member) {
        hits = list.filter(function (e) { return e.name === t.member; });
        if (hits.length !== 1 || hits[0].type !== 'file') { fail(t.member + ' not found as one regular file in ' + a.file); }
        writeFile(stage, t.dest, Buffer.from(hits[0].data), t.mode || hits[0].mode, written, t.archive);
        return;
      }
      hits = list.filter(function (e) { return e.name.indexOf(t.prefix) === 0 && e.name.length > t.prefix.length; });
      if (!hits.length) { fail('nothing under ' + t.prefix + ' in ' + a.file); }
      hits.forEach(function (e) {
        var rel = e.name.slice(t.prefix.length).replace(/\/$/, '');
        if (lib.safeRelative(rel) !== rel) { fail('unsafe member name ' + JSON.stringify(e.name) + ' in ' + a.file); }
        if (e.type === 'dir') { fs.mkdirSync(lib.inside(stage, path.posix.join(t.destDir, rel)), { recursive: true }); return; }
        if (e.type !== 'file') { fail('refusing ' + e.type + ' member ' + e.name + ' in ' + a.file); }
        writeFile(stage, path.posix.join(t.destDir, rel), Buffer.from(e.data), e.mode, written, t.archive);
      });
      return;
    }
    fail('unknown archive format ' + a.format);
  });
  Object.keys(seven).forEach(function (id) {
    var tmp = path.join(stage, '..', path.basename(stage) + '-7z-' + id);
    var members = seven[id].map(function (t) { return t.member; });
    lib.rmrf(tmp);
    lib.extract7z(files[id], members, tmp);
    seven[id].forEach(function (t) {
      var src = lib.inside(tmp, t.member);
      var st = fs.lstatSync(src);
      if (!st.isFile()) { fail(t.member + ' did not come out of ' + table.archives[id].file + ' as a regular file'); }
      writeFile(stage, t.dest, fs.readFileSync(src), t.mode || 493, written, id);
    });
    lib.rmrf(tmp);
  });
}

/* ---------- lock ---------- */

function readLock(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8')); } catch (e) { return null; }
}

function writeLock(dir, lock) {
  var keys = Object.keys(lock.files).sort(), files = {};
  keys.forEach(function (k) { files[k] = lock.files[k]; });
  lock.files = files;
  fs.writeFileSync(path.join(dir, LOCK), JSON.stringify(lock, null, 2) + '\n');
}

/* check(target) -> list of problems (strings) */
function checkTarget(table, target, o) {
  var dir = path.join(o.out, target), lock = readLock(dir), problems = [], entries = table.targets[target];
  if (!entries) { return ['no target ' + target + ' in packaging/binaries.json']; }
  if (!lock) { return [dir + '/' + LOCK + ' missing: run node tools/fetch-binaries.js --platform ' + target.split('-')[0] + ' --arch ' + target.split('-')[1]]; }
  Object.keys(lock.archives || {}).forEach(function (id) {
    var a = table.archives[id];
    if (!a) { problems.push('lock names unknown archive ' + id); return; }
    if (!pinned(a.sha256)) {
      if (lib.isCI()) { problems.push(id + ' is not pinned in packaging/binaries.json'); } else { lib.log('warning   ' + id + ' is not pinned yet (lock has ' + lock.archives[id].sha256 + ')'); }
    } else if (lock.archives[id].sha256 !== a.sha256) { problems.push(id + ': lock was made from sha256 ' + lock.archives[id].sha256 + ', the pin is ' + a.sha256 + ' (re-fetch)'); }
  });
  entries.forEach(function (t) {
    var names = [];
    if (t.dest) { names.push(t.dest); }
    if (t.build && !lock.files[t.dest]) {
      if (!o.allowMissingBuild) { problems.push(t.dest + ' (built from ' + t.build + ') is missing: build it and use --add-built'); }
      return;
    }
    if (t.archive && !lock.archives[t.archive]) { problems.push(t.archive + ' not in the lock (re-fetch)'); }
    if (t.destDir) {
      Object.keys(lock.files).forEach(function (k) { if (lock.files[k].from === t.archive) { names.push(k); } });
    }
    names.forEach(function (n) { if (!lock.files[n]) { problems.push(n + ' not in the lock'); } });
  });
  Object.keys(lock.files).forEach(function (rel) {
    var f = lock.files[rel], p = path.join(dir, rel);
    if (!lib.fileMatches(p, f.sha256, f.size)) { problems.push(rel + (fs.existsSync(p) ? ' does not match its lock hash' : ' is missing')); }
    if (f.from && f.from.indexOf('build:') === 0) {
      var b = table.builds[f.from.slice(6)];
      if (b && pinned(b.commit) && f.commit !== b.commit) { problems.push(rel + ' was built from commit ' + f.commit + ', the pin is ' + b.commit); }
      if (b && !pinned(b.commit) && lib.isCI()) { problems.push(f.from.slice(6) + ' commit is not pinned in packaging/binaries.json'); }
    }
  });
  return problems;
}

/* ---------- commands ---------- */

function writePins(pinsFound, commitPins) {
  var table = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
  Object.keys(pinsFound).forEach(function (id) {
    table.archives[id].sha256 = pinsFound[id].sha256;
    table.archives[id].size = pinsFound[id].size;
  });
  Object.keys(commitPins).forEach(function (b) { table.builds[b].commit = commitPins[b]; });
  fs.writeFileSync(tableFile, JSON.stringify(table, null, 2) + '\n');
}

function fetchTarget(table, target, o, cb) {
  var entries = table.targets[target], ids = [], files = {}, pinsFound = {};
  if (!entries) { cb(new Error('no target ' + target + ' in packaging/binaries.json (have: ' + Object.keys(table.targets).join(', ') + ')')); return; }
  entries.forEach(function (t) { if (t.archive && ids.indexOf(t.archive) < 0) { ids.push(t.archive); } });
  if (lib.isCI()) {
    var unpinned = ids.filter(function (id) { return !pinned(table.archives[id].sha256); });
    if (unpinned.length) {
      cb(new Error(target + ': ' + unpinned.join(', ') + ' not pinned (sha256 ' + lib.PIN + '). Refusing in CI. Pin once with ' +
        '`node tools/fetch-binaries.js --platform ' + o.platform + ' --arch ' + o.arch + ' --write-pins` on a machine that can reach the upstream, then commit packaging/binaries.json.'));
      return;
    }
  }
  fs.mkdirSync(o.cache, { recursive: true });
  (function next(i) {
    if (i < ids.length) {
      fetchArchive(table, ids[i], o, pinsFound, function (err, file) {
        if (err) { cb(err); return; }
        files[ids[i]] = file;
        next(i + 1);
      });
      return;
    }
    var dir = path.join(o.out, target), stage = dir + '.staging', written = {}, old = readLock(dir), lock;
    lib.rmrf(stage);
    fs.mkdirSync(stage, { recursive: true });
    try {
      extractTarget(table, target, files, stage, written);
    } catch (e) { lib.rmrf(stage); cb(e); return; }
    // keep binaries built from source earlier (they are not in any archive)
    if (old) {
      Object.keys(old.files).forEach(function (rel) {
        var f = old.files[rel];
        if (f.from && f.from.indexOf('build:') === 0 && lib.fileMatches(path.join(dir, rel), f.sha256, f.size)) {
          fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
          fs.copyFileSync(path.join(dir, rel), path.join(stage, rel));
          try { fs.chmodSync(path.join(stage, rel), 493); } catch (e2) { /* windows */ }
          written[rel] = f;
        }
      });
    }
    lock = { schema: 1, target: target, table: 'packaging/binaries.json', archives: {}, files: written };
    ids.forEach(function (id) {
      var a = table.archives[id];
      lock.archives[id] = { url: a.url, sha256: pinned(a.sha256) ? a.sha256 : pinsFound[id].sha256 };
    });
    writeLock(stage, lock);
    lib.rmrf(dir);
    fs.renameSync(stage, dir);
    if (o.writePins && Object.keys(pinsFound).length) { writePins(pinsFound, {}); }
    lib.log('ok        ' + target + ': ' + Object.keys(written).length + ' file(s) in ' + path.relative(ROOT, dir));
    cb(null);
  }(0));
}

function addBuilt(table, target, o) {
  var dir = path.join(o.out, target), lock = readLock(dir), entries = table.targets[target];
  if (!lock) { fail('fetch ' + target + ' first (no lock in ' + dir + ')'); }
  o.addBuilt.forEach(function (ab) {
    var t = entries.filter(function (x) { return x.build && x.dest === ab.name; })[0], b, data, commitPins = {};
    if (!t) { fail(ab.name + ' is not a built entry of ' + target); }
    b = table.builds[t.build];
    if (!o.builtCommit || !/^[0-9a-f]{40}$/.test(o.builtCommit)) { fail('--built-commit <40-hex git commit> is required with --add-built'); }
    if (pinned40(b.commit) && b.commit !== o.builtCommit) { fail(t.build + ' built from ' + o.builtCommit + ' but the pin is ' + b.commit); }
    if (!pinned40(b.commit)) {
      if (lib.isCI()) { fail(t.build + ' commit is not pinned (' + b.commit + '); refusing in CI. Pin ' + b.tag + ' = ' + o.builtCommit + ' after checking it upstream.'); }
      lib.log('PIN       ' + t.build + ' commit=' + o.builtCommit + (o.writePins ? ' (written)' : ' (re-run with --write-pins to record)'));
      if (o.writePins) { commitPins[t.build] = o.builtCommit; writePins({}, commitPins); }
    }
    data = fs.readFileSync(path.resolve(ab.file));
    if (lock.files[ab.name]) { delete lock.files[ab.name]; }
    var p = lib.inside(dir, ab.name);
    fs.writeFileSync(p, data);
    try { fs.chmodSync(p, 493); } catch (e) { /* windows */ }
    lock.files[ab.name] = { sha256: lib.sha256Buffer(data), size: data.length, from: 'build:' + t.build, tag: b.tag, commit: o.builtCommit };
    lib.log('added     ' + ab.name + ' (' + t.build + ' ' + b.tag + ' @ ' + o.builtCommit.slice(0, 12) + ')');
  });
  writeLock(dir, lock);
}

function pinned40(c) { return typeof c === 'string' && /^[0-9a-f]{40}$/.test(c); }

function fetchSources(table, o, cb) {
  var list = table.gplSources, sums = [];
  fs.mkdirSync(o.sources, { recursive: true });
  (function next(i) {
    var s, name;
    if (i >= list.length) {
      fs.writeFileSync(path.join(o.sources, 'SHA256SUMS'), sums.join('\n') + '\n');
      lib.log('sources   ' + list.length + ' item(s) in ' + o.sources + ' (publish them next to the release)');
      cb(null);
      return;
    }
    s = list[i];
    name = s.url.replace(/^https:\/\//, '').replace(/[^\w.-]+/g, '_');
    lib.log('fetching  ' + s.url);
    lib.download(s.url, path.join(o.sources, name), pinned(s.sha256) ? { sha256: s.sha256, size: s.size } : null, function (err, got) {
      if (err) { cb(err); return; }
      sums.push(got.sha256 + '  ' + name);
      if (!pinned(s.sha256)) { lib.log('          sha256=' + got.sha256 + (s.floating ? ' (floating branch snapshot)' : '')); }
      next(i + 1);
    });
  }(0));
}

function main(argv) {
  var o, table, targets;
  function done(err) {
    if (err) { lib.log('FAILED    ' + err.message); process.exitCode = 1; }
  }
  try { o = parseArgs(argv); table = loadTable(); } catch (e) { done(e); return; }
  if (o.writePins && lib.isCI()) { done(new Error('--write-pins is not allowed in CI')); return; }
  targets = o.all ? Object.keys(table.targets) : [o.platform + '-' + o.arch];
  if (o.sources) { fetchSources(table, o, done); return; }
  if (o.addBuilt.length) {
    try { addBuilt(table, targets[0], o); } catch (e2) { done(e2); }
    return;
  }
  if (o.check) {
    var bad = 0;
    targets.forEach(function (t) {
      var p = checkTarget(table, t, o);
      p.forEach(function (x) { lib.log('PROBLEM   ' + t + ': ' + x); });
      if (!p.length) { lib.log('ok        ' + t + ' matches its lock and the pins'); }
      bad += p.length;
    });
    process.exitCode = bad ? 1 : 0;
    return;
  }
  (function next(i) {
    if (i >= targets.length) { return; }
    o.platform = targets[i].split('-')[0];
    o.arch = targets[i].split('-')[1];
    fetchTarget(table, targets[i], o, function (err) {
      if (err) { done(err); return; }
      next(i + 1);
    });
  }(0));
}

module.exports = { loadTable: loadTable, checkTarget: checkTarget, LOCK: LOCK, TABLE_FILE: TABLE_FILE };

if (require.main === module) { main(process.argv.slice(2)); }
