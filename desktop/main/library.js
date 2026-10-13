'use strict';
// The movie library: add by path (fingerprint, dedupe by oshash), remove, list, and the status
// machine  notScanned -> queued -> scanning -> needsReview | protected | needsAttention.
// Persisted as an HMAC envelope (library.json). Skip files live in library/<oshash>.bonis.json
// and are owned by skips.js; this module only reads their summary to derive a status.

var fs = require('fs');
var path = require('path');
var fingerprint = require('../../shared/fingerprint.js');
var probe = require('./probe.js');

var FILE = 'library.json';
var STATUSES = ['notScanned', 'queued', 'scanning', 'needsReview', 'protected', 'needsAttention'];
var NEXT = {
  notScanned: ['queued', 'needsReview', 'protected', 'needsAttention'],
  queued: ['scanning', 'notScanned', 'needsReview', 'protected', 'needsAttention'],
  scanning: ['needsReview', 'protected', 'needsAttention', 'queued', 'notScanned'],
  needsReview: ['queued', 'protected', 'needsAttention', 'notScanned'],
  protected: ['queued', 'needsReview', 'needsAttention', 'notScanned'],
  needsAttention: ['queued', 'needsReview', 'protected', 'notScanned']
};

function noop() {}
var silentLog = { debug: noop, info: noop, warn: noop, error: noop };

function titleFromFile(file) {
  var base = path.basename(file).replace(/\.[^.]+$/, '');
  var year = null;
  var m = /[\s._(\[-]((?:19|20)\d{2})(?:[\s._)\]-]|$)/.exec(base);
  if (m) {
    year = parseInt(m[1], 10);
    base = base.slice(0, m.index);
  }
  base = base.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { title: base || path.basename(file), year: year };
}

// Planner decision 2: a scan that found nothing still needs one parent click before kids see it.
// These texts go into the skip file's history for the record only. Status never trusts history
// (board review A4): the parent's whole-title approval lives in the HMAC'd library index
// (item.wholeApproved), and a list changed outside the app or imported is flagged there too
// (item.outside = 'changed' | 'imported') until the parent confirms it ("Use this list for kids").
var CLEAN_APPROVAL = 'no scenes found; approved for kids by a parent';
var MARKED_REVIEWED = 'marked fully reviewed by a parent';
var TRUSTED = 'list confirmed for kids by a parent';

// Status from a skip document (null = never scanned) and its library item. Pure; exported for tests.
function deriveStatus(doc, validate, item) {
  if (!doc) { return { status: 'notScanned', pending: 0, enforced: 0, total: 0 }; }
  if (validate && !validate(doc).ok) { return { status: 'needsAttention', error: 'skipCorrupt', pending: 0, enforced: 0, total: 0 }; }
  var it = item || {};
  var ranges = doc.ranges || [];
  var pending = 0, enforced = 0, i;
  for (i = 0; i < ranges.length; i++) {
    if (ranges[i].review === 'pending') { pending++; }
    if (ranges[i].review !== 'rejected' && ranges[i].action !== 'none') { enforced++; }
  }
  var complete = !!(doc.scan && doc.scan.status === 'complete');
  var status;
  var clean = complete && !ranges.length && it.wholeApproved !== true;
  var outside = it.outside === 'changed' || it.outside === 'imported' ? it.outside : null;
  if (complete) { status = pending || clean || outside ? 'needsReview' : 'protected'; } else { status = ranges.length || outside ? 'needsReview' : 'notScanned'; }
  return { status: status, pending: pending, enforced: enforced, total: ranges.length, complete: complete, cleanPending: clean && !outside, outside: outside };
}

function createLibrary(options) {
  var o = options || {};
  var store = o.store;
  var log = o.log || silentLog;
  var ffprobe = o.ffprobe || function () { return 'ffprobe'; };
  var items = [];
  var listeners = [];

  function save() { store.writeEnvelope(FILE, { version: 1, items: items }); }

  function changed() {
    save();
    listeners.forEach(function (fn) { try { fn(list()); } catch (e) { log.error('library listener', e); } });
  }

  // A library index that fails its HMAC (and has no good backup) was edited outside the app:
  // nothing in it is trusted, so every title with a list goes back to Needs review (board A4).
  function load() {
    var info = {};
    var d = store.readEnvelope(FILE, info);
    items = d && Array.isArray(d.items) ? d.items.filter(function (it) {
      return it && typeof it.id === 'string' && /^[0-9a-f]{16}$/.test(it.id) && typeof it.path === 'string';
    }) : [];
    items.forEach(function (it) {
      if (STATUSES.indexOf(it.status) < 0) { it.status = 'notScanned'; }
      if (info.tampered) {
        it.wholeApproved = false;
        if (it.status !== 'notScanned') { it.outside = 'changed'; }
        if (it.status === 'protected') { it.status = 'needsReview'; }
      }
    });
    if (info.tampered) { log.warn('library index changed outside the app; every list needs review'); save(); }
    return list();
  }

  function copy(it) { return JSON.parse(JSON.stringify(it)); }

  function list() { return items.map(copy); }

  function find(id) {
    var i;
    for (i = 0; i < items.length; i++) { if (items[i].id === id) { return items[i]; } }
    return null;
  }

  function get(id) { var it = find(id); return it ? copy(it) : null; }

  function addOne(file, cb) {
    fs.stat(file, function (e, st) {
      if (e || !st.isFile()) { cb(null, { path: file, result: 'failed', reason: 'notFound' }); return; }
      probe.media(ffprobe(), file, function (pe, info) {
        if (pe || !info || !info.hasVideo) { cb(null, { path: file, result: 'failed', reason: 'notVideo' }); return; }
        fingerprint.fingerprint(file, function (fe, fp) {
          if (fe) { cb(null, { path: file, result: 'failed', reason: 'unreadable' }); return; }
          var existing = find(fp.oshash);
          if (existing) {
            if (existing.path !== file && !fs.existsSync(existing.path)) { existing.path = file; existing.filename = path.basename(file); }
            cb(null, { path: file, result: 'duplicate', id: existing.id });
            return;
          }
          var t = titleFromFile(file);
          items.push({
            id: fp.oshash, path: file, filename: path.basename(file), title: t.title, year: t.year,
            size: fp.size, oshash: fp.oshash, headSha256: fp.headSha256, duration: info.duration,
            start: typeof info.start === 'number' ? info.start : 0,
            addedAt: new Date().toISOString(), status: 'notScanned', progress: 0, stage: null,
            error: null, pending: 0, enforced: 0, total: 0, resumeAt: 0, scannedAt: null
          });
          cb(null, { path: file, result: 'added', id: fp.oshash });
        });
      });
    });
  }

  // cb(null, {added:[ids], duplicates:[ids], failed:[{path, reason}]})
  function add(paths, cb) {
    var res = { added: [], duplicates: [], failed: [] };
    var i = 0;
    function next() {
      if (i >= paths.length) {
        if (res.added.length || res.duplicates.length) { changed(); }
        cb(null, res);
        return;
      }
      addOne(paths[i++], function (e, r) {
        if (r.result === 'added') { res.added.push(r.id); } else if (r.result === 'duplicate') { res.duplicates.push(r.id); } else { res.failed.push({ path: r.path, reason: r.reason }); }
        next();
      });
    }
    next();
  }

  function remove(id) {
    var i;
    for (i = 0; i < items.length; i++) {
      if (items[i].id === id) { items.splice(i, 1); changed(); return true; }
    }
    return false;
  }

  // Moves the status machine. Illegal moves are logged and refused.
  function setStatus(id, status, extra) {
    var it = find(id);
    var k;
    if (!it || STATUSES.indexOf(status) < 0) { return false; }
    if (it.status !== status && NEXT[it.status].indexOf(status) < 0) {
      log.warn('refused status move', it.status, '->', status);
      return false;
    }
    it.status = status;
    if (status !== 'scanning') { it.stage = null; }
    if (status !== 'needsAttention') { it.error = null; }
    if (extra) { for (k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { it[k] = extra[k]; } } }
    changed();
    return true;
  }

  function update(id, patch, quiet) {
    var it = find(id);
    var k;
    if (!it) { return false; }
    for (k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k) && k !== 'id' && k !== 'status') { it[k] = patch[k]; } }
    if (quiet) { save(); } else { changed(); }
    return true;
  }

  // Re-derive status and counts from the skip document (after a scan, an edit or at start).
  // force: a scan just finished, so leave queued/scanning too.
  function applyDoc(id, doc, validate, force) {
    var it = find(id);
    if (!it) { return null; }
    if (!force && (it.status === 'queued' || it.status === 'scanning')) {
      var d0 = deriveStatus(doc, validate, it);
      it.pending = d0.pending; it.enforced = d0.enforced; it.total = d0.total; it.cleanPending = !!d0.cleanPending;
      changed();
      return copy(it);
    }
    var d = deriveStatus(doc, validate, it);
    it.pending = d.pending; it.enforced = d.enforced; it.total = d.total; it.cleanPending = !!d.cleanPending;
    if (!(it.status === 'needsAttention' && d.status === 'notScanned')) {
      // When the parent finished the review (every scene decided, or the title approved as a
      // whole): the parents card says "checked by you on <date>" (round 2, X2).
      if (d.status === 'protected' && (it.status !== 'protected' || !it.reviewedAt)) { it.reviewedAt = new Date().toISOString(); }
      it.status = d.status;
      it.error = d.error || null;
    }
    changed();
    return copy(it);
  }

  return {
    load: load, list: list, get: get, add: add, remove: remove, setStatus: setStatus,
    update: update, applyDoc: applyDoc, onChange: function (fn) { listeners.push(fn); }
  };
}

module.exports = { createLibrary: createLibrary, deriveStatus: deriveStatus, titleFromFile: titleFromFile, STATUSES: STATUSES,
  CLEAN_APPROVAL: CLEAN_APPROVAL, MARKED_REVIEWED: MARKED_REVIEWED, TRUSTED: TRUSTED };
