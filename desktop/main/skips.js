'use strict';
// Skip files of the library (library/<oshash>.bonis.json): load, save (atomic + HMAC), and every
// parent decision as a small operation with a history entry (brief 4.4: autosave on every change,
// so there are never unsaved changes). An in-memory undo stack per title backs the undo toast.

var BO = require('../../shared/skipfile.js');
var libMod = require('./library.js');

var UNDO_MAX = 30;
var STAGES = ['subtitles', 'frames', 'audio', 'speech', 'captions', 'fusion'];

function noop() {}
var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

function rel(id) { return 'library/' + id + '.bonis.json'; }

function fmt(x) { return String(Math.round(x * 1000) / 1000); }

function createSkips(options) {
  var o = options || {};
  var store = o.store;
  var library = o.library;
  var log = o.log || silentLog;
  var now = o.now || function () { return new Date().toISOString(); };
  var undo = {};
  var listeners = [];

  function hmacOf(doc) { return store.hmac(JSON.stringify(doc)); }

  // -> {doc|null, tampered, corrupt}. corrupt: the list was saved once (the library remembers its
  // HMAC) but cannot be read or restored now. Fail closed (planner decision 1): onDamaged(id).
  function load(id) {
    var r = store.readJson(rel(id), function (v) { return BO.validate(v).ok; });
    var it = library.get(id);
    if (!r.value) {
      var corrupt = !!r.lost || !!(it && it.skipHmac);
      if (corrupt && o.onDamaged) { try { o.onDamaged(id); } catch (e) { log.error('onDamaged threw', e); } }
      return { doc: null, tampered: false, corrupt: corrupt };
    }
    // A list without a signature, or with a wrong one, was changed outside the app (board review
    // A4): flag it in the (HMAC'd) library index; it stays "Needs review" until the parent
    // confirms it with trust(). The flag is not cleared by later edits.
    var tampered = !!(it && (!it.skipHmac || !store.hmacOk(it.skipHmac, hmacOf(r.value))));
    if (tampered) {
      log.warn('skip file changed outside the app', id);
      if (it.outside !== 'changed' && it.outside !== 'imported') { library.update(id, { outside: 'changed', wholeApproved: false }, true); }
    }
    return { doc: r.value, tampered: tampered, corrupt: false };
  }

  function save(id, doc) {
    var res = BO.validate(doc);
    if (!res.ok) { log.error('refusing to save invalid skip file', id, JSON.stringify(res.errors.slice(0, 3))); return { ok: false, error: 'invalidSkip' }; }
    if (!store.writeJson(rel(id), doc)) { return { ok: false, error: 'writeFailed' }; }
    library.update(id, { skipHmac: hmacOf(doc) }, true);
    var item = library.applyDoc(id, doc, BO.validate);
    listeners.forEach(function (fn) { try { fn(id, doc); } catch (e) { log.error('skips listener', e); } });
    return { ok: true, doc: doc, item: item };
  }

  function remove(id) { delete undo[id]; return store.remove(rel(id)); }

  // A fresh document for a title that has never been scanned (manual marks, imports).
  function blank(id) {
    var it = library.get(id);
    if (!it) { return null; }
    var media = { title: (it.title || it.filename || '').slice(0, 500), duration: it.duration || 0, filename: it.filename,
      fingerprint: { size: it.size, oshash: it.oshash } };
    if (it.headSha256) { media.fingerprint.headSha256 = it.headSha256; }
    if (it.year && it.year >= 1880 && it.year <= 2200) { media.year = it.year; }
    return BO.newDoc({ media: media, scan: { status: 'none' } });
  }

  function getOrBlank(id) {
    var r = load(id);
    return r.doc || blank(id);
  }

  function pushUndo(id, doc) {
    (undo[id] = undo[id] || []).push(JSON.parse(JSON.stringify(doc)));
    if (undo[id].length > UNDO_MAX) { undo[id].shift(); }
  }

  function findRange(doc, rangeId) {
    var i;
    for (i = 0; i < doc.ranges.length; i++) { if (doc.ranges[i].id === rangeId) { return doc.ranges[i]; } }
    return null;
  }

  function finish(id, before, doc) {
    doc.summary = BO.summarise(doc);
    doc.modified = now();
    var r = save(id, doc);
    if (r.ok && before) { pushUndo(id, before); }
    if (r.ok) { r.canUndo = !!(undo[id] && undo[id].length); }
    return r;
  }

  function mutate(id, fn) {
    var doc = getOrBlank(id);
    if (!doc) { return { ok: false, error: 'notFound' }; }
    var before = JSON.parse(JSON.stringify(doc));
    var err = fn(doc);
    if (err) { return { ok: false, error: err }; }
    return finish(id, before, doc);
  }

  function review(id, rangeIds, verdict) {
    return mutate(id, function (doc) {
      var all = rangeIds === 'all';
      var hit = 0;
      doc.ranges.forEach(function (r) {
        if (all ? r.review === 'pending' : rangeIds.indexOf(r.id) >= 0) {
          if (verdict === 'approved' && r.action === 'none') { r.action = 'skip'; }
          if (r.review !== verdict) {
            r.review = verdict;
            r.locked = true;
            BO.addHistory(doc, verdict, r.id, null, { now: now() });
          }
          hit++;
        }
      });
      if (!all && !hit) { return 'rangeNotFound'; }
      return null;
    });
  }

  // patch: {start?, end?, category?, action?, note?, intensity?}
  function edit(id, rangeId, patch) {
    return mutate(id, function (doc) {
      var r = findRange(doc, rangeId);
      var details = [];
      if (!r) { return 'rangeNotFound'; }
      var dur = doc.media && doc.media.duration > 0 ? doc.media.duration : null;
      var start = patch.start !== undefined ? patch.start : r.start;
      var end = patch.end !== undefined ? patch.end : r.end;
      start = Math.max(0, Math.round(start * 1000) / 1000);
      end = Math.round(end * 1000) / 1000;
      if (dur !== null && end > dur) { end = dur; }
      if (!(end > start)) { return 'badEdges'; }
      if (start !== r.start) { details.push('start ' + fmt(r.start) + ' -> ' + fmt(start)); r.start = start; delete r.cutStart; }
      if (end !== r.end) { details.push('end ' + fmt(r.end) + ' -> ' + fmt(end)); r.end = end; delete r.cutEnd; }
      if (patch.category !== undefined && patch.category !== r.category) {
        if (BO.CATEGORIES.indexOf(patch.category) < 0) { return 'badCategory'; }
        details.push('category ' + r.category + ' -> ' + patch.category);
        r.category = patch.category;
      }
      if (patch.action !== undefined && patch.action !== r.action) {
        if (BO.ACTIONS.indexOf(patch.action) < 0) { return 'badAction'; }
        details.push('action ' + r.action + ' -> ' + patch.action);
        r.action = patch.action;
      }
      if (patch.intensity !== undefined && patch.intensity !== r.intensity) {
        if ([1, 2, 3].indexOf(patch.intensity) < 0) { return 'badIntensity'; }
        r.intensity = patch.intensity;
        details.push('intensity');
      }
      if (patch.note !== undefined) {
        var note = String(patch.note).replace(/\s+/g, ' ').trim().slice(0, 300);
        if (note !== (r.note || '')) {
          if (note) { r.note = note; } else { delete r.note; }
          details.push('note');
        }
      }
      if (!details.length) { return null; }
      r.locked = true;
      BO.addHistory(doc, 'edited', r.id, details.join('; '), { now: now() });
      return null;
    });
  }

  // fields: {start, end, category?, action?, source?, review?, note?}; returns the new range id in data.rangeId
  function addRange(id, fields, event) {
    var newId = null;
    var r = mutate(id, function (doc) {
      var src = fields.source || 'manual';
      var range = BO.newRange({
        id: fields.id, start: Math.max(0, fields.start), end: fields.end, category: fields.category || 'other',
        action: fields.action || 'skip', source: src, review: fields.review || 'pending', confidence: 1, locked: true
      });
      if (fields.note) { range.note = String(fields.note).slice(0, 300); }
      if (!(range.end > range.start)) { return 'badEdges'; }
      if (findRange(doc, range.id)) { return 'duplicateRange'; }
      doc.ranges.push(range);
      doc.ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      newId = range.id;
      BO.addHistory(doc, event || 'added', range.id, src, { now: now() });
      return null;
    });
    if (r.ok) { r.rangeId = newId; }
    return r;
  }

  function deleteRange(id, rangeId) {
    return mutate(id, function (doc) {
      var i;
      for (i = 0; i < doc.ranges.length; i++) {
        if (doc.ranges[i].id === rangeId) {
          doc.ranges.splice(i, 1);
          BO.addHistory(doc, 'deleted', rangeId, null, { now: now() });
          return null;
        }
      }
      return 'rangeNotFound';
    });
  }

  // "Mark as fully reviewed" (SKIPFILE.md, kid mode): approves what is pending, sets
  // scan.status complete, stages that did not run become skipped.
  function completeByParent(doc, detail) {
    var scan = doc.scan && typeof doc.scan === 'object' ? doc.scan : {};
    var stages = scan.stages && typeof scan.stages === 'object' ? scan.stages : {};
    doc.ranges.forEach(function (r) {
      if (r.review === 'pending') {
        if (r.action === 'none') { r.action = 'skip'; }
        r.review = 'approved';
        r.locked = true;
        BO.addHistory(doc, 'approved', r.id, null, { now: now() });
      }
    });
    STAGES.forEach(function (s) {
      if (!stages[s] || stages[s].status !== 'done') { stages[s] = { status: 'skipped', detail: 'reviewed by a parent' }; }
    });
    scan.status = 'complete';
    scan.stages = stages;
    if (!scan.finishedAt) { scan.finishedAt = now(); }
    doc.scan = scan;
    BO.addHistory(doc, 'edited', null, detail, { now: now() });
  }

  function markReviewed(id) {
    return mutate(id, function (doc) {
      completeByParent(doc, libMod.MARKED_REVIEWED);
      library.update(id, { wholeApproved: true }, true);
      return null;
    });
  }

  // "Looks clean - approve for kids": a complete scan with nothing pending, approved as a whole.
  function approveClean(id) {
    return mutate(id, function (doc) {
      if (!doc.scan || doc.scan.status !== 'complete') { return 'notScanned'; }
      if (doc.ranges.some(function (r) { return r.review === 'pending'; })) { return 'pendingScenes'; }
      BO.addHistory(doc, 'approved', null, libMod.CLEAN_APPROVAL, { now: now() });
      library.update(id, { wholeApproved: true }, true);
      return null;
    });
  }

  // "Use this list for kids": the parent confirms a list that was imported or changed outside
  // the app. Scenes still waiting are skipped (as with Skip all), the flag goes, the list is
  // signed again. Refused while the list cannot be read.
  function trust(id) {
    var cur = load(id);
    if (!cur.doc) { return { ok: false, error: cur.corrupt ? 'skipCorrupt' : 'noSkip' }; }
    return mutate(id, function (doc) {
      completeByParent(doc, libMod.TRUSTED);
      library.update(id, { outside: null, wholeApproved: true }, true);
      return null;
    });
  }

  // Replace the whole document (import, scan merge, undo). No undo entry unless asked.
  function replace(id, doc, withUndo) {
    var before = withUndo ? load(id).doc : null;
    return finish(id, before, doc);
  }

  function undoLast(id) {
    var stack = undo[id];
    if (!stack || !stack.length) { return { ok: false, error: 'nothingToUndo' }; }
    var prev = stack.pop();
    BO.addHistory(prev, 'edited', null, 'undo', { now: now() });
    prev.summary = BO.summarise(prev);
    prev.modified = now();
    var r = save(id, prev);
    if (r.ok) { r.canUndo = stack.length > 0; }
    return r;
  }

  return {
    load: load, save: save, remove: remove, blank: blank, getOrBlank: getOrBlank,
    approve: function (id, ids) { return review(id, ids, 'approved'); },
    reject: function (id, ids) { return review(id, ids, 'rejected'); },
    edit: edit, addRange: addRange, deleteRange: deleteRange, markReviewed: markReviewed, approveClean: approveClean, trust: trust,
    replace: replace, undo: undoLast, onSaved: function (fn) { listeners.push(fn); }
  };
}

module.exports = { createSkips: createSkips };
