'use strict';
// Supervises the mpv player process (PLAN.md 2.2): spawns mpv with player/bonis.lua, talks JSON
// IPC over a local pipe / unix socket, turns Lua `client-message`s into events, relaunches once
// on a crash at the last known position, and stops mpv on request. Never throws.
//
// `net` is used ONLY for the local IPC pipe/socket (no TCP, no network).

var childProcess = require('child_process');
var net = require('net');
var fs = require('fs');
var os = require('os');
var path = require('path');

var CONNECT_TIMEOUT_MS = 5000;
var CONNECT_RETRY_MS = 100;
var STOP_KILL_MS = 2000;
var CRASH_WINDOW_MS = 60000;
var KID_REFUSED_EXIT = 3;
var EVENTS = ['ready', 'mark', 'panic', 'skipped', 'timepos', 'ended', 'crashed', 'error', 'property'];
var BASE_PROPS = ['time-pos', 'pause', 'path', 'eof-reached'];

var launchCounter = 0;

function noop() {}

var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

function ipcPathFor(n) {
  var id = 'bonis-mpv-' + process.pid + '-' + n;
  if (process.platform === 'win32') { return '\\\\.\\pipe\\' + id; }
  return path.join(os.tmpdir(), id + '.sock');
}

// Reads the skip file once to decide whether blur ranges need copy-back hardware decoding.
function skipfileHasBlur(skipfilePath) {
  if (!skipfilePath) { return false; }
  try {
    var doc = JSON.parse(fs.readFileSync(skipfilePath, 'utf8'));
    var ranges = doc && doc.ranges;
    var i;
    if (!ranges || !ranges.length) { return false; }
    for (i = 0; i < ranges.length; i++) {
      if (ranges[i] && ranges[i].action === 'blur' && ranges[i].review !== 'rejected') { return true; }
    }
  } catch (e) {
    return false;
  }
  return false;
}

function defaultMarksPath(skipfilePath, mediaPath) {
  var base = skipfilePath || mediaPath || path.join(os.tmpdir(), 'bonis');
  return base.replace(/\.json$/i, '') + '.marks.jsonl';
}

function buildArgs(opts, req, ipcPath, resumeAt) {
  var o = req.options;
  var args = [
    '--input-ipc-server=' + ipcPath,
    '--script=' + opts.scriptPath,
    '--script-opts-append=bonis-skipfile=' + (req.skipfile || ''),
    '--script-opts-append=bonis-marks=' + req.marksPath,
    '--script-opts-append=bonis-kidmode=' + (o.kidMode ? '1' : '0'),
    '--script-opts-append=bonis-lang=' + (o.lang === 'es' || /^es/.test(o.lang || '') ? 'es' : 'en'),
    '--hwdec=' + (skipfileHasBlur(req.skipfile) ? 'auto-copy' : 'auto-safe'),
    '--keep-open=yes',
    '--force-window=yes',
    '--osd-level=1',
    '--no-config',
    '--title=bonis oculis'
  ];
  if (opts.savePosition !== false) {
    args.push('--save-position-on-quit');
    if (opts.watchLaterDir) { args.push('--watch-later-dir=' + opts.watchLaterDir); }
  }
  if (opts.vo) { args.push('--vo=' + opts.vo); }
  if (opts.ao) { args.push('--ao=' + opts.ao); }
  if (resumeAt && resumeAt > 0) { args.push('--start=' + resumeAt.toFixed(3)); }
  if (opts.extraArgs && opts.extraArgs.length) { args = args.concat(opts.extraArgs); }
  args.push('--');
  args.push(req.media);
  return args;
}

function createPlayer(options) {
  var opts = {};
  var k;
  var src = options || {};
  for (k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) { opts[k] = src[k]; } }
  opts.mpvPath = opts.mpvPath || 'mpv';
  opts.scriptPath = opts.scriptPath || path.join(__dirname, '..', '..', 'player', 'bonis.lua');
  var log = opts.log || silentLog;
  var timeposInterval = 1000 / (opts.timeposHz || 4);
  var extraProps = opts.observe || [];

  var listeners = {};
  var phase = 'idle';      // idle | starting | playing | stopping
  var req = null;          // current play request
  var cur = null;          // current launch: {proc, sock, pid, ...}
  var lastPos = 0;
  var paused = false;
  var mediaPath = null;
  var eof = false;
  var relaunches = 0;
  var lastRelaunchAt = 0;
  var stopCallbacks = [];

  function emit(name, payload) {
    var fns = listeners[name];
    var i;
    if (!fns) { return; }
    for (i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch (e) { log.error('listener for ' + name + ' threw', e); }
    }
  }

  function on(name, fn) {
    if (typeof fn !== 'function') { return api; }
    if (EVENTS.indexOf(name) < 0) { log.warn('unknown player event ' + name); }
    (listeners[name] = listeners[name] || []).push(fn);
    return api;
  }

  function send(launch, obj) {
    if (!launch || !launch.sock || launch.sockClosed) { return false; }
    try {
      launch.sock.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (e) {
      return false;
    }
  }

  function command(args, cb) {
    var done = typeof cb === 'function' ? cb : noop;
    try {
      var launch = cur;
      if (!launch || !launch.sock) { done(new Error('player not running')); return; }
      var id = ++launch.reqId;
      launch.pending[id] = done;
      if (!send(launch, { command: args, request_id: id })) {
        delete launch.pending[id];
        done(new Error('ipc write failed'));
      }
    } catch (e) {
      done(e);
    }
  }

  function handleClientMessage(launch, args) {
    if (!args || args[0] !== 'bonis' || typeof args[1] !== 'string') { return; }
    var m;
    try { m = JSON.parse(args[1]); } catch (e) { log.warn('bad message from player'); return; }
    if (!m || typeof m.t !== 'string') { return; }
    if (m.t === 'ready') {
      if (launch.readySeq === m.seq) { return; }
      launch.readySeq = m.seq;
      emit('ready', m);
    } else if (m.t === 'mark' || m.t === 'undo') {
      emit('mark', m);
    } else if (m.t === 'panic') {
      emit('panic', m);
    } else if (m.t === 'skipped') {
      emit('skipped', m);
    } else if (m.t === 'error') {
      if (launch.errorSeen === m.code + ':' + m.msg) { return; }
      launch.errorSeen = m.code + ':' + m.msg;
      emit('error', { source: 'player', code: m.code || 'player', msg: m.msg });
    }
  }

  function handleLine(launch, line) {
    var m;
    if (!line) { return; }
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m.request_id !== undefined && m.request_id !== null && launch.pending[m.request_id]) {
      var cb = launch.pending[m.request_id];
      delete launch.pending[m.request_id];
      try {
        if (m.error && m.error !== 'success') { cb(new Error(m.error)); } else { cb(null, m.data); }
      } catch (e2) { log.error('command callback threw', e2); }
      return;
    }
    if (m.event === 'property-change') {
      if (launch !== cur) { return; }
      if (m.name === 'time-pos' && typeof m.data === 'number') {
        lastPos = m.data;
        launch.played = true;
        if (phase === 'starting') { phase = 'playing'; }
        var now = Date.now();
        if (now - launch.lastTimeposEmit >= timeposInterval) {
          launch.lastTimeposEmit = now;
          emit('timepos', m.data);
        }
      } else if (m.name === 'pause') {
        paused = !!m.data;
      } else if (m.name === 'path') {
        mediaPath = m.data || mediaPath;
      } else if (m.name === 'eof-reached') {
        if (m.data === true && !eof) {
          eof = true;
          emit('ended', { reason: 'eof', at: lastPos });
        } else if (m.data !== true) {
          eof = false;
        }
      }
      emit('property', { name: m.name, data: m.data });
    } else if (m.event === 'client-message') {
      handleClientMessage(launch, m.args);
    }
  }

  function onConnected(launch) {
    var i;
    var props = BASE_PROPS.concat(extraProps);
    for (i = 0; i < props.length; i++) {
      send(launch, { command: ['observe_property', i + 1, props[i]] });
    }
    send(launch, { command: ['script-message-to', 'bonis', 'hello'] });
  }

  function connect(launch, done) {
    var started = Date.now();
    function attempt() {
      if (launch.exited || launch !== cur) { done(new Error('player exited')); return; }
      var sock = net.connect(launch.ipcPath);
      var buf = '';
      sock.setEncoding('utf8');
      sock.once('connect', function () {
        launch.sock = sock;
        log.info('ipc connected');
        onConnected(launch);
        done(null);
      });
      sock.on('data', function (chunk) {
        var idx;
        buf += chunk;
        while ((idx = buf.indexOf('\n')) >= 0) {
          handleLine(launch, buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      sock.on('error', function (err) {
        if (launch.sock === sock) { log.warn('ipc error', err && err.code); return; }
        sock.destroy();
        if (Date.now() - started >= CONNECT_TIMEOUT_MS) {
          done(new Error('ipc connect timeout'));
          return;
        }
        launch.retryTimer = setTimeout(attempt, CONNECT_RETRY_MS);
      });
      sock.on('close', function () {
        if (launch.sock === sock) {
          launch.sockClosed = true;
          failPending(launch, new Error('ipc closed'));
        }
      });
    }
    attempt();
  }

  function failPending(launch, err) {
    var ids = Object.keys(launch.pending);
    var i;
    for (i = 0; i < ids.length; i++) {
      var cb = launch.pending[ids[i]];
      delete launch.pending[ids[i]];
      try { cb(err); } catch (e) { /* ignore */ }
    }
  }

  function finishStop() {
    var cbs = stopCallbacks;
    var i;
    stopCallbacks = [];
    for (i = 0; i < cbs.length; i++) {
      try { cbs[i](null); } catch (e) { log.error('stop callback threw', e); }
    }
  }

  function onExit(launch, code, signal) {
    launch.exited = true;
    clearTimeout(launch.retryTimer);
    clearTimeout(launch.killTimer);
    if (launch.sock) { try { launch.sock.destroy(); } catch (e) { /* ignore */ } }
    failPending(launch, new Error('player exited'));
    if (process.platform !== 'win32') { try { fs.unlinkSync(launch.ipcPath); } catch (e2) { /* gone */ } }
    if (launch !== cur) { return; }
    cur = null;
    log.info('mpv exited code=' + code + ' signal=' + signal);

    if (launch.stopping || phase === 'stopping') {
      phase = 'idle';
      emit('ended', { reason: 'stopped', at: lastPos });
      finishStop();
      return;
    }
    if (code === 0) {
      phase = 'idle';
      emit('ended', { reason: 'closed', at: lastPos });
      return;
    }
    if (code === KID_REFUSED_EXIT) {
      phase = 'idle';
      emit('error', { source: 'player', code: 'kid-refused', exitCode: code });
      return;
    }
    if (!launch.played) {
      phase = 'idle';
      emit('error', { source: 'player', code: 'start-failed', exitCode: code, signal: signal });
      return;
    }
    var now = Date.now();
    if (lastRelaunchAt && now - lastRelaunchAt < CRASH_WINDOW_MS) {
      phase = 'idle';
      emit('crashed', { final: true, relaunching: false, at: lastPos, exitCode: code, signal: signal });
      return;
    }
    lastRelaunchAt = now;
    relaunches += 1;
    emit('crashed', { final: false, relaunching: true, at: lastPos, exitCode: code, signal: signal });
    launch_(lastPos, noop);
  }

  function launch_(resumeAt, cb) {
    var n = ++launchCounter;
    var launch = {
      n: n, ipcPath: ipcPathFor(n), proc: null, sock: null, pending: {}, reqId: 0,
      readySeq: null, played: false, exited: false, stopping: false, lastTimeposEmit: 0
    };
    var args = buildArgs(opts, req, launch.ipcPath, resumeAt);
    var called = false;
    function done(err) {
      if (called) { return; }
      called = true;
      try { cb(err || null); } catch (e) { log.error('play callback threw', e); }
    }
    if (process.platform !== 'win32') { try { fs.unlinkSync(launch.ipcPath); } catch (e) { /* none */ } }
    cur = launch;
    phase = 'starting';
    eof = false;
    try {
      launch.proc = childProcess.spawn(opts.mpvPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
    } catch (e2) {
      cur = null;
      phase = 'idle';
      emit('error', { source: 'controller', code: 'spawn-failed', msg: String(e2 && e2.message) });
      done(e2);
      return;
    }
    launch.pid = launch.proc.pid;
    if (launch.proc.stderr) {
      launch.proc.stderr.on('data', function (d) {
        launch.stderrTail = ((launch.stderrTail || '') + d).slice(-4096);
      });
    }
    launch.proc.on('error', function (err) {
      log.error('mpv spawn error', err && err.code);
      if (launch.exited) { return; }
      launch.exited = true;
      if (cur === launch) { cur = null; phase = 'idle'; }
      emit('error', { source: 'controller', code: 'spawn-failed', msg: String(err && err.message) });
      done(err);
      finishStop();
    });
    launch.proc.on('exit', function (code, signal) {
      onExit(launch, code, signal);
      done(new Error('player exited'));
    });
    log.info('mpv spawned pid=' + launch.pid + (resumeAt ? ' resume=' + resumeAt.toFixed(1) : ''));
    connect(launch, function (err) {
      if (err && !launch.exited) {
        emit('error', { source: 'controller', code: 'ipc-timeout', msg: err.message });
      }
      done(err);
    });
  }

  function play(media, skipfile, playOptions, cb) {
    var done = typeof cb === 'function' ? cb : noop;
    try {
      var o = playOptions || {};
      var next = {
        media: media, skipfile: skipfile || '', options: o,
        marksPath: o.marksPath || defaultMarksPath(skipfile, media)
      };
      var start = function () {
        req = next;
        lastPos = o.resumeAt || 0;
        relaunches = 0;
        lastRelaunchAt = 0;
        mediaPath = media;
        launch_(o.resumeAt || 0, done);
      };
      if (cur) { stop(function () { start(); }); } else { start(); }
    } catch (e) {
      log.error('play failed', e);
      done(e);
    }
  }

  function stop(cb) {
    var done = typeof cb === 'function' ? cb : noop;
    try {
      var launch = cur;
      if (!launch) { phase = 'idle'; done(null); return; }
      stopCallbacks.push(done);
      if (launch.stopping) { return; }
      launch.stopping = true;
      phase = 'stopping';
      if (!send(launch, { command: ['quit'] })) {
        try { launch.proc.kill('SIGKILL'); } catch (e) { /* gone */ }
      }
      launch.killTimer = setTimeout(function () {
        if (!launch.exited) {
          log.warn('mpv did not quit; killing');
          try { launch.proc.kill('SIGKILL'); } catch (e2) { /* gone */ }
        }
      }, STOP_KILL_MS);
    } catch (e3) {
      log.error('stop failed', e3);
      done(e3);
    }
  }

  function status() {
    return {
      state: phase,
      pid: cur ? cur.pid : null,
      timePos: lastPos,
      paused: paused,
      path: mediaPath,
      eof: eof,
      relaunches: relaunches,
      kidMode: !!(req && req.options.kidMode),
      marksPath: req ? req.marksPath : null
    };
  }

  // Delivers a message to bonis.lua (`reload <path>`, `set-kidmode 0|1`).
  function scriptMessage(args, cb) {
    command(['script-message-to', 'bonis'].concat(args), cb);
  }

  var api = {
    play: play,
    stop: stop,
    status: status,
    on: on,
    command: command,
    scriptMessage: scriptMessage
  };
  return api;
}

module.exports = { createPlayer: createPlayer, buildArgs: buildArgs, skipfileHasBlur: skipfileHasBlur };
