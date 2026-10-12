/*
 * bonis oculis - fake analyzer for tests and UI development (no models, no detection).
 *
 *   node tools/fake-analyzer.js scan --input <video> --work <dir> --out <skip.json>
 *        [--lang es-MX] [--levels '{"nudity":"strict",...}']
 *        [--stages subtitles,frames,audio,speech,captions (default: all five)]
 *        [--threads N] [--priority low] [--device auto] [--models DIR] [--restart]
 *        [--force-speech] [--whisper-cli EXE] [--caption-budget N | --thorough] [--profile]
 *        [--scores-from JSON] (accepted, ignored)
 *        test flags: [--crash-at 0.5] [--crash-always] [--slow] [--fail-code 2|3] [--steps 10]
 *   node tools/fake-analyzer.js evaluate --truth a.bonis.json --pred b.bonis.json [--tolerance 3] [--out r.json]
 *
 * Stages run in the analyzer's order: subtitles, speech, frames, audio, lm, captions, fusion
 * (lm and fusion always). evaluate is a line-for-line port of bonis_analyzer/evaluate.py: a
 * markdown table on stdout, the JSON report at --out.
 *
 * Speaks the exact PLAN 2.4 protocol: stdout JSON lines
 *   {"t":"progress","stage":..,"p":..,"eta":..} {"t":"stage",..} {"t":"warn",..}
 *   {"t":"paused"} {"t":"resumed"} {"t":"done","out":..} {"t":"error","code":..,"msg":..}
 * exit codes 0 ok, 2 bad input, 3 model missing, 4 interrupted (resumable), 5 internal.
 * Honours <work>/PAUSE (polled every 50 ms). Checkpoints to <work>/fake-state.json after every
 * step, so a restart resumes where it stopped. --crash-at p exits with code 5 when overall
 * progress reaches p, once (or every run with --crash-always). --slow makes each step 150 ms.
 * A file name containing "[clean]" gives a skip file with no ranges (the title becomes Protected
 * at once) and steps of at least 80 ms, so tests can watch a scan finish.
 * The result is a valid skip file (shared/skipfile.js) with three synthetic ranges, plus blurred
 * 160 px thumbnails in <work>/thumbs/<rangeId>.jpg when ffmpeg is available.
 * ES5, Node only.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var skipfile = require('../shared/skipfile.js');
var fingerprint = require('../shared/fingerprint.js');

var STEPS_PER_STAGE = 10;
var KNOWN = ['subtitles', 'frames', 'audio', 'speech', 'captions'];

function out(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { /* supervisor gone */ }
}

var ALL_STAGES = ['subtitles', 'frames', 'audio', 'speech', 'captions'];
var RUN_ORDER = ['subtitles', 'speech', 'frames', 'audio', 'lm', 'captions', 'fusion'];
var VALUE_FLAGS = { '--input': 'input', '--work': 'work', '--out': 'out', '--lang': 'lang', '--levels': 'levels', '--stages': 'stages',
  '--threads': null, '--priority': null, '--device': null, '--models': null, '--whisper-cli': null, '--scores-from': null,
  '--caption-budget': 'captionBudget', '--crash-at': 'crashAt', '--fail-code': 'failCode', '--steps': 'steps',
  '--truth': 'truth', '--pred': 'pred', '--tolerance': 'tolerance' };
var BOOL_FLAGS = { '--crash-always': 'crashAlways', '--slow': 'slow', '--restart': 'restart', '--force-speech': 'forceSpeech',
  '--thorough': 'thorough', '--profile': 'profile' };

function parseArgs(argv) {
  var a = { cmd: 'scan', stages: ALL_STAGES.join(','), lang: 'es-MX', levels: null, crashAt: null, failCode: null, steps: STEPS_PER_STAGE, tolerance: 3 };
  var i, k;
  for (i = 0; i < argv.length; i++) {
    k = argv[i];
    if (k === 'scan' || k === 'evaluate') { a.cmd = k; continue; }
    if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS, k)) { a[BOOL_FLAGS[k]] = true; continue; }
    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, k)) {
      if (i + 1 >= argv.length) { return { error: 'missing value for ' + k }; }
      if (VALUE_FLAGS[k]) { a[VALUE_FLAGS[k]] = argv[i + 1]; }
      i++;
      continue;
    }
    return { error: 'unknown argument ' + k };
  }
  a.crashAt = a.crashAt === null ? null : parseFloat(a.crashAt);
  a.failCode = a.failCode === null ? null : parseInt(a.failCode, 10);
  a.steps = Math.max(1, parseInt(a.steps, 10) || STEPS_PER_STAGE);
  a.tolerance = parseFloat(a.tolerance);
  if (!isFinite(a.tolerance) || a.tolerance < 0) { return { error: 'bad --tolerance' }; }
  if (a.captionBudget !== undefined && !(parseInt(a.captionBudget, 10) >= 0)) { return { error: 'bad --caption-budget' }; }
  return a;
}

/* ---------------- evaluate (port of analyzer/bonis_analyzer/evaluate.py) ---------------- */

var EVAL_CATS = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language', 'other'];

function round4(x) { return Math.round(x * 10000) / 10000; }
function ratio(a, b) { return b ? round4(a / b) : null; }
function f1(p, r) {
  if (p === null || r === null) { return null; }
  if (p + r === 0) { return 0; }
  return round4(2 * p * r / (p + r));
}
function secondsOf(ranges, n) {
  var set = {};
  ranges.forEach(function (r) {
    var lo = Math.max(0, Math.ceil(r.start - 0.5 - 1e-9));
    var hi = Math.min(n, Math.ceil(r.end - 0.5 - 1e-9));
    var i;
    for (i = lo; i < hi; i++) { set[i] = true; }
  });
  return set;
}
function count(o) { return Object.keys(o).length; }
function overlaps(r, others, tol) { return others.some(function (o) { return o.start < r.end + tol && o.end > r.start - tol; }); }

function loadDoc(file) {
  var text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: 'file not found: ' + file }; }
  var res = skipfile.fromJson(text);
  if (!res.ok) { return { error: file + ' is not a valid skip file' }; }
  return { doc: res.doc };
}

function evaluateDocs(t, p, tol) {
  var tr = skipfile.enforced(t);
  var pr = skipfile.enforced(p);
  var dur = Math.max(Number(t.media.duration) || 0, Number(p.media.duration) || 0, 0);
  tr.concat(pr).forEach(function (r) { if (r.end > dur) { dur = r.end; } });
  var n = Math.ceil(dur);
  var rows = {};
  var cats = EVAL_CATS.filter(function (c) { return tr.concat(pr).some(function (r) { return r.category === c; }); });
  cats.concat(['all']).forEach(function (c) {
    var tc = tr.filter(function (r) { return c === 'all' || r.category === c; });
    var pc = pr.filter(function (r) { return c === 'all' || r.category === c; });
    var ts = secondsOf(tc, n);
    var ps = secondsOf(pc, n);
    var tp = Object.keys(ts).filter(function (k) { return ps[k]; }).length;
    var prec = ratio(tp, count(ps));
    var rec = ratio(tp, count(ts));
    var hits = tc.filter(function (r) { return overlaps(r, pc, tol); }).length;
    var good = pc.filter(function (r) { return overlaps(r, tc, tol); }).length;
    rows[c] = {
      truthSeconds: count(ts), predSeconds: count(ps), truePositiveSeconds: tp,
      precision: prec, recall: rec, f1: f1(prec, rec),
      truthRanges: tc.length, predRanges: pc.length,
      rangeHitRate: ratio(hits, tc.length), rangePrecision: ratio(good, pc.length),
      secondsMissed: count(ts) - tp, secondsFalselyFlagged: count(ps) - tp
    };
  });
  return { tolerance: tol, durationSeconds: n, categories: rows };
}

// Rates are floats in the Python report (always 3 decimals); counts are integers.
var RATE_KEYS = ['precision', 'recall', 'f1', 'rangeHitRate'];
function fmt(v, key) {
  if (v === null || v === undefined) { return '-'; }
  if (RATE_KEYS.indexOf(key) >= 0) { return v.toFixed(3); }
  return String(v);
}

function markdown(rep) {
  var cols = [['category', null], ['precision', 'precision'], ['recall', 'recall'], ['F1', 'f1'], ['range hit rate', 'rangeHitRate'],
    ['truth ranges', 'truthRanges'], ['pred ranges', 'predRanges'], ['s missed', 'secondsMissed'], ['s falsely flagged', 'secondsFalselyFlagged']];
  var lines = ['| ' + cols.map(function (c) { return c[0]; }).join(' | ') + ' |', '|' + cols.map(function () { return '---'; }).join('|') + '|'];
  Object.keys(rep.categories).forEach(function (cat) {
    var row = rep.categories[cat];
    lines.push('| ' + [cat].concat(cols.slice(1).map(function (c) { return fmt(row[c[1]], c[1]); })).join(' | ') + ' |');
  });
  lines.push('');
  lines.push('1-second resolution; range hit rate uses a tolerance of +-' + rep.tolerance + ' s.');
  return lines.join('\n');
}

function runEvaluate(a) {
  if (!a.truth || !a.pred) { fail(2, 'missing --truth or --pred'); return; }
  var t = loadDoc(a.truth);
  if (t.error) { fail(2, t.error); return; }
  var p = loadDoc(a.pred);
  if (p.error) { fail(2, p.error); return; }
  var rep = evaluateDocs(t.doc, p.doc, a.tolerance);
  if (a.out) {
    try {
      fs.writeFileSync(a.out + '.tmp', JSON.stringify(rep, null, 1) + '\n');
      fs.renameSync(a.out + '.tmp', a.out);
    } catch (e) { fail(5, 'internal error: cannot write the report'); return; }
  }
  process.stdout.write(markdown(rep) + '\n');
  process.exit(0);
}

function fail(code, msg) {
  out({ t: 'error', code: code, msg: msg });
  process.exit(code);
}

function bin(name, envName) { return process.env[envName] || name; }

function probeDuration(file) {
  try {
    var r = childProcess.spawnSync(bin('ffprobe', 'BONIS_FFPROBE'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 20000 });
    var d = parseFloat(String(r.stdout || '').trim());
    if (r.status === 0 && isFinite(d) && d > 0) { return d; }
  } catch (e) { /* no ffprobe */ }
  return 600;
}

function thumb(input, t, file) {
  try {
    var r = childProcess.spawnSync(bin('ffmpeg', 'BONIS_FFMPEG'), ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', t.toFixed(3), '-i', input,
      '-frames:v', '1', '-vf', 'scale=160:-2,boxblur=10:1', '-q:v', '5', '-update', '1', '-f', 'image2', file], { timeout: 30000 });
    return r.status === 0;
  } catch (e) { return false; }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { done: 0, crashed: false }; }
}

function writeState(file, st) {
  var tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, file);
}

// Synthetic scene cuts every 5 s (the real analyzer finds them in the picture).
function sceneCuts(duration) {
  var out = [];
  var t;
  for (t = 0; t < duration; t += 5) { out.push(t); }
  return out;
}

function levelsOf(text) {
  var lv = { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'off' };
  if (!text) { return lv; }
  var o;
  try { o = JSON.parse(text); } catch (e) { return null; }
  if (!o || typeof o !== 'object') { return null; }
  Object.keys(o).forEach(function (k) { if (lv[k] && skipfile.LEVELS.indexOf(o[k]) >= 0) { lv[k] = o[k]; } });
  return lv;
}

function main() {
  var a = parseArgs(process.argv.slice(2));
  if (a.error) { fail(2, a.error); return; }
  if (a.failCode) { fail(a.failCode, 'simulated failure ' + a.failCode); return; }
  if (a.cmd === 'evaluate') { runEvaluate(a); return; }
  if (!a.input || !a.work || !a.out) { fail(2, 'missing --input, --work or --out'); return; }
  if (!fs.existsSync(a.input)) { fail(2, 'input not found'); return; }
  var requested = a.stages.split(',').filter(function (s) { return s; });
  if (!requested.length || requested.some(function (s) { return KNOWN.indexOf(s) < 0; })) { fail(2, 'bad --stages'); return; }
  var stages = RUN_ORDER.filter(function (s) { return s === 'lm' || s === 'fusion' || requested.indexOf(s) >= 0; });
  var t0 = Date.now();
  var levels = levelsOf(a.levels);
  if (!levels) { fail(2, '--levels is not valid JSON'); return; }
  try { fs.mkdirSync(a.work, { recursive: true }); } catch (e) { fail(2, 'cannot create work dir'); return; }

  var stateFile = path.join(a.work, 'fake-state.json');
  var pauseFile = path.join(a.work, 'PAUSE');
  var st = readState(stateFile);
  var total = stages.length * a.steps;
  var clean = /\[clean\]/i.test(path.basename(a.input));
  var delay = a.slow ? 150 : (clean ? 80 : 15);
  var paused = false;

  process.on('SIGTERM', function () {
    writeState(stateFile, st);
    out({ t: 'error', code: 4, msg: 'scan interrupted; it will resume from the checkpoint' });
    process.exit(4);
  });
  process.on('SIGINT', function () { process.exit(4); });

  if (st.done > 0) { out({ t: 'warn', msg: 'resuming from checkpoint at step ' + st.done }); }

  function step() {
    if (fs.existsSync(pauseFile)) {
      if (!paused) { paused = true; out({ t: 'paused' }); }
      setTimeout(step, 50);
      return;
    }
    if (paused) { paused = false; out({ t: 'resumed' }); }
    if (st.done >= total) { finish(); return; }
    var p = (st.done + 1) / total;
    if (a.crashAt !== null && p >= a.crashAt && (a.crashAlways || !st.crashed) && st.done / total < a.crashAt) {
      st.crashed = true;
      writeState(stateFile, st);
      process.stderr.write('fake analyzer: simulated crash\n');
      process.exit(5);
      return;
    }
    st.done++;
    var si = Math.min(stages.length - 1, Math.floor((st.done - 1) / a.steps));
    var sp = (st.done - si * a.steps) / a.steps;
    if (st.done - si * a.steps === 1) { out({ t: 'stage', stage: stages[si], status: 'running' }); }
    out({ t: 'progress', stage: stages[si], p: Math.round(sp * 1000) / 1000, eta: Math.round((total - st.done) * delay / 1000) });
    if (sp >= 1) { out({ t: 'stage', stage: stages[si], status: 'done' }); }
    writeState(stateFile, st);
    setTimeout(step, delay);
  }

  function finish() {
    var duration = probeDuration(a.input);
    fingerprint.fingerprint(a.input, function (err, fp) {
      if (err) { fail(2, 'input unreadable'); return; }
      var base = path.basename(a.input);
      var now = new Date().toISOString();
      var specs = [
        { cat: 'nudity', at: 0.2, conf: 0.92, intensity: 3, sig: { frames: 0.95, subtitles: 0.2 }, note: { en: 'Nudity detected in the picture.', es: 'Se detectó desnudez en la imagen.' } },
        { cat: 'kissing', at: 0.45, conf: 0.66, intensity: 1, sig: { frames: 0.6, subtitles: 0.5 }, note: { en: 'The picture and dialogue suggest kissing.', es: 'La imagen y el diálogo sugieren besos.' } },
        { cat: 'gore', at: 0.7, conf: 0.71, intensity: 2, sig: { frames: 0.74 }, note: { en: 'A violent injury may be shown.', es: 'Podría mostrarse una herida violenta.' } }
      ];
      var len = Math.max(2, duration * 0.04);
      if (clean) { specs = []; }
      var ranges = specs.map(function (s, i) {
        var start = Math.round(duration * s.at * 100) / 100;
        var r = skipfile.newRange({
          id: 'rfake000' + (i + 1), start: start, end: Math.min(duration, Math.round((start + len) * 100) / 100), category: s.cat,
          confidence: s.conf, action: levels[s.cat] === 'off' ? 'none' : 'skip', source: 'auto', review: 'pending'
        });
        r.intensity = s.intensity;
        r.cutStart = Math.floor(start / 5) * 5;
        r.cutEnd = Math.min(duration, Math.ceil(r.end / 5) * 5);
        r.signals = s.sig;
        r.note = /^es/.test(a.lang) ? s.note.es : s.note.en;
        return r;
      });
      var stageInfo = {};
      KNOWN.forEach(function (s) { stageInfo[s] = requested.indexOf(s) >= 0 ? { status: 'done', progress: 1 } : { status: 'skipped' }; });
      stageInfo.fusion = { status: 'done', progress: 1 };
      var doc = skipfile.newDoc({
        generator: { app: 'bonis oculis', appVersion: '0.1.0', analyzerVersion: 'fake-0.1.0', modelSet: 'fake' },
        media: { title: base.replace(/\.[^.]+$/, '').slice(0, 500), duration: duration, filename: base,
          fingerprint: { size: fp.size, oshash: fp.oshash, headSha256: fp.headSha256, sceneCuts: sceneCuts(duration) } },
        ranges: ranges,
        language: a.lang,
        scan: { status: 'complete', startedAt: now, finishedAt: now, stages: stageInfo, levels: levels, device: 'cpu' }
      });
      doc = skipfile.normalise(doc);
      var v = skipfile.validate(doc);
      if (!v.ok) { fail(5, 'internal error: produced an invalid skip file'); return; }
      var thumbs = path.join(a.work, 'thumbs');
      try { fs.mkdirSync(thumbs, { recursive: true }); } catch (e) { /* exists */ }
      doc.ranges.forEach(function (r) { thumb(a.input, (r.start + r.end) / 2, path.join(thumbs, r.id + '.jpg')); });
      var tmp = a.out + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
        fs.renameSync(tmp, a.out);
      } catch (e2) { fail(5, 'internal error: cannot write output'); return; }
      try { fs.unlinkSync(stateFile); } catch (e3) { /* gone */ }
      out({ t: 'done', out: a.out });
      if (a.profile) {
        var prof = {};
        stages.forEach(function (s) { prof[s] = { wall: Math.round((Date.now() - t0) / stages.length) / 1000, peakRssMB: 50 }; });
        out({ t: 'profile', stages: prof, peakRssMB: 50, framesProcessed: Math.round(duration), shotsCaptioned: a.thorough ? 12 : 3 });
      }
      process.exit(0);
    });
  }

  step();
}

main();
