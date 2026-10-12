'use strict';
// Native skip file sidecar: "<movie basename>.bonis.json" next to the movie (SKIPFILE.md), or in
// a chosen folder. An optional offset (seconds, other editions) is written with applyOffset.

var BO = require('../../../shared/skipfile.js');
var w = require('./write-file.js');

// opts: {doc, mediaPath, dir?, offset?}; cb(err, path)
function exportJson(opts, cb) {
  var doc = JSON.parse(JSON.stringify(opts.doc));
  if (typeof opts.offset === 'number' && isFinite(opts.offset) && opts.offset !== ((doc.media && doc.media.offset) || 0)) {
    doc = BO.applyOffset(doc, opts.offset);
  }
  BO.addHistory(doc, 'exported', null, 'json');
  var v = BO.validate(doc);
  if (!v.ok) { var e = new Error('invalid'); e.code = 'invalidSkip'; cb(e); return; }
  w.writeNextTo(opts.mediaPath, opts.dir, w.baseName(opts.mediaPath) + '.bonis.json', JSON.stringify(doc, null, 2) + '\n', cb);
}

module.exports = { exportJson: exportJson };
