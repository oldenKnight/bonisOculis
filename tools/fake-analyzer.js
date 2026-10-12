/*
 * bonis oculis - fake analyzer for tests and UI development (no models, no detection).
 *
 *   node tools/fake-analyzer.js scan --input <video> --work <dir> --out <skip.json>
 *        [--lang es-MX] [--levels '{"nudity":"strict",...}'] [--stages subtitles,frames]
 *        [--threads N] [--priority low] [--device auto]
 *        [--crash-at 0.5] [--crash-always] [--slow] [--fail-code 2|3] [--steps 10]
 *
 * Speaks the exact PLAN 2.4 protocol: stdout JSON lines
 *   {"t":"progress","stage":..,"p":..,"eta":..} {"t":"stage",..} {"t":"warn",..}
 *   {"t":"paused"} {"t":"resumed"} {"t":"done","out":..} {"t":"error","code":..,"msg":..}
 * exit codes 0 ok, 2 bad input, 3 model missing, 4 interrupted (resumable), 5 internal.
 * Honours <work>/PAUSE (polled every 50 ms). Checkpoints to <work>/fake-state.json after every
 * step, so a restart resumes where it stopped. --crash-at p exits with code 5 when overall
 * progress reaches p, once (or every run with --crash-always). --slow makes each step 150 ms.
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

function parseArgs(argv) {
  var a = { stages: 'subtitles,frames', lang: 'es-MX', levels: null, crashAt: null, crashAlways: false, slow: false, failCode: null, steps: STEPS_PER_STAGE };
  var i;
  for (i = 0; i < argv.length; i++) {
    var k = argv[i];
    var v = argv[i + 1];
    if (k === 'scan') { continue; }
    if (k === '--input') { a.input = v; i++; } else if (k === '--work') { a.work = v; i++; } else if (k === '--out') { a.out = v; i++; } else if (k === '--lang') { a.lang = v; i++; } else if (k === '--levels') { a.levels = v; i++; } else if (k === '--stages') { a.stages = v; i++; } else if (k === '--threads' || k === '--priority' || k === '--device' || k === '--models') { i++; } else if (k === '--crash-at') { a.crashAt = parseFloat(v); i++; } else if (k === '--crash-always') { a.crashAlways = true; } else if (k === '--slow') { a.slow = true; } else if (k === '--fail-code') { a.failCode = parseInt(v, 10); i++; } else if (k === '--steps') { a.steps = Math.max(1, parseInt(v, 10) || STEPS_PER_STAGE); i++; } else { return { error: 'unknown argument ' + k }; }
  }
  return a;
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
  if (!a.input || !a.work || !a.out) { fail(2, 'missing --input, --work or --out'); return; }
  if (!fs.existsSync(a.input)) { fail(2, 'input not found'); return; }
  var stages = a.stages.split(',').filter(function (s) { return s; });
  if (!stages.length || stages.some(function (s) { return KNOWN.indexOf(s) < 0; })) { fail(2, 'bad --stages'); return; }
  var levels = levelsOf(a.levels);
  if (!levels) { fail(2, '--levels is not valid JSON'); return; }
  try { fs.mkdirSync(a.work, { recursive: true }); } catch (e) { fail(2, 'cannot create work dir'); return; }

  var stateFile = path.join(a.work, 'fake-state.json');
  var pauseFile = path.join(a.work, 'PAUSE');
  var st = readState(stateFile);
  var total = stages.length * a.steps;
  var delay = a.slow ? 150 : 15;
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
      var ranges = specs.map(function (s, i) {
        var start = Math.round(duration * s.at * 100) / 100;
        var r = skipfile.newRange({
          id: 'rfake000' + (i + 1), start: start, end: Math.min(duration, Math.round((start + len) * 100) / 100), category: s.cat,
          confidence: s.conf, action: levels[s.cat] === 'off' ? 'none' : 'skip', source: 'auto', review: 'pending'
        });
        r.intensity = s.intensity;
        r.signals = s.sig;
        r.note = /^es/.test(a.lang) ? s.note.es : s.note.en;
        return r;
      });
      var stageInfo = {};
      KNOWN.forEach(function (s) { stageInfo[s] = stages.indexOf(s) >= 0 ? { status: 'done', progress: 1 } : { status: 'skipped' }; });
      stageInfo.fusion = { status: 'done', progress: 1 };
      var doc = skipfile.newDoc({
        generator: { app: 'bonis oculis', appVersion: '0.1.0', analyzerVersion: 'fake-0.1.0', modelSet: 'fake' },
        media: { title: base.replace(/\.[^.]+$/, '').slice(0, 500), duration: duration, filename: base,
          fingerprint: { size: fp.size, oshash: fp.oshash, headSha256: fp.headSha256 } },
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
      process.exit(0);
    });
  }

  step();
}

main();
