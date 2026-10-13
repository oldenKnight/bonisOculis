'use strict';
// Runs the analyzer (PLAN 2.4), one scan at a time, from a persisted queue.
//  - spawn: <cmd> <args...> scan --input --work --out --lang --levels --stages --threads --priority low
//    [--thorough]; all five stages unless the parent turned speech-to-text off.
//  - stdout JSON lines: progress / stage / warn / paused / resumed / done / error. stderr = log.
//  - pause = <work>/PAUSE exists, whenever: the parent paused, the player is open (setting), or the
//    laptop runs on battery (setting, Electron powerMonitor).
//  - non-zero exit: restart from the checkpoint up to 3 times (never on 2 bad input / 3 model
//    missing); then the title "Needs attention".
//  - done: the result is merged into the library skip file with BO.skipfile.merge.
//  - progress events at most 4 per second. The queue survives an app restart.
// Never throws.

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var os = require('os');
var BO = require('../../shared/skipfile.js');

var FILE = 'queue.json';
var MAX_RESTARTS = 3;
var PROGRESS_MIN_MS = 250;
var PERSIST_PROGRESS_MS = 5000;
var KILL_GRACE_MS = 3000;
var AUTO_FILE = 'auto.bonis.json';
var ALL_STAGES = ['subtitles', 'frames', 'audio', 'speech', 'captions'];
var RUN_ORDER = ['subtitles', 'speech', 'frames', 'audio', 'lm', 'captions', 'fusion'];

function noop() {}
var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

function createSupervisor(options) {
  var o = options || {};
  var store = o.store;
  var library = o.library;
  var skips = o.skips;
  var paths = o.paths;
  var settings = o.settings;
  var log = o.log || silentLog;
  var emit = o.emit || noop;
  var spawn = o.spawn || childProcess.spawn;
  var power = o.power || null;
  var progressMinMs = o.progressMinMs || PROGRESS_MIN_MS;
  var restartDelayMs = o.restartDelayMs === undefined ? 500 : o.restartDelayMs;

  var queue = [];
  var userPaused = false;
  var playerOpen = false;
  var onBattery = false;
  var cur = null;
  var shuttingDown = false;
  var lastEmit = 0;
  var emitTimer = null;

  function persist() { store.writeEnvelope(FILE, { version: 1, queue: queue.slice(), userPaused: userPaused }); }

  function setting(k, dflt) {
    var v = settings && settings.value ? settings.value(k) : undefined;
    return v === undefined ? dflt : v;
  }

  function pauseReason() {
    if (userPaused) { return 'user'; }
    if (playerOpen && setting('pauseWhilePlaying', true)) { return 'player'; }
    if (onBattery && setting('scanOnlyPluggedIn', true)) { return 'battery'; }
    return null;
  }

  function status() {
    return {
      running: cur ? cur.id : null,
      queue: queue.slice(),
      paused: !!pauseReason(),
      pauseReason: pauseReason(),
      stage: cur ? cur.stage : null,
      p: cur ? cur.p : 0,
      eta: cur ? cur.eta : null,
      restarts: cur ? cur.restarts : 0
    };
  }

  function emitNow() {
    lastEmit = Date.now();
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    emit('scan:progress', status());
  }

  // At most 4 per second; the last state always gets out (trailing timer).
  function emitThrottled(force) {
    var wait = progressMinMs - (Date.now() - lastEmit);
    if (force || wait <= 0) { emitNow(); return; }
    if (!emitTimer) { emitTimer = setTimeout(emitNow, wait); }
  }

  function pauseFile(work) { return path.join(work, 'PAUSE'); }

  function applyPause() {
    var reason = pauseReason();
    if (cur) {
      try {
        if (reason) { fs.writeFileSync(pauseFile(cur.work), reason + '\n'); } else { fs.unlinkSync(pauseFile(cur.work)); }
      } catch (e) { /* already there / already gone */ }
    }
    emitThrottled(true);
    if (!reason) { kick(); }
  }

  function dropFromQueue(id) {
    var i = queue.indexOf(id);
    if (i >= 0) { queue.splice(i, 1); }
    persist();
  }

  function settle(id, doc) {
    var it = library.get(id);
    if (!it) { return; }
    library.applyDoc(id, doc || skips.load(id).doc, BO.validate);
  }

  function attention(id, error) {
    var it = library.get(id);
    if (it) { library.setStatus(id, 'needsAttention', { error: error, progress: 0 }); }
    emit('toast', { kind: 'error', key: 'toast.scanAttention', params: { title: it ? it.title : '' } });
  }

  function lowPriority(pid) {
    try { os.setPriority(pid, os.constants.priority.PRIORITY_LOW); } catch (e) { /* not permitted */ }
  }

  // Every stage by default; the parent can leave out speech-to-text.
  function requestedStages() {
    return ALL_STAGES.filter(function (st) { return st !== 'speech' || setting('listenSpeech', true) !== false; });
  }

  function buildArgs(item, work, out) {
    var cmd = paths.analyzer(setting('analyzerCommand', null));
    var lang = setting('lang', 'es-MX');
    var levels = setting('levels', null);
    var args = cmd.args.concat(['scan', '--input', item.path, '--work', work, '--out', out,
      '--lang', lang === 'en-US' ? 'en-US' : 'es-MX',
      '--levels', JSON.stringify(levels || {}),
      '--stages', requestedStages().join(','),
      '--threads', String(setting('threads', 2)),
      '--priority', 'low']);
    if (setting('thorough', false) === true) { args.push('--thorough'); }
    return { cmd: cmd.cmd, args: args, cwd: cmd.cwd };
  }

  // Progress order as the analyzer runs them (lm and fusion always run).
  function progressStages() {
    var req = requestedStages();
    return RUN_ORDER.filter(function (st) { return st === 'lm' || st === 'fusion' || req.indexOf(st) >= 0; });
  }

  function handleLine(run, line) {
    var m;
    if (!line) { return; }
    try { m = JSON.parse(line); } catch (e) { log.warn('analyzer printed a non-protocol line'); return; }
    if (!m || typeof m.t !== 'string') { return; }
    if (m.t === 'progress') {
      var idx = run.stages.indexOf(m.stage);
      var p = typeof m.p === 'number' ? Math.max(0, Math.min(1, m.p)) : 0;
      run.stage = m.stage;
      run.p = idx >= 0 ? (idx + p) / run.stages.length : run.p;
      run.eta = typeof m.eta === 'number' ? m.eta : null;
      if (Date.now() - run.lastPersist > PERSIST_PROGRESS_MS) {
        run.lastPersist = Date.now();
        library.update(run.id, { progress: run.p, stage: run.stage }, true);
      }
      emitThrottled(false);
    } else if (m.t === 'stage') {
      run.stage = m.stage;
      emitThrottled(m.status === 'done');
    } else if (m.t === 'warn') {
      if (typeof m.msg === 'string' && run.warnings.length < 20) { run.warnings.push(m.msg.slice(0, 300)); }
    } else if (m.t === 'paused' || m.t === 'resumed') {
      run.analyzerPaused = m.t === 'paused';
      emitThrottled(true);
    } else if (m.t === 'done') {
      run.doneOut = typeof m.out === 'string' ? m.out : run.out;
    } else if (m.t === 'error') {
      run.lastError = { code: m.code, msg: String(m.msg || '').slice(0, 300) };
    }
  }

  function readResult(file) {
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    var r = BO.fromJson(text);
    return r.ok ? r.doc : null;
  }

  function finishOk(run) {
    var fresh = readResult(run.doneOut || run.out);
    if (!fresh) { return false; }
    var item = library.get(run.id);
    var old = skips.load(run.id).doc;
    var merged = BO.merge(old, fresh);
    if (item) {
      merged.media.fingerprint.size = item.size;
      merged.media.fingerprint.oshash = item.oshash;
      if (item.headSha256) { merged.media.fingerprint.headSha256 = item.headSha256; }
      if (!old && item.title) { merged.media.title = item.title.slice(0, 500); }
    }
    var res = skips.replace(run.id, merged, false);
    if (!res.ok) { return false; }
    // The analyzer's own result, before the merge with the parent's review: "Check accuracy"
    // compares hand marks with this, never with the reviewed list (planner decision 13).
    try { fs.copyFileSync(run.doneOut || run.out, path.join(run.work, AUTO_FILE)); } catch (e0) { log.warn('auto result not kept'); }
    library.update(run.id, { scannedAt: new Date().toISOString(), progress: 1, stage: null }, true);
    library.applyDoc(run.id, res.doc, BO.validate, true);
    try { fs.unlinkSync(run.doneOut || run.out); } catch (e) { /* keep */ }
    var it = library.get(run.id);
    emit('toast', { kind: 'success', key: it && it.cleanPending ? 'toast.scanDoneClean' : (it && it.status === 'protected' ? 'toast.scanDoneProtected' : 'toast.scanDoneReview'),
      params: { title: it ? it.title : '', count: it ? it.pending : 0 } });
    return true;
  }

  function onExit(run, code, signal) {
    if (cur !== run) { return; }
    clearTimeout(run.killTimer);
    try { fs.unlinkSync(pauseFile(run.work)); } catch (e) { /* none */ }
    cur = null;
    if (run.cancelled) { emitThrottled(true); kick(); return; }
    if (shuttingDown) { return; }
    log.info('analyzer exited code=' + code + ' signal=' + signal);
    if (code === 0 && finishOk(run)) {
      dropFromQueue(run.id);
      emitThrottled(true);
      kick();
      return;
    }
    if (code === 2 || code === 3) {
      dropFromQueue(run.id);
      attention(run.id, code === 2 ? 'badInput' : 'modelMissing');
      emitThrottled(true);
      kick();
      return;
    }
    if (run.stderrTail) { log.warn('analyzer stderr tail', run.stderrTail.slice(-800)); }
    if (run.restarts < MAX_RESTARTS) {
      log.warn('scan stopped; restarting from the checkpoint', run.restarts + 1);
      var restarts = run.restarts + 1;
      var ph = { id: run.id, placeholder: true, work: run.work, stage: run.stage, p: run.p, eta: null, restarts: restarts, restartTimer: null };
      cur = ph;
      ph.restartTimer = setTimeout(function () { if (cur === ph) { start(run.id, restarts); } }, restartDelayMs);
      emitThrottled(true);
      return;
    }
    dropFromQueue(run.id);
    attention(run.id, code === 0 ? 'badOutput' : 'scanFailed');
    emitThrottled(true);
    kick();
  }

  function start(id, restarts) {
    cur = null;
    if (shuttingDown) { return; }
    var item = library.get(id);
    if (!item) { dropFromQueue(id); kick(); return; }
    if (!fs.existsSync(item.path)) {
      dropFromQueue(id);
      attention(id, 'fileMissing');
      kick();
      return;
    }
    var work = paths.workDir(id);
    var out = path.join(work, 'result.bonis.json');
    try { fs.mkdirSync(work, { recursive: true }); } catch (e) { /* exists */ }
    try { fs.unlinkSync(out); } catch (e2) { /* none */ }
    var b = buildArgs(item, work, out);
    var run = {
      id: id, work: work, out: out, proc: null, stages: progressStages(),
      stage: null, p: 0, eta: null, restarts: restarts || 0, warnings: [], lastError: null, doneOut: null,
      stderrTail: '', lastPersist: 0, cancelled: false, analyzerPaused: false
    };
    cur = run;
    if (pauseReason()) {
      try { fs.writeFileSync(pauseFile(work), pauseReason() + '\n'); } catch (e3) { /* best effort */ }
    } else {
      try { fs.unlinkSync(pauseFile(work)); } catch (e4) { /* none */ }
    }
    if (library.get(id).status !== 'scanning') { library.setStatus(id, 'scanning', { progress: 0, stage: null }); }
    log.info('starting scan', id, 'attempt', run.restarts + 1);
    try {
      run.proc = spawn(b.cmd, b.args, { cwd: b.cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e5) {
      log.error('analyzer spawn failed', e5 && e5.message);
      setTimeout(function () { onExit(run, -1, null); }, 0);
      return;
    }
    var exited = false;
    function exitOnce(code, signal) {
      if (exited) { return; }
      exited = true;
      onExit(run, code, signal);
    }
    if (run.proc.pid) { lowPriority(run.proc.pid); }
    var buf = '';
    run.proc.stdout.setEncoding('utf8');
    run.proc.stdout.on('data', function (chunk) {
      var idx;
      buf += chunk;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(run, buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
    });
    run.proc.stderr.setEncoding('utf8');
    run.proc.stderr.on('data', function (d) { run.stderrTail = (run.stderrTail + d).slice(-4096); });
    run.proc.on('error', function (err) {
      log.error('analyzer process error', err && err.code);
      exitOnce(-1, null);
    });
    run.proc.on('close', function (code, signal) {
      if (buf.trim()) { handleLine(run, buf.trim()); buf = ''; }
      exitOnce(code, signal);
    });
    emitThrottled(true);
  }

  function kick() {
    if (cur || shuttingDown || !queue.length || pauseReason()) { return; }
    start(queue[0], 0);
  }

  function enqueue(id) {
    var it = library.get(id);
    if (!it) { return { ok: false, error: 'notFound' }; }
    if (queue.indexOf(id) < 0) { queue.push(id); }
    if (it.status !== 'scanning') { library.setStatus(id, 'queued', { progress: 0 }); }
    persist();
    emitThrottled(true);
    kick();
    return { ok: true, data: status() };
  }

  function kill(run) {
    if (!run || !run.proc) { return; }
    try { run.proc.kill('SIGTERM'); } catch (e) { /* gone */ }
    run.killTimer = setTimeout(function () {
      try { run.proc.kill('SIGKILL'); } catch (e2) { /* gone */ }
    }, KILL_GRACE_MS);
  }

  function cancel(id) {
    var wasQueued = queue.indexOf(id) >= 0;
    dropFromQueue(id);
    if (cur && cur.id === id) {
      if (cur.placeholder) { clearTimeout(cur.restartTimer); cur = null; } else { cur.cancelled = true; kill(cur); }
    }
    if (wasQueued || (library.get(id) && (library.get(id).status === 'queued' || library.get(id).status === 'scanning'))) {
      var it = library.get(id);
      if (it) { library.setStatus(id, 'notScanned', { progress: 0 }); settle(id); }
    }
    emitThrottled(true);
    if (!cur) { kick(); }
    return { ok: true, data: status() };
  }

  function pause() { userPaused = true; persist(); applyPause(); return { ok: true, data: status() }; }

  function resume() { userPaused = false; persist(); applyPause(); return { ok: true, data: status() }; }

  function setPlayerOpen(open) { playerOpen = !!open; applyPause(); }

  function setOnBattery(v) { onBattery = !!v; applyPause(); }

  function load() {
    var d = store.readEnvelope(FILE);
    queue = d && Array.isArray(d.queue) ? d.queue.filter(function (id) { return !!library.get(id); }) : [];
    userPaused = !!(d && d.userPaused);
    library.list().forEach(function (it) {
      if (queue.indexOf(it.id) >= 0) {
        if (it.status !== 'queued') { library.setStatus(it.id, 'queued', {}); }
      } else if (it.status === 'queued' || it.status === 'scanning') {
        library.setStatus(it.id, 'notScanned', { progress: 0 });
        settle(it.id);
      }
    });
    if (power) {
      try { onBattery = !!power.isOnBatteryPower(); } catch (e) { onBattery = false; }
      try {
        power.on('on-battery', function () { setOnBattery(true); });
        power.on('on-ac', function () { setOnBattery(false); });
      } catch (e2) { /* no events */ }
    }
    persist();
  }

  function startQueue() { kick(); emitThrottled(true); }

  // App quit: stop the analyzer (it checkpoints on SIGTERM, exit 4) and keep it first in the queue.
  function shutdown(cb) {
    var done = typeof cb === 'function' ? cb : noop;
    shuttingDown = true;
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    var run = cur;
    persist();
    if (!run || !run.proc) {
      if (run && run.restartTimer) { clearTimeout(run.restartTimer); }
      cur = null;
      done();
      return;
    }
    try { fs.writeFileSync(pauseFile(run.work), 'quit\n'); } catch (e) { /* best effort */ }
    var finished = false;
    function end() { if (!finished) { finished = true; done(); } }
    run.proc.once('close', function () { end(); });
    kill(run);
    setTimeout(end, KILL_GRACE_MS + 500);
  }

  return {
    load: load, start: startQueue, enqueue: enqueue, cancel: cancel, pause: pause, resume: resume,
    status: status, setPlayerOpen: setPlayerOpen, setOnBattery: setOnBattery, settingsChanged: applyPause,
    shutdown: shutdown, MAX_RESTARTS: MAX_RESTARTS
  };
}

module.exports = { createSupervisor: createSupervisor, MAX_RESTARTS: MAX_RESTARTS, AUTO_FILE: AUTO_FILE, ALL_STAGES: ALL_STAGES, RUN_ORDER: RUN_ORDER };
