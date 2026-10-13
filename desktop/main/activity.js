'use strict';
// Activity log (kids-protection commission: audit trail). Append-only JSON lines in
// userData/activity.jsonl; at 5000 lines the file becomes activity.1.jsonl (the previous one is
// dropped) and a new one starts. Entries: {at, type, mode?, id?, title?, detail?, ...}.
// Parent-only to read (activity:list). Never throws; a failed write only loses that line.

var fs = require('fs');
var path = require('path');

var MAX_LINES = 5000;
var TYPES = ['setup', 'unlock', 'pinFailed', 'cooldown', 'lock', 'pinChanged', 'pinRecovered', 'settings', 'play',
  'playUnprotected', 'panic', 'skip', 'letPlay', 'skipAll', 'approveClean', 'markReviewed', 'trust', 'movieLevels', 'playerStopped', 'import', 'remove', 'damaged', 'integrity'];

function createActivity(options) {
  var o = options || {};
  var dir = o.dir;
  var max = o.maxLines || MAX_LINES;
  var file = path.join(dir, 'activity.jsonl');
  var old = path.join(dir, 'activity.1.jsonl');
  var now = o.now || function () { return new Date().toISOString(); };
  var lines = -1;

  // Also ends a line torn by a crash, so the next entry starts on its own line.
  function countLines() {
    var text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
    if (text.length && text.charAt(text.length - 1) !== '\n') { try { fs.appendFileSync(file, '\n'); } catch (e2) { /* next write */ } }
    return text.split('\n').filter(function (l) { return l; }).length;
  }

  function add(type, fields) {
    if (TYPES.indexOf(type) < 0) { return false; }
    var e = { at: now(), type: type };
    var k;
    for (k in (fields || {})) {
      if (Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== undefined && fields[k] !== null) {
        e[k] = typeof fields[k] === 'string' ? fields[k].slice(0, 300) : fields[k];
      }
    }
    try {
      if (lines < 0) { lines = countLines(); }
      if (lines >= max) {
        try { fs.renameSync(file, old); } catch (e2) { /* first rotation */ }
        lines = 0;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(e) + '\n');
      lines += 1;
      return true;
    } catch (e3) { lines = -1; return false; }
  }

  function read(f) {
    var text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return []; }
    var out = [];
    text.split('\n').forEach(function (l) {
      if (!l) { return; }
      try { var v = JSON.parse(l); if (v && typeof v.type === 'string') { out.push(v); } } catch (e2) { /* torn line */ }
    });
    return out;
  }

  // Newest first.
  function list(limit) {
    var all = read(old).concat(read(file));
    all.reverse();
    return all.slice(0, limit || 500);
  }

  return { add: add, list: list, TYPES: TYPES };
}

module.exports = { createActivity: createActivity, MAX_LINES: MAX_LINES };
