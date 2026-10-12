/*
 * bonis oculis - fetch the analyzer's models (analyzer/models/manifest.json) into
 * analyzer/models/ (gitignored), sha256 + size verified.
 *
 *   node tools/fetch-models.js                  download what is missing or wrong
 *   node tools/fetch-models.js --check          verify only, no network; exit 1 on a problem
 *   node tools/fetch-models.js --from DIR       take files from DIR (same file names) when
 *                                               their sha256 matches; download the rest
 *   node tools/fetch-models.js --offline        with --from: never download
 *   node tools/fetch-models.js --with-build-only  also the build-time files (CLIP text encoder
 *                                               and tokenizer, for tools/make-clip-prompts.py)
 *   node tools/fetch-models.js --dest DIR       write into DIR instead of analyzer/models/
 *   node tools/fetch-models.js --print-shipped  JSON list of what the app ships (verify-bundle)
 *
 * NudeNet comes as its PyPI sdist; only nudenet-3.4.2/nudenet/320n.onnx is taken out of it,
 * in memory, as analyzer/models/nudenet-320n.onnx (pinned below). No other member is written,
 * and member names are never used as paths. The tarball itself is not shipped.
 *
 * ES5, CommonJS, Node >= 20, no dependencies (packaging/lib/fetchlib.js).
 */
'use strict';

var fs = require('fs');
var path = require('path');
var lib = require('../packaging/lib/fetchlib.js');

var ROOT = path.join(__dirname, '..');
var MODELS = path.join(ROOT, 'analyzer', 'models');
var MANIFEST = path.join(MODELS, 'manifest.json');

/* Files derived from a downloaded archive. Hash pinned 2026-10-12 from the manifest's tarball. */
var DERIVED = [
  {
    file: 'nudenet-320n.onnx',
    fromArchive: 'nudenet-3.4.2.tar.gz',
    member: 'nudenet-3.4.2/nudenet/320n.onnx',
    sha256: 'c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f',
    size: 12150158,
    license: 'see docs/LICENSES.md (NudeNet licence finding)'
  }
];

/* Committed next to the manifest and shipped with the downloaded models. */
var COMMITTED = ['clip_prompts.npz', 'yamnet_class_map.csv', 'florence_prompts.json', 'manifest.json'];

function readManifest() { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }

/* Manifest entries this run needs (archives that only feed DERIVED files are included). */
function wanted(manifest, withBuildOnly) {
  return manifest.files.filter(function (f) { return withBuildOnly || !f.buildOnly; });
}

/*
 * shipped() -> [{file, sha256, size}] : exactly what <resources>/models/ must hold.
 * Downloaded (not buildOnly, not an archive feeding DERIVED) + DERIVED + COMMITTED (hash of the
 * repository copy).
 */
function shipped() {
  var m = readManifest(), out = [], archives = {};
  DERIVED.forEach(function (d) { archives[d.fromArchive] = true; });
  m.files.forEach(function (f) {
    if (!f.buildOnly && !archives[f.file]) { out.push({ file: f.file, sha256: f.sha256, size: f.size }); }
  });
  DERIVED.forEach(function (d) { out.push({ file: d.file, sha256: d.sha256, size: d.size }); });
  COMMITTED.forEach(function (n) {
    var p = path.join(MODELS, n);
    out.push({ file: n, sha256: lib.sha256File(p), size: fs.statSync(p).size });
  });
  return out;
}

function extractDerived(d, dir) {
  var archive = path.join(dir, d.fromArchive), entries, i, e, data, dest, part;
  entries = lib.readTarGz(archive);
  for (i = 0; i < entries.length; i++) {
    e = entries[i];
    if (e.name === d.member) {
      if (e.type !== 'file') { throw new Error(d.member + ' is not a regular file in ' + d.fromArchive); }
      data = e.data;
      break;
    }
  }
  if (!data) { throw new Error(d.member + ' not found in ' + d.fromArchive); }
  if (lib.sha256Buffer(data) !== d.sha256 || data.length !== d.size) {
    throw new Error(d.file + ': extracted sha256 ' + lib.sha256Buffer(data) + ' does not match the pin ' + d.sha256);
  }
  dest = lib.inside(dir, d.file);
  part = dest + '.part';
  fs.writeFileSync(part, data);
  fs.renameSync(part, dest);
}

function parseArgs(argv) {
  var o = { check: false, from: null, offline: false, withBuildOnly: false, printShipped: false, dest: MODELS };
  var i;
  for (i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') { o.check = true; } else if (argv[i] === '--from') { o.from = argv[++i]; } else if (argv[i] === '--offline') { o.offline = true; } else if (argv[i] === '--with-build-only') { o.withBuildOnly = true; } else if (argv[i] === '--print-shipped') { o.printShipped = true; } else if (argv[i] === '--dest') { o.dest = path.resolve(argv[++i]); } else { throw new Error('unknown argument ' + argv[i]); }
  }
  return o;
}

function main(argv) {
  var o, manifest, list, bad = 0, bytes = 0;
  try { o = parseArgs(argv); } catch (e) { lib.log(e.message); process.exitCode = 2; return; }
  if (o.printShipped) { process.stdout.write(JSON.stringify(shipped(), null, 2) + '\n'); return; }
  manifest = readManifest();
  list = wanted(manifest, o.withBuildOnly);
  fs.mkdirSync(o.dest, { recursive: true });

  function finish() {
    DERIVED.forEach(function (d) {
      var dest = path.join(o.dest, d.file);
      if (lib.fileMatches(dest, d.sha256, d.size)) { lib.log('ok        ' + d.file + ' (from ' + d.fromArchive + ')'); return; }
      if (o.check) { lib.log('MISMATCH  ' + d.file); bad++; return; }
      try { extractDerived(d, o.dest); lib.log('extracted ' + d.file + ' from ' + d.fromArchive + ' (' + d.member + ')'); } catch (e) { lib.log('FAILED    ' + d.file + ': ' + e.message); bad++; }
    });
    lib.log(bad ? bad + ' model file(s) missing or wrong' : 'models ok: ' + list.length + ' download(s) + ' + DERIVED.length + ' extracted, ' + (bytes / 1048576).toFixed(1) + ' MiB verified');
    process.exitCode = bad ? 1 : 0;
  }

  (function next(i) {
    var f, dest, local;
    if (i >= list.length) { finish(); return; }
    f = list[i];
    if (lib.safeRelative(f.file) !== f.file || f.file.indexOf('/') >= 0) { lib.log('BAD NAME  ' + f.file); bad++; next(i + 1); return; }
    dest = path.join(o.dest, f.file);
    if (lib.fileMatches(dest, f.sha256, f.size)) { bytes += f.size; lib.log('ok        ' + f.file); next(i + 1); return; }
    if (o.check) { lib.log((fs.existsSync(dest) ? 'MISMATCH  ' : 'MISSING   ') + f.file); bad++; next(i + 1); return; }
    local = o.from ? path.resolve(o.from, f.file) : null;
    if (local && lib.fileMatches(local, f.sha256, f.size)) {
      fs.copyFileSync(local, dest + '.part');
      fs.renameSync(dest + '.part', dest);
      bytes += f.size;
      lib.log('copied    ' + f.file + ' from ' + o.from);
      next(i + 1);
      return;
    }
    if (local && fs.existsSync(local)) { lib.log('ignored   ' + local + ' (hash does not match the manifest)'); }
    if (o.offline) { lib.log('MISSING   ' + f.file + ' (offline)'); bad++; next(i + 1); return; }
    lib.log('fetching  ' + f.url);
    lib.download(f.url, dest, { sha256: f.sha256, size: f.size }, function (err) {
      if (err) { lib.log('FAILED    ' + f.file + ': ' + err.message); bad++; } else { bytes += f.size; lib.log('ok        ' + f.file); }
      next(i + 1);
    });
  }(0));
}

module.exports = { DERIVED: DERIVED, COMMITTED: COMMITTED, shipped: shipped, MODELS: MODELS };

if (require.main === module) { main(process.argv.slice(2)); }
