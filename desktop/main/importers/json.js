'use strict';
// Import a native skip file (SKIPFILE.md "Matching rules"): validate with BO.skipfile.fromJson,
// match by oshash + size, then by headSha256 (with a warning), else the parent picks the movie
// and the file is applied with offset 0 and a warning (the edition may differ).

var BO = require('../../../shared/skipfile.js');

function findMatch(doc, items) {
  var fp = doc.media && doc.media.fingerprint ? doc.media.fingerprint : {};
  var i;
  for (i = 0; i < items.length; i++) {
    if (items[i].oshash === fp.oshash && items[i].size === fp.size) { return { item: items[i], match: 'exact' }; }
  }
  if (fp.headSha256) {
    for (i = 0; i < items.length; i++) {
      if (items[i].headSha256 && items[i].headSha256 === fp.headSha256) { return { item: items[i], match: 'head' }; }
    }
  }
  return null;
}

// opts: {text, library, skips, targetId?}. Returns {ok, error?, data?}; data.needsPick asks the
// renderer to let the parent choose the movie and call again with targetId.
function importJson(opts) {
  var parsed = BO.fromJson(opts.text);
  if (!parsed.ok) { return { ok: false, error: 'invalidSkip' }; }
  var doc = parsed.doc;
  var items = opts.library.list();
  var m;
  if (opts.targetId) {
    var it = opts.library.get(opts.targetId);
    if (!it) { return { ok: false, error: 'notFound' }; }
    m = findMatch(doc, [it]) || { item: it, match: 'manual' };
  } else {
    m = findMatch(doc, items);
    if (!m) { return { ok: true, data: { needsPick: true, title: doc.media.title || '', candidates: items.map(function (x) { return { id: x.id, title: x.title }; }) } }; }
  }
  var target = m.item;
  var incoming = JSON.parse(JSON.stringify(doc));
  incoming.media.fingerprint = { size: target.size, oshash: target.oshash };
  if (target.headSha256) { incoming.media.fingerprint.headSha256 = target.headSha256; }
  if (m.match === 'manual') { incoming.media.offset = 0; }
  var existing = opts.skips.load(target.id).doc;
  var out = existing ? BO.merge(existing, incoming) : incoming;
  if (existing) { out.media.fingerprint = incoming.media.fingerprint; }
  if (m.match === 'manual') { out.media.offset = 0; }
  BO.addHistory(out, 'imported', null, m.match === 'exact' ? 'matched by fingerprint' : (m.match === 'head' ? 'matched by file start' : 'chosen by a parent; offset 0'));
  out.summary = BO.summarise(out);
  var v = BO.validate(out);
  if (!v.ok) { return { ok: false, error: 'invalidSkip' }; }
  var r = opts.skips.replace(target.id, out, true);
  if (!r.ok) { return { ok: false, error: r.error }; }
  return { ok: true, data: { id: target.id, match: m.match, warning: m.match === 'exact' ? null : (m.match === 'head' ? 'headOnly' : 'offsetUnknown'), ranges: out.ranges.length } };
}

module.exports = { importJson: importJson, findMatch: findMatch };
