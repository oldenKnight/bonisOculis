'use strict';
// Hand marks for "Check accuracy" (brief 6.5, board X13): a parent watches the whole movie in a
// "Mark by hand" session and marks every scene with I / O. The marks go to their OWN skip file,
// library/<id>.truth.bonis.json, never into the title's list, so they never change what kids see.
// Ranges: source manual, review approved, category chosen after each mark (default "other").
// The file is a valid .bonis.json, so it can be compared with the automatic scan and exported.

var BO = require('../../shared/skipfile.js');

function rel(id) { return 'library/' + id + '.truth.bonis.json'; }

function noop() {}
var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

// opts: {store, library, log}
function createTruth(opts) {
  var o = opts || {};
  var store = o.store;
  var library = o.library;
  var log = o.log || silentLog;

  function load(id) {
    var r = store.readJson(rel(id), function (v) { return BO.validate(v).ok; });
    return r.value || null;
  }

  function blank(id) {
    var it = library.get(id);
    if (!it) { return null; }
    var media = { title: (it.title || it.filename || '').slice(0, 500), duration: it.duration || 0, filename: it.filename, fingerprint: { size: it.size, oshash: it.oshash } };
    if (it.headSha256) { media.fingerprint.headSha256 = it.headSha256; }
    var d = BO.newDoc({ media: media, scan: { status: 'none' } });
    BO.addHistory(d, 'created', null, 'hand marks for Check accuracy');
    return d;
  }

  function mutate(id, fn) {
    var doc = load(id) || blank(id);
    if (!doc) { return { ok: false, error: 'notFound' }; }
    var err = fn(doc);
    if (err) { return { ok: false, error: err }; }
    doc.ranges.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    doc.summary = BO.summarise(doc);
    doc.modified = new Date().toISOString();
    if (!BO.validate(doc).ok) { log.error('hand marks would be invalid'); return { ok: false, error: 'invalidSkip' }; }
    if (!store.writeJson(rel(id), doc)) { return { ok: false, error: 'writeFailed' }; }
    return { ok: true, doc: doc };
  }

  function add(id, range) {
    return mutate(id, function (doc) {
      if (!(range.end > range.start)) { return 'badEdges'; }
      if (doc.ranges.some(function (r) { return r.id === range.id; })) { return null; }
      doc.ranges.push(BO.newRange({ id: range.id, start: Math.max(0, range.start), end: range.end, category: range.category || 'other', action: 'skip',
        source: 'manual', review: 'approved', confidence: 1, locked: true }));
      BO.addHistory(doc, 'added', range.id, 'hand mark');
      return null;
    });
  }

  function remove(id, rangeId) {
    return mutate(id, function (doc) {
      var n = doc.ranges.length;
      doc.ranges = doc.ranges.filter(function (r) { return r.id !== rangeId; });
      if (doc.ranges.length !== n) { BO.addHistory(doc, 'deleted', rangeId, 'hand mark undone'); }
      return null;
    });
  }

  function setCategory(id, rangeId, category) {
    if (BO.CATEGORIES.indexOf(category) < 0) { return { ok: false, error: 'badCategory' }; }
    return mutate(id, function (doc) {
      var r = doc.ranges.filter(function (x) { return x.id === rangeId; })[0];
      if (!r) { return 'rangeNotFound'; }
      if (r.category !== category) {
        r.category = category;
        if (category === 'language') { r.action = 'mute'; } else { r.action = 'skip'; }
        BO.addHistory(doc, 'edited', rangeId, 'category ' + category);
      }
      return null;
    });
  }

  function file(id) { return store.full(rel(id)); }

  function clear(id) { return store.remove(rel(id)); }

  return { load: load, add: add, remove: remove, setCategory: setCategory, file: file, clear: clear };
}

module.exports = { createTruth: createTruth };
