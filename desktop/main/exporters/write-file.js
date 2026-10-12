'use strict';
// Shared by the exporters: atomic write of a text file next to the movie or in a chosen folder.

var fs = require('fs');
var path = require('path');

function baseName(mediaPath) { return path.basename(mediaPath).replace(/\.[^.]+$/, ''); }

// cb(err, fullPath). err.code: 'notWritable' when the folder refuses the file.
function writeNextTo(mediaPath, dir, fileName, text, cb) {
  var target = path.join(dir || path.dirname(mediaPath), fileName);
  var tmp = target + '.tmp-' + process.pid;
  fs.writeFile(tmp, text, 'utf8', function (err) {
    if (err) {
      var e = new Error('not writable');
      e.code = 'notWritable';
      cb(e);
      return;
    }
    fs.rename(tmp, target, function (err2) {
      if (err2) {
        fs.unlink(tmp, function () {});
        var e2 = new Error('not writable');
        e2.code = 'notWritable';
        cb(e2);
        return;
      }
      cb(null, target);
    });
  });
}

module.exports = { writeNextTo: writeNextTo, baseName: baseName };
