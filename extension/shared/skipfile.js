/*
 * bonis oculis - shared skip-file library (ES5, no dependencies, no I/O).
 *
 * Loads as a CommonJS module (Electron main, node --test) and as a plain
 * script in the renderer / extension, where it sets window.BO.skipfile.
 *
 * Contract: spec/SKIPFILE.md and spec/skipfile.schema.json. The Python port
 * (analyzer/bonis_analyzer/skipfile.py) must agree with this file on every
 * fixture in spec/fixtures; change both together.
 *
 * Functions that take an optional `opts` accept `opts.now` (an ISO date-time
 * string) so results are reproducible in tests and fixtures.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  } else {
    root.BO = root.BO || {};
    root.BO.skipfile = api;
  }
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var FORMAT = 'bonis-oculis-skip';
  var VERSION = 1;
  var LIB_VERSION = '0.1.0';
  var APP_NAME = 'bonis oculis';
  var MAX_HISTORY = 2000;
  var MAX_ERRORS = 100;

  var CATEGORIES = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language', 'other'];
  var ACTIONS = ['skip', 'hide', 'blur', 'mute', 'none'];
  var VISUAL_ACTIONS = ['skip', 'hide', 'blur'];
  var SOURCES = ['auto', 'manual', 'panic', 'imported'];
  var REVIEWS = ['pending', 'approved', 'rejected'];
  var LEVELS = ['off', 'light', 'moderate', 'strict'];
  var SCAN_STATUS = ['none', 'partial', 'complete'];
  var STAGE_NAMES = ['subtitles', 'frames', 'audio', 'speech', 'captions', 'fusion'];
  var STAGE_STATUS = ['pending', 'running', 'done', 'skipped', 'failed'];
  var SIGNALS = ['frames', 'subtitles', 'audio', 'speech', 'captions'];
  var HISTORY_EVENTS = ['created', 'scanned', 'approved', 'rejected', 'edited', 'added',
    'deleted', 'imported', 'exported', 'panic', 'offsetChanged'];
  var ACTION_STRENGTH = { skip: 4, hide: 3, blur: 2, mute: 1, none: 0 };

  var P_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  var P_OSHASH = '^[0-9a-f]{16}$';
  var P_SHA256 = '^[0-9a-f]{64}$';
  var P_LANGUAGE = '^[a-z]{2}(-[A-Z]{2})?$';
  var P_RANGE_ID = '^r[0-9a-z]{4,16}$';
  var P_SUMMARY_KEY = '^(nudity|sex|implied|kissing|gore|language|other)$';
  var P_LEVEL_KEY = '^(nudity|sex|implied|kissing|gore|language)$';
  var RE_DATE_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?([Zz]|[+-]([0-9]{2}):([0-9]{2}))$/;
  var BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */

  var hasOwn = Object.prototype.hasOwnProperty;

  function has(o, k) { return hasOwn.call(o, k); }

  function isObject(v) {
    return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]';
  }

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function isNumber(v) { return typeof v === 'number' && isFinite(v); }

  function isInteger(v) { return isNumber(v) && Math.floor(v) === v; }

  function num(v) { return isNumber(v) ? v : 0; }

  function inList(list, v) { return list.indexOf(v) >= 0; }

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function cmpStr(a, b) {
    a = String(a); b = String(b);
    if (a < b) { return -1; }
    if (a > b) { return 1; }
    return 0;
  }

  /* Unicode code points, as JSON Schema counts maxLength. */
  function cpLength(s) {
    var n = 0, i, c, d;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { i++; }
      }
      n++;
    }
    return n;
  }

  function cpTruncate(s, max) {
    var n = 0, i = 0, c, d;
    while (i < s.length && n < max) {
      c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { i++; }
      }
      i++; n++;
    }
    return s.slice(0, i);
  }

  function utf8Length(s) {
    var n = 0, i, c, d;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) { n += 1; } else if (c < 0x800) { n += 2; } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length &&
          (d = s.charCodeAt(i + 1)) >= 0xDC00 && d <= 0xDFFF) {
        n += 4; i++;
      } else { n += 3; }
    }
    return n;
  }

  function nowIso(opts) {
    if (opts && typeof opts.now === 'string') { return opts.now; }
    return new Date().toISOString();
  }

  /* Seconds -> integer centiseconds, rounded outward (start down, end up). */
  function floorCs(x) { return Math.floor(x * 100 + 1e-4); }
  function ceilCs(x) { return Math.ceil(x * 100 - 1e-4); }

  function fmtCs(n) {
    var i = Math.floor(n / 100), f = n - i * 100;
    return i + '.' + (f < 10 ? '0' : '') + f;
  }

  /* Seconds for human-readable history details: at most 3 decimals, no trailing zeros. */
  function fmtSeconds(x) {
    var sign = x < 0 ? '-' : '', ms = Math.floor(Math.abs(x) * 1000 + 0.5);
    var i = Math.floor(ms / 1000), f = ms - i * 1000, frac;
    if (ms === 0) { return '0'; }
    if (f === 0) { return sign + i; }
    frac = String(f);
    while (frac.length < 3) { frac = '0' + frac; }
    frac = frac.replace(/0+$/, '');
    return sign + i + '.' + frac;
  }

  function round3(x) { return Math.floor(x * 1000 + 0.5) / 1000; }

  /* ------------------------------------------------------------------ */
  /* randomness: uuid v4 and range ids                                   */
  /* ------------------------------------------------------------------ */

  function randomBytes(n) {
    var out = [], i, buf, c;
    try {
      if (typeof require === 'function') {
        c = require('crypto');
        if (c && typeof c.randomBytes === 'function') {
          buf = c.randomBytes(n);
          for (i = 0; i < n; i++) { out.push(buf[i]); }
          return out;
        }
      }
    } catch (e1) { out = []; }
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' &&
          typeof Uint8Array !== 'undefined') {
        buf = new Uint8Array(n);
        crypto.getRandomValues(buf);
        for (i = 0; i < n; i++) { out.push(buf[i]); }
        return out;
      }
    } catch (e2) { out = []; }
    for (i = 0; i < n; i++) { out.push(Math.floor(Math.random() * 256) & 255); }
    return out;
  }

  function uuid4() {
    var b = randomBytes(16), hex = '', i, h;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    for (i = 0; i < 16; i++) {
      h = b[i].toString(16);
      hex += (h.length < 2 ? '0' : '') + h;
      if (i === 3 || i === 5 || i === 7 || i === 9) { hex += '-'; }
    }
    return hex;
  }

  function rangeId() {
    var id = 'r', b, i;
    while (id.length < 9) {
      b = randomBytes(16);
      for (i = 0; i < b.length && id.length < 9; i++) {
        if (b[i] < 252) { id += BASE36.charAt(b[i] % 36); }
      }
    }
    return id;
  }

  /* Deterministic unique id derived from `base` (used for split pieces and collisions). */
  function deriveId(base, used) {
    var k = 1, suffix, stem, cand;
    base = String(base);
    for (;;) {
      suffix = k.toString(36);
      stem = base;
      if (stem.length + suffix.length > 17) { stem = stem.slice(0, 17 - suffix.length); }
      cand = stem + suffix;
      if (!has(used, cand)) { return cand; }
      k++;
    }
  }

  /* ------------------------------------------------------------------ */
  /* validator (hand-written, mirrors skipfile.schema.json)              */
  /* ------------------------------------------------------------------ */

  function addErr(ctx, path, msg) {
    if (ctx.errors.length < MAX_ERRORS) { ctx.errors.push({ path: path, msg: msg }); }
  }

  function ptr(base, key) {
    return base + '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function vString(maxLen, pattern) {
    var re = pattern ? new RegExp(pattern) : null;
    return function (ctx, v, path) {
      if (typeof v !== 'string') { addErr(ctx, path, 'must be a string'); return; }
      if (maxLen !== null && cpLength(v) > maxLen) { addErr(ctx, path, 'must be at most ' + maxLen + ' characters'); }
      if (re && !re.test(v)) { addErr(ctx, path, 'must match ' + pattern); }
    };
  }

  function vNumber(min, max) {
    return function (ctx, v, path) {
      if (!isNumber(v)) { addErr(ctx, path, 'must be a number'); return; }
      if (min !== null && v < min) { addErr(ctx, path, 'must be >= ' + min); }
      if (max !== null && v > max) { addErr(ctx, path, 'must be <= ' + max); }
    };
  }

  function vInteger(min, max) {
    return function (ctx, v, path) {
      if (!isInteger(v)) { addErr(ctx, path, 'must be an integer'); return; }
      if (min !== null && v < min) { addErr(ctx, path, 'must be >= ' + min); }
      if (max !== null && v > max) { addErr(ctx, path, 'must be <= ' + max); }
    };
  }

  function vEnum(list) {
    return function (ctx, v, path) {
      if (typeof v !== 'string' || !inList(list, v)) { addErr(ctx, path, 'must be one of: ' + list.join(', ')); }
    };
  }

  function vBoolean(ctx, v, path) {
    if (typeof v !== 'boolean') { addErr(ctx, path, 'must be a boolean'); }
  }

  function daysInMonth(y, m) {
    if (m === 2) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28; }
    return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
  }

  function isDateTime(v) {
    var m = RE_DATE_TIME.exec(v), y, mo, d;
    if (!m) { return false; }
    y = parseInt(m[1], 10); mo = parseInt(m[2], 10); d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) { return false; }
    if (parseInt(m[4], 10) > 23 || parseInt(m[5], 10) > 59 || parseInt(m[6], 10) > 60) { return false; }
    if (m[9] !== undefined && m[9] !== '' && (parseInt(m[9], 10) > 23 || parseInt(m[10], 10) > 59)) { return false; }
    return true;
  }

  function vDateTime(ctx, v, path) {
    if (typeof v !== 'string') { addErr(ctx, path, 'must be a string'); return; }
    if (!isDateTime(v)) { addErr(ctx, path, 'must be an RFC 3339 date-time'); }
  }

  function vArray(maxItems, item) {
    return function (ctx, v, path) {
      var i;
      if (!isArray(v)) { addErr(ctx, path, 'must be an array'); return; }
      if (maxItems !== null && v.length > maxItems) { addErr(ctx, path, 'must have at most ' + maxItems + ' items'); }
      for (i = 0; i < v.length; i++) { item(ctx, v[i], ptr(path, i)); }
    };
  }

  /*
   * spec: { order: [names], props: {name: fn}, required: [names],
   *         pattern: source|null, patternFn: fn|null, allowExtra: bool }
   * Error order: required (schema order), unknown keys (sorted), then each
   * known property in schema order, then pattern properties (sorted keys).
   */
  function vObject(spec) {
    var re = spec.pattern ? new RegExp(spec.pattern) : null;
    return function (ctx, v, path, allowExtra) {
      var keys, i, k;
      if (!isObject(v)) { addErr(ctx, path, 'must be an object'); return false; }
      for (i = 0; i < spec.required.length; i++) {
        if (!has(v, spec.required[i])) { addErr(ctx, ptr(path, spec.required[i]), 'is required'); }
      }
      keys = Object.keys(v).sort(cmpStr);
      for (i = 0; i < keys.length; i++) {
        k = keys[i];
        if (has(spec.props, k) || (re && re.test(k))) { continue; }
        if (!allowExtra) { addErr(ctx, ptr(path, k), 'is not allowed'); }
      }
      for (i = 0; i < spec.order.length; i++) {
        k = spec.order[i];
        if (has(v, k)) { spec.props[k](ctx, v[k], ptr(path, k)); }
      }
      if (re) {
        for (i = 0; i < keys.length; i++) {
          k = keys[i];
          if (!has(spec.props, k) && re.test(k)) { spec.patternFn(ctx, v[k], ptr(path, k)); }
        }
      }
      return true;
    };
  }

  function objSpec(order, props, required) {
    return { order: order, props: props, required: required || [], pattern: null, patternFn: null };
  }

  var vGenerator = vObject(objSpec(['app', 'appVersion', 'analyzerVersion', 'modelSet'], {
    app: vString(null, null),
    appVersion: vString(null, null),
    analyzerVersion: vString(null, null),
    modelSet: vString(null, null)
  }, ['app', 'appVersion']));

  var vFingerprint = vObject(objSpec(['size', 'oshash', 'headSha256', 'sceneCuts'], {
    size: vInteger(0, null),
    oshash: vString(null, P_OSHASH),
    headSha256: vString(null, P_SHA256),
    sceneCuts: vArray(20000, vNumber(0, null))
  }, ['size', 'oshash']));

  var vMedia = vObject(objSpec(['title', 'year', 'duration', 'filename', 'offset', 'fingerprint'], {
    title: vString(500, null),
    year: vInteger(1880, 2200),
    duration: vNumber(0, null),
    filename: vString(1024, null),
    offset: vNumber(null, null),
    fingerprint: vFingerprint
  }, ['title', 'duration', 'fingerprint']));

  var vSignals = vObject(objSpec(SIGNALS, {
    frames: vNumber(0, 1),
    subtitles: vNumber(0, 1),
    audio: vNumber(0, 1),
    speech: vNumber(0, 1),
    captions: vNumber(0, 1)
  }, []));

  var vRangeObject = vObject(objSpec(
    ['id', 'start', 'end', 'category', 'confidence', 'intensity', 'action', 'source', 'review',
      'locked', 'signals', 'note', 'cutStart', 'cutEnd'], {
      id: vString(null, P_RANGE_ID),
      start: vNumber(0, null),
      end: vNumber(0, null),
      category: vEnum(CATEGORIES),
      confidence: vNumber(0, 1),
      intensity: vInteger(1, 3),
      action: vEnum(ACTIONS),
      source: vEnum(SOURCES),
      review: vEnum(REVIEWS),
      locked: vBoolean,
      signals: vSignals,
      note: vString(300, null),
      cutStart: vNumber(0, null),
      cutEnd: vNumber(0, null)
    }, ['id', 'start', 'end', 'category', 'confidence', 'action', 'source', 'review']));

  function vRange(ctx, v, path) {
    if (!vRangeObject(ctx, v, path, false)) { return; }
    if (isNumber(v.start) && isNumber(v.end) && !(v.end > v.start)) {
      addErr(ctx, ptr(path, 'end'), 'must be greater than start');
    }
  }

  var vStage = vObject(objSpec(['status', 'progress', 'resumeAt', 'detail', 'model', 'seconds'], {
    status: vEnum(STAGE_STATUS),
    progress: vNumber(0, 1),
    resumeAt: vNumber(0, null),
    detail: vString(300, null),
    model: vString(null, null),
    seconds: vNumber(0, null)
  }, ['status']));

  var stageProps = {}, si;
  for (si = 0; si < STAGE_NAMES.length; si++) { stageProps[STAGE_NAMES[si]] = vStage; }
  var vStages = vObject(objSpec(STAGE_NAMES, stageProps, []));

  var vLevels = vObject({ order: [], props: {}, required: [], pattern: P_LEVEL_KEY, patternFn: vEnum(LEVELS) });

  var vScan = vObject(objSpec(['status', 'startedAt', 'finishedAt', 'stages', 'levels', 'device', 'warnings'], {
    status: vEnum(SCAN_STATUS),
    startedAt: vDateTime,
    finishedAt: vDateTime,
    stages: vStages,
    levels: vLevels,
    device: vString(null, null),
    warnings: vArray(100, vString(500, null))
  }, []));

  var vSummaryEntry = vObject(objSpec(['count', 'seconds', 'maxIntensity'], {
    count: vInteger(0, null),
    seconds: vNumber(0, null),
    maxIntensity: vInteger(0, 3)
  }, []));

  var vSummary = vObject({ order: [], props: {}, required: [], pattern: P_SUMMARY_KEY, patternFn: vSummaryEntry });

  var vHistoryEntry = vObject(objSpec(['at', 'event', 'rangeId', 'detail'], {
    at: vDateTime,
    event: vEnum(HISTORY_EVENTS),
    rangeId: vString(null, P_RANGE_ID),
    detail: vString(200, null)
  }, ['at', 'event']));

  function vFormat(ctx, v, path) {
    if (v !== FORMAT) { addErr(ctx, path, 'must be "' + FORMAT + '"'); }
  }

  function vVersion(ctx, v, path) {
    if (!isInteger(v)) { addErr(ctx, path, 'must be an integer'); return; }
    if (v < VERSION) { addErr(ctx, path, 'must be >= ' + VERSION); }
  }

  var vDoc = vObject(objSpec(
    ['format', 'version', 'id', 'created', 'modified', 'generator', 'media', 'language', 'ranges',
      'scan', 'summary', 'history'], {
      format: vFormat,
      version: vVersion,
      id: vString(null, P_UUID),
      created: vDateTime,
      modified: vDateTime,
      generator: vGenerator,
      media: vMedia,
      language: vString(null, P_LANGUAGE),
      ranges: vArray(null, vRange),
      scan: vScan,
      summary: vSummary,
      history: vArray(MAX_HISTORY, vHistoryEntry)
    }, ['format', 'version', 'id', 'created', 'modified', 'generator', 'media', 'ranges']));

  /*
   * validate(doc) -> {ok, errors: [{path, msg}]}
   * Paths are JSON Pointers ("" is the document itself). `version` is any
   * integer >= 1 and unknown top-level keys are ignored (schema: top-level
   * additionalProperties true, for forward compatibility); every known key
   * is still checked against v1, and nested objects stay strict.
   *
   * Kid mode (player, M3/M5) additionally requires scan.status ===
   * 'complete'; a missing scan block counts as 'none'. validate() does not
   * check that: a valid file may still be unplayable in kid mode.
   */
  function validate(doc) {
    var ctx = { errors: [] };
    vDoc(ctx, doc, '', true);
    return { ok: ctx.errors.length === 0, errors: ctx.errors };
  }

  /* ------------------------------------------------------------------ */
  /* ranges: ordering, enforcement, intervals                            */
  /* ------------------------------------------------------------------ */

  function isEnforced(r) {
    return isObject(r) && r.review !== 'rejected' && r.action !== 'none';
  }

  function isVisual(r) { return inList(VISUAL_ACTIONS, r.action); }

  function byTime(a, b) {
    if (a.start !== b.start) { return a.start < b.start ? -1 : 1; }
    if (a.end !== b.end) { return a.end < b.end ? -1 : 1; }
    return cmpStr(a.id, b.id);
  }

  /* Overlap precedence, highest first: visual action, locked, confidence,
     approved, intensity, then earlier start, earlier end, id. */
  function byPrecedence(a, b) {
    var x, y;
    x = isVisual(a) ? 1 : 0; y = isVisual(b) ? 1 : 0;
    if (x !== y) { return y - x; }
    x = a.locked === true ? 1 : 0; y = b.locked === true ? 1 : 0;
    if (x !== y) { return y - x; }
    x = num(a.confidence); y = num(b.confidence);
    if (x !== y) { return x > y ? -1 : 1; }
    x = a.review === 'approved' ? 1 : 0; y = b.review === 'approved' ? 1 : 0;
    if (x !== y) { return y - x; }
    x = num(a.intensity); y = num(b.intensity);
    if (x !== y) { return x > y ? -1 : 1; }
    return byTime(a, b);
  }

  /* Union of [start, end) intervals; touching intervals are joined. */
  function union(list) {
    var s = list.slice().sort(function (a, b) {
      if (a[0] !== b[0]) { return a[0] < b[0] ? -1 : 1; }
      if (a[1] !== b[1]) { return a[1] < b[1] ? -1 : 1; }
      return 0;
    });
    var out = [], i, last;
    for (i = 0; i < s.length; i++) {
      last = out.length ? out[out.length - 1] : null;
      if (last && s[i][0] <= last[1]) {
        if (s[i][1] > last[1]) { last[1] = s[i][1]; }
      } else {
        out.push([s[i][0], s[i][1]]);
      }
    }
    return out;
  }

  /* [start, end) minus a sorted union -> list of pieces. */
  function subtract(start, end, u) {
    var pieces = [], cur = start, i;
    for (i = 0; i < u.length; i++) {
      if (u[i][1] <= cur || u[i][0] >= end) { continue; }
      if (u[i][0] > cur) { pieces.push([cur, u[i][0]]); }
      if (u[i][1] > cur) { cur = u[i][1]; }
    }
    if (cur < end) { pieces.push([cur, end]); }
    return pieces;
  }

  function overlapLength(start, end, u) {
    var total = 0, i, a, b;
    for (i = 0; i < u.length; i++) {
      a = u[i][0] > start ? u[i][0] : start;
      b = u[i][1] < end ? u[i][1] : end;
      if (b > a) { total += b - a; }
    }
    return total;
  }

  function containedIn(start, end, u) {
    var i;
    for (i = 0; i < u.length; i++) {
      if (u[i][0] <= start && end <= u[i][1]) { return true; }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* summary / history                                                   */
  /* ------------------------------------------------------------------ */

  /* Per-category counts of ENFORCED ranges only: review pending or approved
     AND action != none (schema: summary). */
  function summarise(doc) {
    var s = {}, i, r, e, ranges = isObject(doc) && isArray(doc.ranges) ? doc.ranges : [];
    for (i = 0; i < CATEGORIES.length; i++) { s[CATEGORIES[i]] = { count: 0, seconds: 0, maxIntensity: 0 }; }
    for (i = 0; i < ranges.length; i++) {
      r = ranges[i];
      if (!isObject(r) || !has(s, r.category) || (r.review !== 'pending' && r.review !== 'approved') || r.action === 'none') { continue; }
      if (!isNumber(r.start) || !isNumber(r.end)) { continue; }
      e = s[r.category];
      e.count += 1;
      e.seconds += r.end - r.start;
      if (isInteger(r.intensity) && r.intensity > e.maxIntensity) { e.maxIntensity = r.intensity; }
    }
    for (i = 0; i < CATEGORIES.length; i++) { s[CATEGORIES[i]].seconds = round3(s[CATEGORIES[i]].seconds); }
    return s;
  }

  /*
   * addHistory(doc, event, rangeId, detail[, opts]) -> doc
   * Mutates doc in place (append-only trail). Keeps the newest 2000
   * entries. Detail is cut to 200 code points. Throws on unknown events.
   */
  function addHistory(doc, event, rangeId, detail, opts) {
    var e;
    if (!inList(HISTORY_EVENTS, event)) { throw new TypeError('unknown history event: ' + event); }
    if (!isArray(doc.history)) { doc.history = []; }
    e = { at: nowIso(opts), event: event };
    if (rangeId !== undefined && rangeId !== null && rangeId !== '') { e.rangeId = String(rangeId); }
    if (detail !== undefined && detail !== null && detail !== '') { e.detail = cpTruncate(String(detail), 200); }
    doc.history.push(e);
    if (doc.history.length > MAX_HISTORY) { doc.history.splice(0, doc.history.length - MAX_HISTORY); }
    return doc;
  }

  /* ------------------------------------------------------------------ */
  /* normalise                                                           */
  /* ------------------------------------------------------------------ */

  function mergeCluster(members) {
    var keeper = members.slice().sort(byPrecedence)[0];
    var out = clone(keeper), i, m, k, best, allApproved = true, endMember = members[0];
    var hasIntensity = false, maxIntensity = 0, sig = null;
    out.start = members[0].start;
    out.end = members[0].end;
    out.confidence = num(members[0].confidence);
    out.action = members[0].action;
    for (i = 0; i < members.length; i++) {
      m = members[i];
      if (m.start < out.start) { out.start = m.start; }
      if (m.end > out.end) { out.end = m.end; endMember = m; }
      if (num(m.confidence) > out.confidence) { out.confidence = m.confidence; }
      if (ACTION_STRENGTH[m.action] > ACTION_STRENGTH[out.action]) { out.action = m.action; }
      if (m.review !== 'approved') { allApproved = false; }
      if (isInteger(m.intensity) && (!hasIntensity || m.intensity > maxIntensity)) {
        hasIntensity = true; maxIntensity = m.intensity;
      }
      if (isObject(m.signals)) {
        if (!sig) { sig = {}; }
        for (k = 0; k < SIGNALS.length; k++) {
          best = m.signals[SIGNALS[k]];
          if (isNumber(best) && (!has(sig, SIGNALS[k]) || best > sig[SIGNALS[k]])) { sig[SIGNALS[k]] = best; }
        }
      }
    }
    out.review = allApproved ? 'approved' : 'pending';
    if (hasIntensity) { out.intensity = maxIntensity; } else { delete out.intensity; }
    if (sig) { out.signals = orderedSignals(sig); } else { delete out.signals; }
    if (has(members[0], 'cutStart')) { out.cutStart = members[0].cutStart; } else { delete out.cutStart; }
    if (has(endMember, 'cutEnd')) { out.cutEnd = endMember.cutEnd; } else { delete out.cutEnd; }
    return out;
  }

  function orderedSignals(sig) {
    var o = {}, k;
    for (k = 0; k < SIGNALS.length; k++) { if (has(sig, SIGNALS[k])) { o[SIGNALS[k]] = sig[SIGNALS[k]]; } }
    return o;
  }

  /* Phase A: merge overlapping enforced, unlocked ranges of the same category. */
  function mergeSameCategory(list) {
    var out = [], c, i, r, group, cluster, clusterEnd;
    for (i = 0; i < list.length; i++) {
      if (list[i].locked === true) { out.push(list[i]); }
    }
    for (c = 0; c < CATEGORIES.length; c++) {
      group = [];
      for (i = 0; i < list.length; i++) {
        r = list[i];
        if (r.locked !== true && r.category === CATEGORIES[c]) { group.push(r); }
      }
      cluster = [];
      clusterEnd = 0;
      for (i = 0; i <= group.length; i++) {
        r = group[i];
        if (r && cluster.length && r.start < clusterEnd) {
          cluster.push(r);
          if (r.end > clusterEnd) { clusterEnd = r.end; }
          continue;
        }
        if (cluster.length === 1) { out.push(cluster[0]); } else if (cluster.length > 1) { out.push(mergeCluster(cluster)); }
        if (r) { cluster = [r]; clusterEnd = r.end; }
      }
    }
    /* uncategorised (invalid) ranges pass through untouched */
    for (i = 0; i < list.length; i++) {
      if (list[i].locked !== true && !inList(CATEGORIES, list[i].category)) { out.push(list[i]); }
    }
    return out;
  }

  /* Phase B: higher-precedence ranges win; lower ones are trimmed (split if
     needed). Locked ranges are never trimmed. */
  function resolveOverlaps(list, used) {
    var order = list.slice().sort(byPrecedence), out = [], taken = [], i, r, pieces, p, piece;
    for (i = 0; i < order.length; i++) {
      r = order[i];
      if (r.locked === true) {
        out.push(r);
        taken.push([r.start, r.end]);
        continue;
      }
      pieces = subtract(r.start, r.end, union(taken));
      for (p = 0; p < pieces.length; p++) {
        piece = clone(r);
        if (p > 0) {
          piece.id = deriveId(r.id, used);
          used[piece.id] = true;
        }
        piece.start = pieces[p][0];
        piece.end = pieces[p][1];
        if (piece.start !== r.start) { delete piece.cutStart; }
        if (piece.end !== r.end) { delete piece.cutEnd; }
        out.push(piece);
        taken.push([piece.start, piece.end]);
      }
    }
    return out;
  }

  /*
   * normalise(doc[, opts]) -> new doc
   * Deep copy; clamps ranges to [0, duration] (no upper clamp when duration
   * is 0 = unknown); drops ranges with no length; makes range ids unique;
   * among ENFORCED ranges merges same-category overlaps and resolves the
   * rest by precedence; sorts by start; regenerates summary; sets modified.
   */
  function normalise(doc, opts) {
    var out = clone(doc), media, duration, ranges = [], i, r, used = {}, seen = {}, enforcedList = [], rest = [];
    if (!isObject(out)) { return out; }
    media = isObject(out.media) ? out.media : {};
    duration = num(media.duration);
    var src = isArray(out.ranges) ? out.ranges : [];
    for (i = 0; i < src.length; i++) {
      r = src[i];
      if (!isObject(r) || !isNumber(r.start) || !isNumber(r.end)) { continue; }
      if (r.start < 0) { r.start = 0; }
      if (duration > 0 && r.end > duration) { r.end = duration; }
      if (!(r.end > r.start)) { continue; }
      ranges.push(r);
      used[String(r.id)] = true;
    }
    ranges.sort(byTime);
    for (i = 0; i < ranges.length; i++) {
      r = ranges[i];
      if (has(seen, String(r.id))) {
        r.id = deriveId(r.id, used);
        used[r.id] = true;
      }
      seen[String(r.id)] = true;
      if (isEnforced(r)) { enforcedList.push(r); } else { rest.push(r); }
    }
    enforcedList = resolveOverlaps(mergeSameCategory(enforcedList), used);
    out.ranges = rest.concat(enforcedList).sort(byTime);
    out.summary = summarise(out);
    out.modified = nowIso(opts);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* enforcement and exports                                             */
  /* ------------------------------------------------------------------ */

  /*
   * enforced(doc) -> ranges the player obeys: review != rejected and
   * action != none, with media.offset added, start clamped at 0, empty
   * ones dropped, sorted by start. Returns copies.
   */
  function enforced(doc) {
    var out = [], ranges, offset, i, r, c;
    if (!isObject(doc) || !isArray(doc.ranges)) { return out; }
    ranges = doc.ranges;
    offset = isObject(doc.media) ? num(doc.media.offset) : 0;
    for (i = 0; i < ranges.length; i++) {
      r = ranges[i];
      if (!isEnforced(r) || !isNumber(r.start) || !isNumber(r.end)) { continue; }
      c = clone(r);
      c.start = r.start + offset;
      c.end = r.end + offset;
      if (c.start < 0) { c.start = 0; }
      if (!(c.end > c.start)) { continue; }
      out.push(c);
    }
    return out.sort(byTime);
  }

  /*
   * toKodiEdl(doc) -> string. One "start end action" line per enforced
   * stretch: 0 (cut) for skip/hide/blur, 1 (mute) for mute. Times include
   * media.offset, 2 decimals, rounded outward (start down, end up).
   * Overlapping or touching cuts are joined; mute is dropped where a cut
   * already covers it.
   */
  function toKodiEdl(doc) {
    var rs = enforced(doc), cuts = [], mutes = [], lines = [], i, s, e, out = '', pieces, p;
    for (i = 0; i < rs.length; i++) {
      s = floorCs(rs[i].start);
      e = ceilCs(rs[i].end);
      if (!(e > s)) { continue; }
      if (rs[i].action === 'mute') { mutes.push([s, e]); } else { cuts.push([s, e]); }
    }
    cuts = union(cuts);
    mutes = union(mutes);
    for (i = 0; i < cuts.length; i++) { lines.push([cuts[i][0], cuts[i][1], 0]); }
    for (i = 0; i < mutes.length; i++) {
      pieces = subtract(mutes[i][0], mutes[i][1], cuts);
      for (p = 0; p < pieces.length; p++) { lines.push([pieces[p][0], pieces[p][1], 1]); }
    }
    lines.sort(function (a, b) { return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]); });
    for (i = 0; i < lines.length; i++) { out += fmtCs(lines[i][0]) + ' ' + fmtCs(lines[i][1]) + ' ' + lines[i][2] + '\n'; }
    return out;
  }

  /* mpv EDL file field: "%<utf-8 bytes>%path" when the path needs quoting. */
  function edlPath(p) {
    if (/[,;%=\r\n]/.test(p) || /^[#! \t]/.test(p) || /[ \t]$/.test(p)) {
      return '%' + utf8Length(p) + '%' + p;
    }
    return p;
  }

  /*
   * toMpvEdl(doc, mediaPath) -> string. "# mpv EDL v0" then one
   * "path,start,length" line per KEPT segment. Every enforced range is
   * removed (an mpv EDL cannot mute or hide, so mute ranges are cut too:
   * fail closed). The last segment has no length, so it plays to the end
   * of the file whatever the edition's real duration.
   */
  function toMpvEdl(doc, mediaPath) {
    var rs = enforced(doc), cuts = [], i, s, e, cur = 0, out = '# mpv EDL v0\n', p, media, endCs = null;
    p = edlPath(String(mediaPath === undefined || mediaPath === null ? '' : mediaPath));
    for (i = 0; i < rs.length; i++) {
      s = floorCs(rs[i].start);
      e = ceilCs(rs[i].end);
      if (e > s) { cuts.push([s, e]); }
    }
    cuts = union(cuts);
    media = isObject(doc) && isObject(doc.media) ? doc.media : {};
    if (num(media.duration) > 0) { endCs = floorCs(num(media.duration) + num(media.offset)); }
    for (i = 0; i < cuts.length; i++) {
      if (endCs !== null && cuts[i][0] >= endCs) { break; }
      if (cuts[i][0] > cur) { out += p + ',' + fmtCs(cur) + ',' + fmtCs(cuts[i][0] - cur) + '\n'; }
      if (cuts[i][1] > cur) { cur = cuts[i][1]; }
    }
    if (endCs === null || cur < endCs) { out += p + ',' + fmtCs(cur) + '\n'; }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* offset, merge                                                       */
  /* ------------------------------------------------------------------ */

  /*
   * applyOffset(doc, seconds[, opts]) -> new doc with media.offset SET to
   * `seconds` (absolute, not added), an offsetChanged history entry and a
   * new modified time. Range times are not touched.
   */
  function applyOffset(doc, seconds, opts) {
    var out, prev, now = nowIso(opts);
    if (!isNumber(seconds)) { throw new TypeError('offset must be a finite number'); }
    out = clone(doc);
    if (!isObject(out.media)) { out.media = {}; }
    prev = num(out.media.offset);
    out.media.offset = seconds;
    addHistory(out, 'offsetChanged', null, 'offset ' + fmtSeconds(prev) + ' -> ' + fmtSeconds(seconds), { now: now });
    out.modified = now;
    return out;
  }

  /* Old ranges a rescan replaces: automatic, still pending, not edited. */
  function isReplaceable(r) {
    return r.source === 'auto' && r.review === 'pending' && r.locked !== true;
  }

  /*
   * merge(oldDoc, newScanDoc[, opts]) -> new normalised doc.
   * Keeps every old range that is locked, approved, rejected, or manual /
   * panic / imported. Old auto+pending ranges are replaced by the new scan's
   * ranges, except that a new auto range is dropped when
   *  - more than 50% of its length overlaps old dismissed ranges (rejected,
   *    or action none) of the SAME category, or
   *  - it lies entirely inside old enforced kept ranges of the same category
   *    (already reviewed; avoids re-review churn).
   * New ids that collide with kept ids are re-derived. Identity (id,
   * created), title, year, offset and history come from the old doc;
   * generator, fingerprint, duration, filename and scan from the new one.
   */
  function merge(oldDoc, newScanDoc, opts) {
    var now = nowIso(opts), o = clone(oldDoc) || {}, n = clone(newScanDoc) || {};
    var out, i, k, r, kept = [], added = [], replaced = 0, dropped = 0, used = {};
    var dismissed = {}, covered = {}, newRanges, len, keys = ['title', 'year', 'offset'];
    out = {
      format: FORMAT,
      version: VERSION,
      id: o.id || n.id || uuid4(),
      created: o.created || n.created || now,
      modified: now,
      generator: n.generator || o.generator || { app: APP_NAME, appVersion: LIB_VERSION },
      media: isObject(n.media) ? n.media : (isObject(o.media) ? o.media : {})
    };
    if (isObject(o.media) && isObject(n.media)) {
      for (k = 0; k < keys.length; k++) {
        if (has(o.media, keys[k])) { out.media[keys[k]] = o.media[keys[k]]; }
      }
    }
    if (has(n, 'language')) { out.language = n.language; } else if (has(o, 'language')) { out.language = o.language; }
    out.ranges = [];
    if (has(n, 'scan')) { out.scan = n.scan; } else if (has(o, 'scan')) { out.scan = o.scan; }
    out.history = isArray(o.history) ? o.history : [];

    for (k = 0; k < CATEGORIES.length; k++) { dismissed[CATEGORIES[k]] = []; covered[CATEGORIES[k]] = []; }
    var oldRanges = isArray(o.ranges) ? o.ranges : [];
    for (i = 0; i < oldRanges.length; i++) {
      r = oldRanges[i];
      if (!isObject(r)) { continue; }
      if (isReplaceable(r)) { replaced++; continue; }
      kept.push(r);
      used[String(r.id)] = true;
      if (has(dismissed, r.category) && isNumber(r.start) && isNumber(r.end)) {
        if (isEnforced(r)) { covered[r.category].push([r.start, r.end]); } else { dismissed[r.category].push([r.start, r.end]); }
      }
    }
    for (k = 0; k < CATEGORIES.length; k++) {
      dismissed[CATEGORIES[k]] = union(dismissed[CATEGORIES[k]]);
      covered[CATEGORIES[k]] = union(covered[CATEGORIES[k]]);
    }

    newRanges = [];
    var srcNew = isArray(n.ranges) ? n.ranges : [];
    for (i = 0; i < srcNew.length; i++) {
      if (isObject(srcNew[i]) && isNumber(srcNew[i].start) && isNumber(srcNew[i].end)) { newRanges.push(srcNew[i]); }
    }
    newRanges.sort(byTime);
    for (i = 0; i < newRanges.length; i++) {
      r = newRanges[i];
      if (r.source === 'auto' && has(dismissed, r.category)) {
        len = r.end - r.start;
        if (overlapLength(r.start, r.end, dismissed[r.category]) > 0.5 * len ||
            containedIn(r.start, r.end, covered[r.category])) {
          dropped++;
          continue;
        }
      }
      if (has(used, String(r.id))) { r.id = deriveId(r.id, used); }
      used[String(r.id)] = true;
      added.push(r);
    }
    out.ranges = kept.concat(added);
    addHistory(out, 'scanned', null, 'kept ' + kept.length + ', replaced ' + replaced + ', added ' +
      added.length + ', dropped ' + dropped, { now: now });
    return normalise(out, { now: now });
  }

  /* ------------------------------------------------------------------ */
  /* constructors and parsing                                            */
  /* ------------------------------------------------------------------ */

  /*
   * newDoc(fields) -> valid empty skip file. Fills format, version, id,
   * created, modified, generator, a placeholder media block, empty ranges
   * and a "created" history entry unless the fields supply them.
   */
  function newDoc(fields, opts) {
    var f = isObject(fields) ? clone(fields) : {}, now = nowIso(opts), doc, k;
    var optional = ['language', 'scan', 'summary', 'history'];
    doc = {
      format: FORMAT,
      version: VERSION,
      id: typeof f.id === 'string' ? f.id : uuid4(),
      created: typeof f.created === 'string' ? f.created : now,
      modified: typeof f.modified === 'string' ? f.modified : (typeof f.created === 'string' ? f.created : now),
      generator: isObject(f.generator) ? f.generator : { app: APP_NAME, appVersion: LIB_VERSION },
      media: isObject(f.media) ? f.media : { title: '', duration: 0, fingerprint: { size: 0, oshash: '0000000000000000' } },
      ranges: isArray(f.ranges) ? f.ranges : []
    };
    for (k = 0; k < optional.length; k++) {
      if (has(f, optional[k])) { doc[optional[k]] = f[optional[k]]; }
    }
    if (!isArray(doc.history)) { doc.history = [{ at: doc.created, event: 'created' }]; }
    return doc;
  }

  /*
   * newRange(fields) -> range with defaults (manual "other" skip mark,
   * pending, confidence 1). Only schema keys are copied. id = "r" + 8
   * base36 characters unless given.
   */
  function newRange(fields) {
    var f = isObject(fields) ? fields : {}, r, k;
    var optional = ['intensity', 'locked', 'signals', 'note', 'cutStart', 'cutEnd'];
    r = {
      id: typeof f.id === 'string' ? f.id : rangeId(),
      start: has(f, 'start') ? f.start : 0,
      end: has(f, 'end') ? f.end : 0,
      category: has(f, 'category') ? f.category : 'other',
      confidence: has(f, 'confidence') ? f.confidence : 1,
      action: has(f, 'action') ? f.action : 'skip',
      source: has(f, 'source') ? f.source : 'manual',
      review: has(f, 'review') ? f.review : 'pending'
    };
    for (k = 0; k < optional.length; k++) {
      if (has(f, optional[k])) { r[optional[k]] = clone(f[optional[k]]); }
    }
    return r;
  }

  /*
   * fromJson(text) -> {ok, doc, errors}. Never throws. doc is null unless
   * the text parsed AND validated. A leading BOM is ignored.
   */
  function fromJson(text) {
    var doc, res;
    try {
      if (typeof text !== 'string') {
        return { ok: false, doc: null, errors: [{ path: '', msg: 'input must be a string' }] };
      }
      if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); }
      try {
        doc = JSON.parse(text);
      } catch (e) {
        return { ok: false, doc: null, errors: [{ path: '', msg: 'not valid JSON' }] };
      }
      res = validate(doc);
      return { ok: res.ok, doc: res.ok ? doc : null, errors: res.errors };
    } catch (e2) {
      return { ok: false, doc: null, errors: [{ path: '', msg: 'unreadable: ' + (e2 && e2.message ? e2.message : 'error') }] };
    }
  }

  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    CATEGORIES: CATEGORIES.slice(),
    ACTIONS: ACTIONS.slice(),
    SOURCES: SOURCES.slice(),
    REVIEWS: REVIEWS.slice(),
    LEVELS: LEVELS.slice(),
    HISTORY_EVENTS: HISTORY_EVENTS.slice(),
    MAX_HISTORY: MAX_HISTORY,
    validate: validate,
    normalise: normalise,
    enforced: enforced,
    isEnforced: isEnforced,
    summarise: summarise,
    merge: merge,
    applyOffset: applyOffset,
    toKodiEdl: toKodiEdl,
    toMpvEdl: toMpvEdl,
    newDoc: newDoc,
    newRange: newRange,
    fromJson: fromJson,
    addHistory: addHistory,
    uuid4: uuid4
  };
}));
