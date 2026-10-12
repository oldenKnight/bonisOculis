'use strict';
// Implementations behind every channel in ipc.js. Each handler is (payload, ctx, cb(err, data)).
// Errors are short codes the renderer turns into a sentence through i18n ("error.<code>").

var fs = require('fs');
var crypto = require('crypto');
var childProcess = require('child_process');
var BO = require('../../shared/skipfile.js');
var exportJson = require('./exporters/json.js').exportJson;
var exportEdl = require('./exporters/edl.js').exportEdl;
var cleanCopy = require('./exporters/clean-copy.js').cleanCopy;
var importJson = require('./importers/json.js').importJson;

var VIDEO_EXT = ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'webm', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'vob', 'ogv', 'flv', '3gp'];
var MAX_IMPORT_BYTES = 5 * 1024 * 1024;

function versionOf(bin, cb) {
  var out = '';
  var p;
  try { p = childProcess.spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { cb(null); return; }
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', function (d) { if (out.length < 400) { out += d; } });
  p.on('error', function () { cb(null); cb = function () {}; });
  p.on('close', function () {
    var m = /version\s+(\S+)/i.exec(out) || /\b(v?\d+\.\d+[\w.+~-]*)/.exec(out);
    cb(m ? m[1] : null);
  });
}

function createHandlers(c) {
  // c: {electron, getWindow, store, pin, settings, i18n, library, skips, supervisor, player, thumbs,
  //     help, paths, log, emit, versions, takeToasts, onLangChanged}
  var exported = {};
  var importTokens = {};
  var clean = null;
  var toolVersions = null;

  function t(k, p) { return c.i18n.t(k, p); }

  function win() { return c.getWindow(); }

  function publicSettings() {
    var s = c.settings.get();
    delete s.analyzerCommand;
    delete s.windowBounds;
    return s;
  }

  function kidItem(it) { return { id: it.id, title: it.title, year: it.year, duration: it.duration, status: it.status, enforced: it.enforced }; }

  function enqueueAll(ids) { ids.forEach(function (id) { c.supervisor.enqueue(id); }); }

  function addPaths(paths, cb) {
    c.library.add(paths, function (err, res) {
      if (err) { cb('addFailed'); return; }
      enqueueAll(res.added);
      cb(null, res);
    });
  }

  function docOf(id) {
    var r = c.skips.load(id);
    return r.doc;
  }

  function skipResult(cb) {
    return function (r) {
      if (!r || !r.ok) { cb(r && r.error ? r.error : 'failed'); return; }
      cb(null, { doc: r.doc, item: r.item, canUndo: !!r.canUndo, rangeId: r.rangeId || null });
    };
  }

  function rememberExport(p) { exported[p] = true; return p; }

  var h = {};

  h['app:state'] = function (p, ctx, cb) {
    var locked = c.pin.isLocked();
    var s = c.settings.get();
    cb(null, {
      hasPin: c.pin.hasPin(), locked: locked, setupDone: !!s.setupDone, lang: c.i18n.lang(),
      strings: c.i18n.dict(c.i18n.lang()), settings: locked ? { lang: s.lang, reduceMotion: s.reduceMotion } : publicSettings(),
      toasts: c.takeToasts(), version: c.versions.app, platform: process.platform,
      player: c.player.status(), scan: locked ? null : c.supervisor.status()
    });
  };

  h['app:version'] = function (p, ctx, cb) {
    function reply() {
      var v = {};
      Object.keys(c.versions).forEach(function (k) { v[k] = c.versions[k]; });
      v.mpv = toolVersions.mpv; v.ffmpeg = toolVersions.ffmpeg;
      cb(null, v);
    }
    if (toolVersions) { reply(); return; }
    toolVersions = {};
    versionOf(c.paths.mpv(), function (mv) {
      toolVersions.mpv = mv;
      versionOf(c.paths.ffmpeg(), function (fv) { toolVersions.ffmpeg = fv; reply(); });
    });
  };

  h['app:reveal'] = function (p, ctx, cb) {
    if (!exported[p.path]) { cb('forbidden'); return; }
    try { c.electron.shell.showItemInFolder(p.path); } catch (e) { cb('failed'); return; }
    cb(null, true);
  };

  h['library:list'] = function (p, ctx, cb) {
    var items = c.library.list();
    if (c.pin.isLocked()) { items = items.filter(function (it) { return it.status === 'protected'; }).map(kidItem); }
    cb(null, items);
  };

  h['library:add'] = function (p, ctx, cb) { addPaths(p.paths, cb); };

  h['library:pick'] = function (p, ctx, cb) {
    c.electron.dialog.showOpenDialog(win(), {
      title: t('dialog.pickMovies'), properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dialog.videos'), extensions: VIDEO_EXT }, { name: t('dialog.allFiles'), extensions: ['*'] }]
    }).then(function (r) {
      if (r.canceled || !r.filePaths.length) { cb(null, { canceled: true, added: [], duplicates: [], failed: [] }); return; }
      addPaths(r.filePaths, cb);
    }, function () { cb('dialogFailed'); });
  };

  h['library:remove'] = function (p, ctx, cb) {
    if (!c.library.get(p.id)) { cb('notFound'); return; }
    if (c.player.status().id === p.id) { cb('playing'); return; }
    c.supervisor.cancel(p.id);
    c.skips.remove(p.id);
    try { fs.rmSync(c.paths.workDir(p.id), { recursive: true, force: true }); } catch (e) { c.log.warn('work dir not removed'); }
    c.library.remove(p.id);
    cb(null, true);
  };

  h['library:poster'] = function (p, ctx, cb) { c.thumbs.poster(p.id, function (e, r) { cb(null, r); }); };

  h['scan:queue'] = function (p, ctx, cb) { var r = c.supervisor.enqueue(p.id); if (r.ok) { cb(null, r.data); } else { cb(r.error); } };
  h['scan:pause'] = function (p, ctx, cb) { cb(null, c.supervisor.pause().data); };
  h['scan:resume'] = function (p, ctx, cb) { cb(null, c.supervisor.resume().data); };
  h['scan:cancel'] = function (p, ctx, cb) { cb(null, c.supervisor.cancel(p.id).data); };
  h['scan:status'] = function (p, ctx, cb) { cb(null, c.supervisor.status()); };

  h['skip:get'] = function (p, ctx, cb) {
    var it = c.library.get(p.id);
    if (!it) { cb('notFound'); return; }
    var r = c.skips.load(p.id);
    cb(null, { doc: r.doc || c.skips.blank(p.id), item: it, tampered: r.tampered, scanned: !!r.doc });
  };
  h['skip:save'] = function (p, ctx, cb) {
    if (!c.library.get(p.id)) { cb('notFound'); return; }
    if (!BO.validate(p.doc).ok) { cb('invalidSkip'); return; }
    skipResult(cb)(c.skips.replace(p.id, p.doc, true));
  };
  h['skip:approve'] = function (p, ctx, cb) { skipResult(cb)(c.skips.approve(p.id, p.rangeIds)); };
  h['skip:reject'] = function (p, ctx, cb) { skipResult(cb)(c.skips.reject(p.id, p.rangeIds)); };
  h['skip:edit'] = function (p, ctx, cb) {
    var allowed = ['start', 'end', 'category', 'action', 'note', 'intensity'];
    var patch = {};
    var k;
    for (k in p.patch) {
      if (!Object.prototype.hasOwnProperty.call(p.patch, k)) { continue; }
      if (allowed.indexOf(k) < 0) { cb('badPayload'); return; }
      patch[k] = p.patch[k];
    }
    if ((patch.start !== undefined && typeof patch.start !== 'number') || (patch.end !== undefined && typeof patch.end !== 'number') ||
        (patch.note !== undefined && typeof patch.note !== 'string')) { cb('badPayload'); return; }
    skipResult(cb)(c.skips.edit(p.id, p.rangeId, patch));
  };
  h['skip:add'] = function (p, ctx, cb) {
    if (p.category && BO.CATEGORIES.indexOf(p.category) < 0) { cb('badPayload'); return; }
    skipResult(cb)(c.skips.addRange(p.id, { start: p.start, end: p.end, category: p.category || 'other', source: 'manual', review: 'approved' }, 'added'));
  };
  h['skip:delete'] = function (p, ctx, cb) { skipResult(cb)(c.skips.deleteRange(p.id, p.rangeId)); };
  h['skip:undo'] = function (p, ctx, cb) { skipResult(cb)(c.skips.undo(p.id)); };
  h['skip:markReviewed'] = function (p, ctx, cb) { skipResult(cb)(c.skips.markReviewed(p.id)); };
  h['skip:thumbs'] = function (p, ctx, cb) { cb(null, c.thumbs.rangeThumbs(p.id, p.rangeIds)); };
  h['skip:strip'] = function (p, ctx, cb) { c.thumbs.strip(p.id, p.n, function (e, list) { cb(null, list || []); }); };
  h['skip:peek'] = function (p, ctx, cb) {
    if (c.pin.isLocked()) { cb('locked'); return; }
    if (!c.pin.peekAllowed()) { cb('pinNeeded'); return; }
    var doc = docOf(p.id);
    var r = doc && doc.ranges.filter(function (x) { return x.id === p.rangeId; })[0];
    if (!r) { cb('rangeNotFound'); return; }
    var off = (doc.media && doc.media.offset) || 0;
    c.thumbs.peek(p.id, (r.start + r.end) / 2 + off, function (e, url) {
      if (!url) { cb('peekFailed'); return; }
      c.pin.touchPeek();
      cb(null, url);
    });
  };

  h['player:play'] = function (p, ctx, cb) {
    var kid = c.pin.isLocked() ? true : !!p.kidMode;
    c.player.play(p.id, { kidMode: kid }, function (e, r) { if (r.ok) { cb(null, r.data); } else { cb(r.error); } });
  };
  h['player:stop'] = function (p, ctx, cb) { c.player.stop(function () { cb(null, true); }); };
  h['player:status'] = function (p, ctx, cb) { cb(null, c.player.status()); };

  h['pin:status'] = function (p, ctx, cb) { cb(null, c.pin.status()); };
  h['pin:set'] = function (p, ctx, cb) {
    var r = c.pin.setPin(p.pin);
    if (!r.ok) { cb(r.error); return; }
    cb(null, { recoveryCode: r.recoveryCode });
  };
  h['pin:verify'] = function (p, ctx, cb) {
    var wasLocked = c.pin.isLocked();
    var r = c.pin.verify(p.pin, p.purpose);
    if (r.ok && wasLocked && !c.pin.isLocked()) { c.emit('app:locked', { locked: false }); }
    cb(null, r);
  };
  h['pin:recover'] = function (p, ctx, cb) {
    var wasLocked = c.pin.isLocked();
    var r = c.pin.recover(p.code, p.newPin);
    if (r.ok && wasLocked) { c.emit('app:locked', { locked: false }); }
    cb(null, r);
  };
  h['pin:lock'] = function (p, ctx, cb) {
    if (!c.pin.hasPin()) { cb('noPin'); return; }
    c.pin.lock();
    c.emit('app:locked', { locked: true });
    cb(null, true);
  };
  h['pin:change'] = function (p, ctx, cb) { cb(null, c.pin.changePin(p.oldPin, p.newPin)); };

  h['settings:get'] = function (p, ctx, cb) {
    var s = c.settings.get();
    cb(null, c.pin.isLocked() ? { lang: s.lang, reduceMotion: s.reduceMotion } : publicSettings());
  };
  h['settings:set'] = function (p, ctx, cb) {
    var r = c.settings.set(p.patch, true);
    if (!r.ok) { cb(r.error); return; }
    if (r.changed.indexOf('lang') >= 0) { c.onLangChanged(r.data.lang); }
    c.supervisor.settingsChanged();
    var out = publicSettings();
    cb(null, { settings: out, strings: r.changed.indexOf('lang') >= 0 ? c.i18n.dict(c.i18n.lang()) : null });
  };

  function exportWith(fn, kind) {
    return function (p, ctx, cb) {
      var it = c.library.get(p.id);
      if (!it) { cb('notFound'); return; }
      var doc = docOf(p.id);
      if (!doc) { cb('noSkip'); return; }
      fn({ doc: doc, mediaPath: it.path, dir: p.dir }, function (err, file) {
        if (err) { cb(err.code || 'exportFailed'); return; }
        c.log.info('exported', kind);
        cb(null, { path: rememberExport(file) });
      });
    };
  }
  h['export:json'] = exportWith(exportJson, 'json');
  h['export:edl'] = exportWith(exportEdl, 'edl');

  h['export:clean'] = function (p, ctx, cb) {
    var it = c.library.get(p.id);
    if (!it) { cb('notFound'); return; }
    if (clean) { cb('busy'); return; }
    var doc = docOf(p.id);
    if (!doc) { cb('noSkip'); return; }
    var tmp = c.paths.tmpDir();
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) { /* exists */ }
    var job = { id: p.id };
    clean = job;
    c.emit('export:progress', { id: p.id, done: 0, total: 1, state: 'running' });
    job.handle = cleanCopy({
      input: it.path, doc: doc, outDir: p.dir, aac: !!p.aac, ffmpeg: c.paths.ffmpeg(), ffprobe: c.paths.ffprobe(), tmpDir: tmp,
      onProgress: function (pr) { c.emit('export:progress', { id: p.id, done: pr.done, total: pr.total, state: 'running' }); }
    }, function (err, res) {
      clean = null;
      if (err) {
        c.emit('export:progress', { id: p.id, state: err.code === 'cancelled' ? 'cancelled' : 'failed' });
        cb(err.code || 'exportFailed');
        return;
      }
      c.emit('export:progress', { id: p.id, state: 'done', done: 1, total: 1 });
      cb(null, { path: rememberExport(res.path), kept: res.kept });
    });
  };
  h['export:cancel'] = function (p, ctx, cb) {
    if (clean && clean.handle) { clean.handle.cancel(); }
    cb(null, true);
  };
  h['export:pickFolder'] = function (p, ctx, cb) {
    c.electron.dialog.showOpenDialog(win(), { title: t('dialog.pickFolder'), properties: ['openDirectory', 'createDirectory'] }).then(function (r) {
      cb(null, r.canceled || !r.filePaths.length ? { canceled: true } : { dir: r.filePaths[0] });
    }, function () { cb('dialogFailed'); });
  };

  function runImport(text, targetId, cb) {
    var r = importJson({ text: text, library: c.library, skips: c.skips, targetId: targetId });
    if (!r.ok) { cb(r.error); return; }
    if (r.data && r.data.needsPick) {
      var token = crypto.randomBytes(16).toString('hex');
      importTokens[token] = text;
      r.data.token = token;
    }
    cb(null, r.data);
  }

  h['import:json'] = function (p, ctx, cb) {
    if (p.token) {
      var text = importTokens[p.token];
      if (!text) { cb('expired'); return; }
      if (!p.targetId) { delete importTokens[p.token]; cb(null, { canceled: true }); return; }
      delete importTokens[p.token];
      runImport(text, p.targetId, cb);
      return;
    }
    c.electron.dialog.showOpenDialog(win(), {
      title: t('dialog.pickSkipFile'), properties: ['openFile'],
      filters: [{ name: t('dialog.skipFiles'), extensions: ['json'] }]
    }).then(function (r) {
      if (r.canceled || !r.filePaths.length) { cb(null, { canceled: true }); return; }
      fs.stat(r.filePaths[0], function (e, st) {
        if (e || !st.isFile() || st.size > MAX_IMPORT_BYTES) { cb('invalidSkip'); return; }
        fs.readFile(r.filePaths[0], 'utf8', function (e2, text) {
          if (e2) { cb('invalidSkip'); return; }
          runImport(text, p.targetId || null, cb);
        });
      });
    }, function () { cb('dialogFailed'); });
  };

  h['help:open'] = function (p, ctx, cb) { cb(null, c.help.get(c.i18n.lang(), p.doc)); };

  // Check accuracy: the parent picks a hand-marked skip file, the analyzer's evaluate compares.
  h['accuracy:run'] = function (p, ctx, cb) {
    if (!c.library.get(p.id)) { cb('notFound'); return; }
    if (!c.skips.load(p.id).doc) { cb('noSkip'); return; }
    c.electron.dialog.showOpenDialog(win(), {
      title: t('dialog.pickTruth'), properties: ['openFile'],
      filters: [{ name: t('dialog.skipFiles'), extensions: ['json'] }]
    }).then(function (r) {
      if (r.canceled || !r.filePaths.length) { cb(null, { canceled: true }); return; }
      c.accuracy.run(p.id, r.filePaths[0], function (err, res) { if (err) { cb(err); } else { cb(null, res); } });
    }, function () { cb('dialogFailed'); });
  };

  h['app:copyText'] = function (p, ctx, cb) {
    try { c.electron.clipboard.writeText(p.text); } catch (e) { cb('failed'); return; }
    cb(null, true);
  };

  return h;
}

module.exports = { createHandlers: createHandlers, VIDEO_EXT: VIDEO_EXT, versionOf: versionOf };
