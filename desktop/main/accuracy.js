'use strict';
// "Check accuracy" (brief 6.5, LEDGER D13): compare the AUTOMATIC scan of a title (the
// analyzer's own output kept as <userData>/library/<id>.auto.bonis.json, before the parent's review) with a
// hand-marked .bonis.json (the truth) by running the analyzer's
//   evaluate --truth T --pred P --tolerance 3 --out R.json
// The JSON report is the result; the markdown table printed on stdout is kept for "Copy as text".
// The last result per title is stored in library.json (item.accuracy). Never throws.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');
var BO = require('../../shared/skipfile.js');

var TOLERANCE = 3;
var TIMEOUT_MS = 120000;
var KEYS = ['truthSeconds', 'predSeconds', 'truePositiveSeconds', 'precision', 'recall', 'f1', 'truthRanges', 'predRanges',
  'rangeHitRate', 'rangePrecision', 'secondsMissed', 'secondsFalselyFlagged'];

function noop() {}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

// Keeps only the known shape of a report (it is stored and shown, so nothing else gets through).
function cleanReport(rep) {
  if (!rep || typeof rep !== 'object' || !rep.categories || typeof rep.categories !== 'object') { return null; }
  var out = { tolerance: num(rep.tolerance), durationSeconds: num(rep.durationSeconds), categories: {} };
  var cats = BO.CATEGORIES.concat(['all']);
  Object.keys(rep.categories).forEach(function (c) {
    if (cats.indexOf(c) < 0) { return; }
    var row = rep.categories[c] || {};
    var r = {};
    KEYS.forEach(function (k) { r[k] = num(row[k]); });
    out.categories[c] = r;
  });
  return out.categories.all ? out : null;
}

// opts: {paths, settings, library, skips, store, log}
function createAccuracy(opts) {
  var o = opts || {};
  var log = o.log || { info: noop, warn: noop, error: noop };

  // truthPath: an already chosen file. cb(err, result)
  function run(id, truthPath, cb) {
    var done = typeof cb === 'function' ? cb : noop;
    var item = o.library.get(id);
    if (!item) { done('notFound'); return; }
    var current = o.skips.load(id).doc;
    if (!current) { done('noSkip'); return; }
    // The prediction is the automatic scan as the analyzer wrote it, before any review.
    var autoFile = o.paths.autoScan(id);
    var auto = null;
    try { auto = BO.fromJson(fs.readFileSync(autoFile, 'utf8')); } catch (e0) { auto = null; }
    if (!auto || !auto.ok) { done('noAutoScan'); return; }
    var pred = auto.doc;
    var text;
    try {
      var st = fs.statSync(truthPath);
      if (!st.isFile() || st.size > 5 * 1024 * 1024) { done('invalidSkip'); return; }
      text = fs.readFileSync(truthPath, 'utf8');
    } catch (e) { done('invalidSkip'); return; }
    var truth = BO.fromJson(text);
    if (!truth.ok) { done('invalidSkip'); return; }
    // The movie's own list (or an export of it) already holds the scan: comparing it with the scan
    // would always look perfect. Refuse with a plain message.
    if (truth.doc.id === current.id || truth.doc.id === pred.id) { done('sameList'); return; }
    // A copy of the list under a new id still carries the scan's own scenes (round 2, X13).
    var known = {};
    current.ranges.concat(pred.ranges).forEach(function (r) { if (r.source === 'auto') { known[r.id] = true; } });
    if (truth.doc.ranges.some(function (r) { return known[r.id]; })) { done('sameList'); return; }
    var fp = truth.doc.media.fingerprint || {};
    var sameCopy = fp.oshash === item.oshash && fp.size === item.size;

    var tmp = o.paths.tmpDir();
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e2) { /* exists */ }
    var tag = crypto.randomBytes(6).toString('hex');
    var predFile = path.join(tmp, 'eval-' + tag + '-pred.bonis.json');
    var truthFile = path.join(tmp, 'eval-' + tag + '-truth.bonis.json');
    var outFile = path.join(tmp, 'eval-' + tag + '-report.json');
    function cleanup() { [predFile, truthFile, outFile, outFile + '.tmp'].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } }); }
    try {
      fs.writeFileSync(predFile, JSON.stringify(pred));
      fs.writeFileSync(truthFile, JSON.stringify(truth.doc));
    } catch (e3) { cleanup(); done('writeFailed'); return; }

    var cmd = o.paths.analyzer(o.settings.value('analyzerCommand'));
    var args = cmd.args.concat(['evaluate', '--truth', truthFile, '--pred', predFile, '--tolerance', String(TOLERANCE), '--out', outFile]);
    var stdout = '';
    var finished = false;
    var proc;
    function finish(err, res) {
      if (finished) { return; }
      finished = true;
      clearTimeout(timer);
      cleanup();
      done(err, res);
    }
    try {
      proc = childProcess.spawn(cmd.cmd, args, { cwd: cmd.cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e4) { finish('evalFailed'); return; }
    var timer = setTimeout(function () { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } finish('evalFailed'); }, TIMEOUT_MS);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', function (d) { if (stdout.length < 256 * 1024) { stdout += d; } });
    proc.stderr.on('data', function () {});
    proc.on('error', function () { finish('evalFailed'); });
    proc.on('close', function (code) {
      if (code !== 0) {
        log.warn('evaluate exited', code);
        finish(code === 2 ? 'invalidSkip' : 'evalFailed');
        return;
      }
      var rep = null;
      try { rep = cleanReport(JSON.parse(fs.readFileSync(outFile, 'utf8'))); } catch (e5) { rep = null; }
      if (!rep) { finish('evalFailed'); return; }
      var md = stdout.split('\n').filter(function (l) { return /^\|/.test(l) || /resolution/.test(l); }).join('\n');
      var result = {
        at: new Date().toISOString(), truthName: path.basename(truthPath).slice(0, 200), sameCopy: sameCopy,
        autoAt: (pred.scan && pred.scan.finishedAt) || pred.modified || null, compared: 'auto',
        report: rep, markdown: md.slice(0, 20000)
      };
      o.library.update(id, { accuracy: result });
      finish(null, result);
    });
  }

  return { run: run };
}

module.exports = { createAccuracy: createAccuracy, cleanReport: cleanReport, TOLERANCE: TOLERANCE };
