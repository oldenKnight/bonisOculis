'use strict';
// Playback for the app (PLAN 2.2, 5.7). Wraps player-controller.js:
//  - builds the enforced file for playback from the library skip file and the current settings
//    (levels, skip or cover), writes it under userData/play/, and starts mpv with kid mode and
//    the language;
//  - kid mode is fail-closed: only a Protected title with a valid, complete, untampered skip file;
//  - forwards player events to the renderer and merges every mark, undo and panic range into the
//    library skip file at once (autosave), with history entries; the marks file mpv appends to is
//    replayed for anything not seen as an event (e.g. after an app crash);
//  - remembers the resume position per title; scans pause while the player is open.

var fs = require('fs');
var path = require('path');
var BO = require('../../shared/skipfile.js');

var THRESHOLDS = { light: 0.8, moderate: 0.6, strict: 0.4 };
var POS_SAVE_MS = 5000;

function noop() {}
var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

// Pure: the document mpv reads. Parent-reviewed, locked and manual ranges are kept as they are;
// automatic pending ranges follow the current levels; skip becomes the cover action when the
// parent chose not to jump over scenes.
function buildPlaybackDoc(doc, opts) {
  var o = opts || {};
  var levels = o.levels || {};
  var out = JSON.parse(JSON.stringify(doc));
  out.ranges.forEach(function (r) {
    if (r.source === 'auto' && r.locked !== true && r.review === 'pending' && Object.prototype.hasOwnProperty.call(levels, r.category)) {
      var lvl = levels[r.category];
      if (lvl === 'off' || (THRESHOLDS[lvl] && r.confidence < THRESHOLDS[lvl])) {
        r.action = 'none';
      } else if (r.category === 'language' && r.action !== 'none') {
        r.action = 'mute';
      } else if (r.action === 'none') {
        r.action = 'skip';
      }
    }
    if (o.skipScenes === false && r.action === 'skip') { r.action = o.nonSkipAction === 'blur' ? 'blur' : 'hide'; }
  });
  out.summary = BO.summarise(out);
  return out;
}

function writeAtomic(file, text) {
  var tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function createPlayerService(options) {
  var o = options || {};
  var createPlayer = o.createPlayer;
  var paths = o.paths;
  var settings = o.settings;
  var library = o.library;
  var skips = o.skips;
  var supervisor = o.supervisor;
  var activity = o.activity || { add: noop };
  var t = o.t || function (k) { return k; };
  var log = o.log || silentLog;
  var emit = o.emit || noop;
  var player = null;
  var cur = null;

  function playDir() {
    var d = paths.playDir();
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* exists */ }
    return d;
  }

  function send(ev) {
    if (cur) { ev.id = cur.id; ev.kidMode = cur.kidMode; }
    emit('player:event', ev);
  }

  function readLines(file) {
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    var list = [];
    text.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) { return; }
      try { list.push(JSON.parse(line)); } catch (e2) { /* torn last line */ }
    });
    return list;
  }

  // Replays marks the app did not see as events. handled = {rangeId: true}.
  function mergeMarksFile(id, file, handled) {
    var lines = readLines(file);
    var seen = handled || {};
    var final = {};
    var order = [];
    lines.forEach(function (m) {
      if (m.t === 'mark' && m.range && m.range.id) {
        if (!final[m.range.id]) { order.push(m.range.id); }
        final[m.range.id] = { range: m.range, source: 'manual', review: 'pending', event: 'added' };
      } else if (m.t === 'undo' && m.id) {
        delete final[m.id];
      } else if (m.t === 'panic' && m.phase === 'end' && m.range && m.range.id) {
        if (!final[m.range.id]) { order.push(m.range.id); }
        final[m.range.id] = { range: m.range, source: 'panic', review: 'approved', event: 'panic' };
      }
    });
    var added = 0;
    order.forEach(function (rid) {
      var f = final[rid];
      if (!f || seen[rid] || !library.get(id)) { return; }
      var r = skips.addRange(id, { id: rid, start: f.range.start, end: f.range.end, category: 'other', action: 'skip', source: f.source, review: f.review }, f.event);
      if (r.ok) { added++; }
    });
    try { fs.unlinkSync(file); } catch (e) { /* gone */ }
    return added;
  }

  // At app start: anything a crashed session left behind.
  function recover() {
    var d = playDir();
    var names = [];
    try { names = fs.readdirSync(d); } catch (e) { return 0; }
    var total = 0;
    names.forEach(function (n) {
      var m = /^([0-9a-f]{16})\.marks\.jsonl$/.exec(n);
      if (m) { total += mergeMarksFile(m[1], path.join(d, n), {}); } else if (/\.play\.bonis\.json$/.test(n)) {
        try { fs.unlinkSync(path.join(d, n)); } catch (e2) { /* gone */ }
      }
    });
    if (total) { log.info('recovered marks from a previous session', total); }
    return total;
  }

  function finishSession(reason) {
    var s = cur;
    if (!s) { return; }
    cur = null;
    var resumeAt = reason === 'eof' ? 0 : s.pos;
    library.update(s.id, { resumeAt: resumeAt > 5 ? resumeAt : 0 }, true);
    mergeMarksFile(s.id, s.marksPath, s.handled);
    try { fs.unlinkSync(s.playFile); } catch (e) { /* gone */ }
    supervisor.setPlayerOpen(false);
    emit('player:event', { type: 'ended', id: s.id, kidMode: s.kidMode, reason: reason || 'stopped' });
  }

  function onMark(m) {
    if (!cur) { return; }
    if (m.t === 'mark' && m.range) {
      cur.handled[m.range.id] = true;
      skips.addRange(cur.id, { id: m.range.id, start: m.range.start, end: m.range.end, category: 'other', action: 'skip', source: 'manual', review: 'pending' }, 'added');
      send({ type: 'mark', range: { id: m.range.id, start: m.range.start, end: m.range.end } });
    } else if (m.t === 'undo' && m.id) {
      cur.handled[m.id] = true;
      skips.deleteRange(cur.id, m.id);
      send({ type: 'undo', rangeId: m.id });
    }
  }

  function onPanic(m) {
    if (!cur) { return; }
    if (m.phase === 'end' && m.range) {
      cur.handled[m.range.id] = true;
      var mode = cur.kidMode ? 'kid' : 'parent';
      // Stays enforced (approved skip); the parent is told on the library card until the review is opened.
      skips.addRange(cur.id, { id: m.range.id, start: m.range.start, end: m.range.end, category: 'other', action: 'skip', source: 'panic', review: 'approved',
        note: t(cur.kidMode ? 'panic.note.kid' : 'panic.note.parent') }, 'panic');
      var it = library.get(cur.id);
      var prev = it && it.panicUnseen ? it.panicUnseen.count || 0 : 0;
      library.update(cur.id, { panicUnseen: { count: prev + 1, at: new Date().toISOString(), mode: mode } });
      activity.add('panic', { mode: mode, id: cur.id, title: it ? it.title : '', movieTime: Math.round(m.range.start) });
      send({ type: 'panic', phase: 'end', range: { id: m.range.id, start: m.range.start, end: m.range.end } });
    } else {
      send({ type: 'panic', phase: 'start', at: m.at });
    }
  }

  function wire(p) {
    p.on('ready', function (m) { send({ type: 'ready', ranges: m.ranges, enforced: m.enforced, loaded: m.loaded !== false }); });
    p.on('mark', onMark);
    p.on('panic', onPanic);
    p.on('skipped', function (m) { send({ type: 'skipped', rangeId: m.rangeId, action: m.action }); });
    p.on('timepos', function (t) {
      if (!cur) { return; }
      cur.pos = t;
      if (Date.now() - cur.lastPosSave > POS_SAVE_MS) {
        cur.lastPosSave = Date.now();
        library.update(cur.id, { resumeAt: t }, true);
      }
      send({ type: 'timepos', t: t });
    });
    p.on('ended', function (e) {
      if (e.reason === 'eof') { send({ type: 'eof' }); return; }
      finishSession(e.reason);
    });
    p.on('crashed', function (c) {
      var kid = cur && cur.kidMode;
      emit('toast', { kind: c.final ? 'error' : 'warning', key: c.final ? (kid ? 'kid.crashedFinal' : 'player.crashedFinal') : (kid ? 'kid.crashed' : 'player.crashedRelaunch') });
      if (c.final) { finishSession('crashed'); }
    });
    p.on('error', function (e) {
      var key = { 'kid-refused': 'player.kidRefused', skipfile: 'player.skipfileError', 'start-failed': 'player.startFailed',
        'spawn-failed': 'player.notFound', 'ipc-timeout': 'player.startFailed' }[e.code] || null;
      if (key && cur && cur.kidMode && key !== 'player.notFound') { key = 'kid.cannotPlay'; }
      if (key) { emit('toast', { kind: 'error', key: key }); }
      if (e.code === 'kid-refused' || e.code === 'start-failed' || e.code === 'spawn-failed') { finishSession('error'); }
    });
  }

  // cb(null, {ok, error?, data?})
  function play(id, opts, cb) {
    var done = typeof cb === 'function' ? cb : noop;
    var kidMode = !!(opts && opts.kidMode);
    var item = library.get(id);
    if (!item) { done(null, { ok: false, error: 'notFound' }); return; }
    if (!fs.existsSync(item.path)) { done(null, { ok: false, error: 'fileMissing' }); return; }
    var loaded = skips.load(id);
    var doc = loaded.doc;
    if (kidMode) {
      var ok = item.status === 'protected' && doc && BO.validate(doc).ok && doc.scan && doc.scan.status === 'complete' &&
        !loaded.tampered && !doc.ranges.some(function (r) { return r.review === 'pending'; });
      if (!ok) { done(null, { ok: false, error: 'kidRefused' }); return; }
    }
    var unprotected = false;
    if (!kidMode && (!doc || loaded.corrupt)) {
      // Planner decision 1: never start an unprotected play without an explicit answer.
      if (!(opts && opts.unprotected)) { done(null, { ok: false, error: 'needsConfirm', data: { reason: loaded.corrupt ? 'damaged' : 'notScanned' } }); return; }
      unprotected = true;
      activity.add('playUnprotected', { id: id, title: item.title, reason: loaded.corrupt ? 'damaged' : 'notScanned' });
    } else {
      activity.add('play', { mode: kidMode ? 'kid' : 'parent', id: id, title: item.title });
    }
    if (!doc) { doc = skips.blank(id); }
    var s = settings.get();
    var playDoc = buildPlaybackDoc(doc, { levels: s.levels, skipScenes: s.skipScenes, nonSkipAction: s.nonSkipAction });
    var dir = playDir();
    var playFile = path.join(dir, id + '.play.bonis.json');
    var marksPath = path.join(dir, id + '.marks.jsonl');

    function launch() {
      try { writeAtomic(playFile, JSON.stringify(playDoc)); } catch (e) {
        log.error('cannot write playback file', e && e.code);
        done(null, { ok: false, error: 'writeFailed' });
        return;
      }
      var po = paths.playerOptions();
      player = createPlayer({
        mpvPath: paths.mpv(), scriptPath: paths.playerScript(), log: log, vo: po.vo, ao: po.ao, savePosition: false,
        extraArgs: ['--script-opts-append=bonis-panickey=' + (s.panicKey || 'p')]
      });
      wire(player);
      var dur = item.duration || 0;
      var resumeAt = !kidMode && item.resumeAt > 5 && (!dur || item.resumeAt < dur - 30) ? item.resumeAt : 0;
      if (kidMode && item.resumeAt > 5 && (!dur || item.resumeAt < dur - 30)) { resumeAt = item.resumeAt; }
      cur = { id: id, kidMode: kidMode, playFile: playFile, marksPath: marksPath, pos: resumeAt, lastPosSave: Date.now(), handled: {} };
      supervisor.setPlayerOpen(true);
      var enforcedCount = BO.enforced(playDoc).length;
      send({ type: 'starting', title: item.title, enforced: enforcedCount, panicKey: s.panicKey || 'p', unprotected: unprotected });
      player.play(item.path, playFile, { kidMode: kidMode, lang: s.lang, marksPath: marksPath, resumeAt: resumeAt }, function (err) {
        if (err && cur && cur.id === id && player && player.status().state === 'idle') { finishSession('error'); }
      });
      done(null, { ok: true, data: { id: id, title: item.title, enforced: enforcedCount, kidMode: kidMode } });
    }

    if (player && player.status().state !== 'idle') {
      player.stop(function () { finishSession('stopped'); launch(); });
    } else {
      launch();
    }
  }

  // Pre-play sheet (planner decision 7): what will happen to each scene with the current settings.
  function preview(id) {
    var item = library.get(id);
    if (!item) { return { ok: false, error: 'notFound' }; }
    var loaded = skips.load(id);
    var doc = loaded.doc;
    if (!doc) { return { ok: true, data: { id: id, title: item.title, list: false, damaged: !!loaded.corrupt } }; }
    var s = settings.get();
    var play = buildPlaybackDoc(doc, { levels: s.levels, skipScenes: s.skipScenes, nonSkipAction: s.nonSkipAction });
    var eff = {};
    play.ranges.forEach(function (r) { eff[r.id] = r.action; });
    var totals = { skipped: 0, covered: 0, muted: 0, letPlay: 0, below: 0 };
    var byCategory = {};
    doc.ranges.forEach(function (r) {
      var k;
      if (r.review === 'rejected' || r.action === 'none') { k = r.review === 'rejected' ? 'letPlay' : 'below'; } else if (eff[r.id] === 'none') { k = 'below'; } else if (eff[r.id] === 'mute') { k = 'muted'; } else if (eff[r.id] === 'hide' || eff[r.id] === 'blur') { k = 'covered'; } else { k = 'skipped'; }
      totals[k] += 1;
      var c = byCategory[r.category] = byCategory[r.category] || { skipped: 0, covered: 0, muted: 0, letPlay: 0, below: 0 };
      c[k] += 1;
    });
    return { ok: true, data: { id: id, title: item.title, list: true, damaged: false, status: item.status,
      complete: !!(doc.scan && doc.scan.status === 'complete'), pending: doc.ranges.filter(function (r) { return r.review === 'pending'; }).length,
      totals: totals, byCategory: byCategory } };
  }

  function stop(cb) {
    var done = typeof cb === 'function' ? cb : noop;
    if (!player || !cur) { finishSession('stopped'); done(null, { ok: true }); return; }
    player.stop(function () {
      finishSession('stopped');
      done(null, { ok: true });
    });
  }

  function status() {
    var st = player ? player.status() : { state: 'idle' };
    return { state: cur ? st.state : 'idle', id: cur ? cur.id : null, kidMode: cur ? cur.kidMode : false, pos: cur ? cur.pos : 0 };
  }

  return { play: play, stop: stop, status: status, recover: recover, preview: preview, isOpen: function () { return !!cur; } };
}

module.exports = { createPlayerService: createPlayerService, buildPlaybackDoc: buildPlaybackDoc, THRESHOLDS: THRESHOLDS };
