'use strict';
// Tiny levelled logger: one file under a caller-given directory, rotated 5 x 1 MB, plus console
// output in development. Never throws. Callers must not pass file names of flagged frames or
// range notes (PLAN.md 6); this module does not inspect messages.

var fs = require('fs');
var path = require('path');

var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };

function safeString(value) {
  if (value === undefined) { return ''; }
  if (value instanceof Error) { return value.stack || String(value); }
  if (typeof value === 'string') { return value; }
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

function createLog(options) {
  var opts = options || {};
  var dir = opts.dir || null;
  var name = opts.name || 'bonis';
  var maxBytes = opts.maxBytes || 1024 * 1024;
  var files = opts.files || 5;
  var threshold = LEVELS[opts.level] || LEVELS.info;
  var toConsole = !!opts.console;
  var file = dir ? path.join(dir, name + '.log') : null;
  var size = -1;
  var dirTried = false;

  function rotated(i) { return path.join(dir, name + '.' + i + '.log'); }

  function rotate() {
    var i;
    try { fs.unlinkSync(rotated(files - 1)); } catch (e) { /* absent */ }
    for (i = files - 2; i >= 1; i--) {
      try { fs.renameSync(rotated(i), rotated(i + 1)); } catch (e2) { /* absent */ }
    }
    try { fs.renameSync(file, rotated(1)); } catch (e3) { /* absent */ }
    size = 0;
  }

  function writeFile(line) {
    if (!file) { return; }
    try {
      if (size < 0) {
        if (!dirTried) {
          dirTried = true;
          try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* exists or not creatable */ }
        }
        try { size = fs.statSync(file).size; } catch (e2) { size = 0; }
      }
      var bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) { rotate(); }
      fs.appendFileSync(file, line);
      size += bytes;
    } catch (e3) {
      size = -1;
    }
  }

  function write(level, scope, args) {
    if (LEVELS[level] < threshold) { return; }
    var parts = [];
    var i;
    for (i = 0; i < args.length; i++) { parts.push(safeString(args[i])); }
    var line = new Date().toISOString() + ' ' + level.toUpperCase() + ' ' +
      (scope ? '[' + scope + '] ' : '') + parts.join(' ') + '\n';
    writeFile(line);
    if (toConsole) {
      try {
        if (level === 'error' || level === 'warn') { process.stderr.write(line); } else { process.stdout.write(line); }
      } catch (e) { /* closed stream */ }
    }
  }

  function make(scope) {
    return {
      debug: function () { write('debug', scope, arguments); },
      info: function () { write('info', scope, arguments); },
      warn: function () { write('warn', scope, arguments); },
      error: function () { write('error', scope, arguments); },
      child: function (sub) { return make(scope ? scope + '/' + sub : sub); },
      file: file
    };
  }

  return make(opts.scope || '');
}

module.exports = { createLog: createLog, LEVELS: LEVELS };
