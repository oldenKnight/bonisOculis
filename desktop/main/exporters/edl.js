'use strict';
// Kodi list: "<movie basename>.edl" next to the movie (Kodi finds it by name). One
// "start end action" line per enforced stretch (shared/skipfile.js toKodiEdl).

var BO = require('../../../shared/skipfile.js');
var w = require('./write-file.js');

// opts: {doc, mediaPath, dir?}; cb(err, path)
function exportEdl(opts, cb) {
  var text = BO.toKodiEdl(opts.doc);
  w.writeNextTo(opts.mediaPath, opts.dir, w.baseName(opts.mediaPath) + '.edl', text, cb);
}

module.exports = { exportEdl: exportEdl };
