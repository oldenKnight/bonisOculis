/*
 * bonis oculis - subtitle scanner (ES5, no dependencies, no DOM, no I/O).
 *
 * Loads as a CommonJS module (node --test) and as a plain script in the
 * browser extension, where it sets BO.subscan.
 *
 *   parseSrt(text)            -> cues [{start, end, text}]
 *   parseVtt(text)            -> cues
 *   parseTtml(text)           -> cues (TTML / DFXP / YouTube srv3)
 *   parseJson3(text)          -> cues (YouTube timedtext json3)
 *   parseAuto(text[, hint])   -> {format, cues}
 *   compileLexicon(json)      -> compiled lexicon (accepts raw JSON too)
 *   score(cues, lexicon[, opts]) -> {nudity: [..], sex: [..], ...} per second
 *   rangesFromScores(perSecond, levels[, opts]) -> skip-file ranges
 *   syncOffset(pageCues, fileCues[, opts]) -> seconds (page = file + s) or null
 *
 * Scoring follows spec/lexicon/README.md (normative, shared with the Python
 * analyzer in analyzer/bonis_analyzer/signals/subtitles.py). The SRT parser
 * mirrors parse_srt() there, so both sides produce the same cues and the same
 * per-second scores for spec/fixtures/subtitles/*.srt.
 *
 * Range building (rangesFromScores) uses spec/SKIPFILE.md level thresholds:
 * merge gaps < 3 s, lead-in 2 s, tail 1 s, minimum 1.5 s; `language` keeps
 * cue timing (lead-in 0.5, tail 0.5, merge gap 1) like the analyzer's
 * CATEGORY_TIMING, because it is muted, not skipped.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = api;
  } else {
    root.BO = root.BO || {};
    root.BO.subscan = api;
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var CATEGORIES = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
  var THRESHOLDS = { off: null, light: 0.80, moderate: 0.60, strict: 0.40 };
  var INTENSITY_BANDS = [[0.85, 3], [0.65, 2], [0, 1]];
  var TIMING = {
    defaults: { leadIn: 2, tail: 1, mergeGap: 3, minDuration: 1.5 },
    language: { leadIn: 0.5, tail: 0.5, mergeGap: 1, minDuration: 1.5 }
  };
  var NOTES = {
    en: {
      nudity: 'Subtitles suggest nudity.',
      sex: 'Subtitles suggest a sexual scene.',
      implied: 'Subtitles suggest an implied intimate scene.',
      kissing: 'Subtitles suggest heavy kissing.',
      gore: 'Subtitles suggest graphic violence.',
      language: 'Subtitles contain strong language.'
    },
    es: {
      nudity: 'Los subtítulos sugieren desnudez.',
      sex: 'Los subtítulos sugieren una escena sexual.',
      implied: 'Los subtítulos sugieren una escena íntima insinuada.',
      kissing: 'Los subtítulos sugieren besos intensos.',
      gore: 'Los subtítulos sugieren violencia gráfica.',
      language: 'Los subtítulos contienen lenguaje fuerte.'
    }
  };

  var hasOwn = Object.prototype.hasOwnProperty;
  function has(o, k) { return o !== null && o !== undefined && hasOwn.call(o, k); }
  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function round3(x) { return Math.floor(x * 1000 + 0.5) / 1000; }
  function trim(s) { return String(s).replace(/^\s+|\s+$/g, ''); }

  /* ------------------------------------------------------------------ */
  /* text helpers                                                        */
  /* ------------------------------------------------------------------ */

  var ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0', lrm: '\u200e',
    rlm: '\u200f', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018',
    rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', iexcl: '\u00a1', iquest: '\u00bf',
    aacute: '\u00e1', eacute: '\u00e9', iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa',
    ntilde: '\u00f1', uuml: '\u00fc', Aacute: '\u00c1', Eacute: '\u00c9', Iacute: '\u00cd',
    Oacute: '\u00d3', Uacute: '\u00da', Ntilde: '\u00d1', Uuml: '\u00dc', shy: '\u00ad'
  };

  function fromCodePoint(n) {
    if (!(n > 0) || n > 0x10FFFF) { return '\ufffd'; }
    if (n <= 0xFFFF) { return String.fromCharCode(n); }
    n -= 0x10000;
    return String.fromCharCode(0xD800 + (n >> 10), 0xDC00 + (n & 0x3FF));
  }

  function unescapeHtml(s) {
    return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, function (m, e) {
      if (e.charAt(0) === '#') {
        return fromCodePoint(e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      }
      return has(ENTITIES, e) ? ENTITIES[e] : m;
    });
  }

  /* Same as _clean() in the analyzer: drop ASS overrides and tags, decode
     entities, \N -> newline, trim lines, drop empty lines. */
  function cleanText(lines) {
    var t = lines.join('\n'), out = [], parts, i, ln;
    t = t.replace(/\{\\[^}]*\}/g, '');
    t = t.replace(/<[^>]*>/g, '');
    t = unescapeHtml(t).split('\\N').join('\n').split('\\n').join('\n');
    parts = t.split('\n');
    for (i = 0; i < parts.length; i++) {
      ln = trim(parts[i]);
      if (ln) { out.push(ln); }
    }
    return out.join('\n');
  }

  /* Fallback accent folding when String.prototype.normalize is missing. */
  var FOLD_FALLBACK = {
    'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a', 'ç': 'c', 'è': 'e', 'é': 'e',
    'ê': 'e', 'ë': 'e', 'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o', 'ó': 'o',
    'ô': 'o', 'õ': 'o', 'ö': 'o', 'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y'
  };

  /* spec/lexicon/README.md rule 1. */
  function fold(s) {
    s = String(s).toLowerCase();
    if (typeof s.normalize === 'function') {
      s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    } else {
      s = s.replace(/[\u00e0-\u00ff]/g, function (c) { return has(FOLD_FALLBACK, c) ? FOLD_FALLBACK[c] : c; });
    }
    return trim(s.replace(/[^a-z0-9]+/g, ' '));
  }

  /* ------------------------------------------------------------------ */
  /* parsers                                                             */
  /* ------------------------------------------------------------------ */

  var T = '(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{1,2})(?:[,.:](\\d{1,3}))?';
  var RE_SRT_TIMING = new RegExp('^\\s*' + T + '\\s*-+>\\s*' + T);
  var RE_DIGITS = /^\s*\d+\s*$/;

  function secs(h, m, s, ms) {
    var frac = 0;
    if (ms) {
      while (ms.length < 3) { ms += '0'; }
      frac = parseInt(ms, 10) / 1000;
    }
    return parseInt(h || '0', 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + frac;
  }

  function normaliseNewlines(text) {
    return String(text).split('\ufeff').join('').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function byStartEnd(a, b) { return (a.start - b.start) || (a.end - b.end) || (a._i - b._i); }

  function sortCues(cues) {
    var i;
    for (i = 0; i < cues.length; i++) { cues[i]._i = i; }
    cues.sort(byStartEnd);
    for (i = 0; i < cues.length; i++) { delete cues[i]._i; }
    return cues;
  }

  function pushCue(cues, start, end, lines) {
    var body = cleanText(lines);
    if (!body || !isNum(start) || !isNum(end)) { return; }
    if (end <= start) { end = start + 1; }
    cues.push({ start: round3(start), end: round3(end), text: body });
  }

  /* json3 text is plain text, not markup: no tag stripping. */
  function trimLines(t) {
    var parts = String(t).split('\n'), out = [], i, ln;
    for (i = 0; i < parts.length; i++) {
      ln = trim(parts[i]);
      if (ln) { out.push(ln); }
    }
    return out.join('\n');
  }

  function pushPlain(cues, start, end, body) {
    if (!body || !isNum(start) || !isNum(end)) { return; }
    if (end <= start) { end = start + 1; }
    cues.push({ start: round3(start), end: round3(end), text: body });
  }

  /* Mirrors parse_srt(): BOM, CRLF/CR, missing blank lines or indices, dot or
     comma milliseconds, overlapping cues, tags stripped; sorted by start. */
  function parseSrt(text) {
    var lines, cues = [], cur = null, i, line, m, body;
    if (typeof text !== 'string') { return cues; }
    lines = normaliseNewlines(text).split('\n');
    function finish(c, beforeTiming) {
      if (!c) { return; }
      body = c.lines;
      if (beforeTiming && body.length && RE_DIGITS.test(body[body.length - 1])) { body = body.slice(0, -1); }
      pushCue(cues, c.start, c.end, body);
    }
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      m = RE_SRT_TIMING.exec(line);
      if (m) {
        finish(cur, true);
        cur = { start: secs(m[1], m[2], m[3], m[4]), end: secs(m[5], m[6], m[7], m[8]), lines: [] };
      } else if (cur && trim(line)) {
        cur.lines.push(trim(line));
      }
    }
    finish(cur, false);
    return sortCues(cues);
  }

  var RE_VTT_TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/;

  function vttTime(s) {
    var p = s.replace(',', '.').split(':'), sec, h = 0, m = 0;
    sec = parseFloat(p[p.length - 1]);
    if (p.length === 3) { h = parseInt(p[0], 10); m = parseInt(p[1], 10); } else { m = parseInt(p[0], 10); }
    return h * 3600 + m * 60 + sec;
  }

  /* WebVTT: header, NOTE / STYLE / REGION blocks, optional cue ids, cue
     settings after the timing, <v>, <c>, <i>, <ruby>, inline timestamps.
     X-TIMESTAMP-MAP (HLS segments) is reported as cues.timestampMap. */
  function parseVtt(text) {
    var cues = [], blocks, b, lines, i, j, m, start, end, payload, header, tsm, mm;
    if (typeof text !== 'string') { return cues; }
    blocks = normaliseNewlines(text).split(/\n[ \t]*\n/);
    for (b = 0; b < blocks.length; b++) {
      lines = blocks[b].split('\n');
      while (lines.length && !trim(lines[0])) { lines.shift(); }
      if (!lines.length) { continue; }
      header = trim(lines[0]);
      if (b === 0 && /^WEBVTT/.test(header)) {
        for (j = 1; j < lines.length; j++) {
          mm = /^X-TIMESTAMP-MAP=(.*)$/.exec(trim(lines[j]));
          if (mm) { tsm = mm[1]; }
        }
        /* a cue may follow the header without a blank line (malformed) */
        for (j = 1; j < lines.length; j++) { if (RE_VTT_TIMING.test(lines[j])) { break; } }
        if (j >= lines.length) { continue; }
        lines = lines.slice(j);
      }
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(trim(lines[0]))) { continue; }
      for (i = 0; i < lines.length && i < 2; i++) {
        m = RE_VTT_TIMING.exec(lines[i]);
        if (m) { break; }
      }
      if (!m) { continue; }
      start = vttTime(m[1]);
      end = vttTime(m[2]);
      payload = [];
      for (j = i + 1; j < lines.length; j++) {
        if (RE_VTT_TIMING.test(lines[j])) {
          pushCue(cues, start, end, payload);
          m = RE_VTT_TIMING.exec(lines[j]);
          start = vttTime(m[1]); end = vttTime(m[2]); payload = [];
          continue;
        }
        payload.push(lines[j]);
      }
      pushCue(cues, start, end, payload);
    }
    sortCues(cues);
    if (tsm) { cues.timestampMap = tsm; }
    return cues;
  }

  function attr(tag, name) {
    var re = new RegExp('\\s' + name.replace(/:/g, '\\:') + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')'), m = re.exec(tag);
    if (!m) { return null; }
    return m[2] !== undefined ? m[2] : m[3];
  }

  /* TTML time expressions: clock (hh:mm:ss.fff, hh:mm:ss:ff), offset
     (12.5s, 1500ms, 2h, 3m, 120f, 10000000t). */
  function ttmlTime(v, ctx) {
    var m;
    if (v === null || v === undefined) { return null; }
    v = trim(v);
    m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(v);
    if (m) { return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + (m[4] ? parseFloat('0.' + m[4]) : 0); }
    m = /^(\d+):(\d{1,2}):(\d{1,2}):(\d+(?:\.\d+)?)$/.exec(v);
    if (m) { return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseFloat(m[4]) / ctx.frameRate; }
    m = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(v);
    if (m) {
      var n = parseFloat(m[1]);
      switch (m[2]) {
        case 'h': return n * 3600;
        case 'm': return n * 60;
        case 's': return n;
        case 'ms': return n / 1000;
        case 'f': return n / ctx.frameRate;
        default: return n / ctx.tickRate;
      }
    }
    if (/^\d+(\.\d+)?$/.test(v)) { return parseFloat(v); }
    return null;
  }

  /* TTML / DFXP (Netflix, Prime Video, many players) and YouTube srv3
     (<p t="ms" d="ms">). Regex based so it runs without a DOM. Nested
     <div>/<body> begin offsets are not applied (rare in practice). */
  function parseTtml(text) {
    var cues = [], ctx = { frameRate: 30, tickRate: 10000000 }, tt, fr, frm, tr, re, m, open, inner, b, e, d, srv3 = false;
    if (typeof text !== 'string') { return cues; }
    text = normaliseNewlines(text);
    tt = /<(?:\w+:)?(tt|timedtext)\b[^>]*>/i.exec(text);
    if (tt) {
      if (/^timedtext$/i.test(tt[1])) { srv3 = true; }
      fr = attr(tt[0], 'ttp:frameRate');
      frm = attr(tt[0], 'ttp:frameRateMultiplier');
      tr = attr(tt[0], 'ttp:tickRate');
      if (fr && parseFloat(fr) > 0) {
        ctx.frameRate = parseFloat(fr);
        if (frm) {
          var mp = frm.split(/\s+/);
          if (mp.length === 2 && parseFloat(mp[1]) > 0) { ctx.frameRate = ctx.frameRate * parseFloat(mp[0]) / parseFloat(mp[1]); }
        }
      }
      if (tr && parseFloat(tr) > 0) { ctx.tickRate = parseFloat(tr); } else if (fr && parseFloat(fr) > 0) { ctx.tickRate = ctx.frameRate; }
    }
    re = /<((?:\w+:)?p)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;
    while ((m = re.exec(text)) !== null) {
      open = '<p ' + m[2] + '>';
      inner = m[4] || '';
      if (srv3 || (attr(open, 't') !== null && attr(open, 'begin') === null)) {
        b = attr(open, 't') !== null ? parseFloat(attr(open, 't')) / 1000 : null;
        d = attr(open, 'd') !== null ? parseFloat(attr(open, 'd')) / 1000 : null;
        e = (b !== null && d !== null) ? b + d : null;
      } else {
        b = ttmlTime(attr(open, 'begin'), ctx);
        e = ttmlTime(attr(open, 'end'), ctx);
        d = ttmlTime(attr(open, 'dur'), ctx);
        if (e === null && b !== null && d !== null) { e = b + d; }
      }
      if (b === null || e === null) { continue; }
      inner = inner.replace(/<(?:\w+:)?br\s*\/?>/gi, '\n');
      pushCue(cues, b, e, [inner]);
    }
    return sortCues(cues);
  }

  /* YouTube timedtext json3: {events: [{tStartMs, dDurationMs, segs: [{utf8}]}]} */
  function parseJson3(text) {
    var cues = [], doc, ev, i, j, s, segs;
    try { doc = typeof text === 'string' ? JSON.parse(text.replace(/^\ufeff/, '').replace(/^\)\]\}'\s*/, '')) : text; } catch (e) { return cues; }
    if (!doc || !isArray(doc.events)) { return cues; }
    for (i = 0; i < doc.events.length; i++) {
      ev = doc.events[i];
      if (!ev || !isArray(ev.segs) || !isNum(ev.tStartMs)) { continue; }
      segs = ev.segs;
      s = '';
      for (j = 0; j < segs.length; j++) { if (segs[j] && typeof segs[j].utf8 === 'string') { s += segs[j].utf8; } }
      s = trimLines(s);
      if (!s) { continue; }
      pushPlain(cues, ev.tStartMs / 1000, (ev.tStartMs + (isNum(ev.dDurationMs) ? ev.dDurationMs : 0)) / 1000, s);
    }
    return sortCues(cues);
  }

  /* Sniffs the format. hint: 'srt' | 'vtt' | 'ttml' | 'json3' | file name | url. */
  function parseAuto(text, hint) {
    var t, h = String(hint || '').toLowerCase(), cues;
    if (typeof text !== 'string') { return { format: null, cues: [] }; }
    t = trim(normaliseNewlines(text).slice(0, 2048));
    if (/^WEBVTT/.test(t) || h === 'vtt' || /\.vtt(\?|$)/.test(h)) { return { format: 'vtt', cues: parseVtt(text) }; }
    if (/^[\[{)]/.test(t) && /"events"/.test(text.slice(0, 4096))) { return { format: 'json3', cues: parseJson3(text) }; }
    if (/^</.test(t) && /<(\w+:)?(tt|timedtext)\b/i.test(text.slice(0, 8192))) { return { format: 'ttml', cues: parseTtml(text) }; }
    cues = parseSrt(text);
    if (cues.length) { return { format: 'srt', cues: cues }; }
    cues = parseVtt('WEBVTT\n\n' + text);
    return { format: cues.length ? 'vtt' : null, cues: cues };
  }

  /* ------------------------------------------------------------------ */
  /* lexicon and scoring (spec/lexicon/README.md)                        */
  /* ------------------------------------------------------------------ */

  function compileLexicon(data) {
    var lex = { language: '', ignore: [], sdh: [], keywords: [], profanity: [], compiled: true }, i, e, t;
    if (!data) { return lex; }
    if (data.compiled === true) { return data; }
    lex.language = data.language || '';
    lex.ignore = isArray(data.ignore) ? data.ignore.slice() : [];
    for (i = 0; data.sdh && i < data.sdh.length; i++) {
      e = data.sdh[i];
      lex.sdh.push({ needle: fold(e.pattern), category: e.category, weight: +e.weight });
    }
    for (i = 0; data.keywords && i < data.keywords.length; i++) {
      e = data.keywords[i];
      t = fold(e.term);
      lex.keywords.push({ needle: e.stem ? ' ' + t : ' ' + t + ' ', category: e.category, weight: +e.weight });
    }
    for (i = 0; data.profanity && i < data.profanity.length; i++) {
      e = data.profanity[i];
      lex.profanity.push({ needle: ' ' + fold(e.term) + ' ', category: 'language', weight: +e.weight });
    }
    return lex;
  }

  function cueText(text, lex) {
    var lines = String(text).split('\n'), out = [], i, j, skip;
    for (i = 0; i < lines.length; i++) {
      skip = false;
      for (j = 0; j < lex.ignore.length; j++) {
        if (lines[i].indexOf(lex.ignore[j]) >= 0) { skip = true; break; }
      }
      if (!skip) { out.push(lines[i]); }
    }
    return out.join('\n');
  }

  /* Per-category noisy-OR score of one cue's text: {category: score}. */
  function scoreText(text, lexicon) {
    var lex = compileLexicon(lexicon), t = cueText(text, lex), segments = [], dialogue, m, re, keep = {}, out = {}, k, i, j, e;
    var matched = [];
    re = /\[([^\]]*)\]|\(([^)]*)\)/g;
    while ((m = re.exec(t)) !== null) { segments.push(fold(m[1] !== undefined ? m[1] : (m[2] || ''))); }
    dialogue = ' ' + fold(t.replace(/\[([^\]]*)\]|\(([^)]*)\)/g, ' ')) + ' ';
    for (i = 0; i < lex.sdh.length; i++) {
      e = lex.sdh[i];
      if (!e.needle) { continue; }
      for (j = 0; j < segments.length; j++) {
        if (segments[j].indexOf(e.needle) >= 0) { matched.push(e); break; }
      }
    }
    for (i = 0; i < lex.keywords.length; i++) {
      e = lex.keywords[i];
      if (trim(e.needle) && dialogue.indexOf(e.needle) >= 0) { matched.push(e); }
    }
    for (i = 0; i < lex.profanity.length; i++) {
      e = lex.profanity[i];
      if (trim(e.needle) && dialogue.indexOf(e.needle) >= 0) { matched.push(e); }
    }
    for (i = 0; i < matched.length; i++) {
      k = matched[i].category;
      keep[k] = (has(keep, k) ? keep[k] : 1) * (1 - matched[i].weight);
    }
    for (k in keep) { if (has(keep, k)) { out[k] = 1 - keep[k]; } }
    return out;
  }

  function secondsCount(duration) {
    return Math.max(1, Math.ceil(Math.max(0, duration) - 1e-9));
  }

  /*
   * score(cues, lexicon[, opts]) -> {nudity: [], sex: [], implied: [],
   * kissing: [], gore: [], language: []}; index i covers [i, i + 1).
   * opts.duration (seconds) fixes the array length, else the latest cue end.
   * opts.round: round every value with floor(x * 1000 + 0.5) / 1000.
   */
  function score(cues, lexicon, opts) {
    var o = opts || {}, lex = compileLexicon(lexicon), duration = o.duration, n, out = {}, i, c, sc, a, b, k, s;
    cues = isArray(cues) ? cues : [];
    if (!isNum(duration) || duration <= 0) {
      duration = 0;
      for (i = 0; i < cues.length; i++) { if (cues[i].end > duration) { duration = cues[i].end; } }
    }
    n = secondsCount(duration);
    for (i = 0; i < CATEGORIES.length; i++) {
      out[CATEGORIES[i]] = [];
      for (s = 0; s < n; s++) { out[CATEGORIES[i]].push(0); }
    }
    for (i = 0; i < cues.length; i++) {
      c = cues[i];
      sc = scoreText(c.text, lex);
      a = Math.floor(c.start);
      b = Math.max(a, Math.ceil(c.end) - 1);
      a = Math.min(a, n - 1);
      b = Math.min(b, n - 1);
      if (a < 0) { a = 0; }
      for (k in sc) {
        if (!has(sc, k) || !has(out, k) || !(sc[k] > 0)) { continue; }
        for (s = a; s <= b; s++) { if (sc[k] > out[k][s]) { out[k][s] = sc[k]; } }
      }
    }
    if (o.round) {
      for (k in out) { if (has(out, k)) { for (s = 0; s < out[k].length; s++) { out[k][s] = round3(out[k][s]); } } }
    }
    return out;
  }

  /* Element-wise max of several per-second results (e.g. two tracks). */
  function maxScores(list) {
    var out = {}, i, k, s, src;
    for (i = 0; i < list.length; i++) {
      src = list[i];
      for (k in src) {
        if (!has(src, k) || !isArray(src[k])) { continue; }
        if (!has(out, k)) { out[k] = []; }
        for (s = 0; s < src[k].length; s++) {
          if (s >= out[k].length) { out[k].push(0); }
          if (src[k][s] > out[k][s]) { out[k][s] = src[k][s]; }
        }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* language                                                            */
  /* ------------------------------------------------------------------ */

  function langFamily(tag) {
    var t = String(tag || '').replace(/^\s+|\s+$/g, '').toLowerCase().replace(/_/g, '-'), head = t.split('-')[0].split('.')[0];
    if (['es', 'spa', 'esp', 'spanish', 'espanol', 'espa\u00f1ol', 'castellano', 'latino', 'lat'].indexOf(head) >= 0) { return 'es'; }
    if (['en', 'eng', 'english', 'ingles', 'ingl\u00e9s'].indexOf(head) >= 0) { return 'en'; }
    return '';
  }

  var FUNC = {
    en: ['the', 'you', 'and', 'to', 'is', 'what', 'that', 'it', 'i', 'of', 'this', 'are', 'don'],
    es: ['que', 'de', 'no', 'el', 'la', 'es', 'y', 'en', 'lo', 'por', 'los', 'se', 'una', 'pero']
  };

  /* Same as guess_language() in the analyzer. */
  function guessLanguage(cues, prefer) {
    var en = 0, es = 0, i, w, words, lim = Math.min(cues ? cues.length : 0, 400);
    for (i = 0; i < lim; i++) {
      words = fold(cues[i].text).split(' ');
      for (w = 0; w < words.length; w++) {
        if (FUNC.en.indexOf(words[w]) >= 0) { en++; }
        if (FUNC.es.indexOf(words[w]) >= 0) { es++; }
      }
    }
    if (en === es) { return langFamily(prefer) || 'en'; }
    return en > es ? 'en' : 'es';
  }

  /* ------------------------------------------------------------------ */
  /* ranges                                                              */
  /* ------------------------------------------------------------------ */

  function pad(n, w) { var s = String(n); while (s.length < w) { s = '0' + s; } return s; }

  function intensityOf(peak) {
    var i;
    for (i = 0; i < INTENSITY_BANDS.length; i++) { if (peak >= INTENSITY_BANDS[i][0]) { return INTENSITY_BANDS[i][1]; } }
    return 1;
  }

  /*
   * rangesFromScores(perSecond, levels[, opts]) -> ranges, valid skip-file
   * range objects sorted by start: {id, start, end, category, confidence,
   * intensity, action, source: 'auto', review: 'pending', signals:
   * {subtitles}, note}.
   *   levels: {category: 'off'|'light'|'moderate'|'strict'}; missing = off.
   *   opts.duration   clamp ends (default: array length)
   *   opts.offset     seconds added to every range (other edition)
   *   opts.lang       'en' | 'es' notes (default en)
   *   opts.idPrefix   default 'rsub'
   *   opts.actions    {category: action} overrides (default skip, language mute)
   *   opts.timing     {category|defaults: {leadIn, tail, mergeGap, minDuration}}
   */
  function rangesFromScores(perSecond, levels, opts) {
    var o = opts || {}, out = [], ci, cat, level, thr, arr, runs, s, cur, i, r, t, duration, offset, start, end, peak, merged, padded, notes;
    levels = levels || {};
    offset = isNum(o.offset) ? o.offset : 0;
    notes = NOTES[o.lang === 'es' || langFamily(o.lang) === 'es' ? 'es' : 'en'];
    for (ci = 0; ci < CATEGORIES.length; ci++) {
      cat = CATEGORIES[ci];
      level = has(levels, cat) ? levels[cat] : 'off';
      thr = has(THRESHOLDS, level) ? THRESHOLDS[level] : null;
      arr = perSecond && isArray(perSecond[cat]) ? perSecond[cat] : null;
      if (thr === null || !arr) { continue; }
      t = timingFor(cat, o.timing);
      duration = isNum(o.duration) && o.duration > 0 ? o.duration : arr.length;
      runs = [];
      cur = null;
      for (s = 0; s < arr.length; s++) {
        if (arr[s] >= thr - 1e-9) {
          if (cur && s === cur.end) { cur.end = s + 1; if (arr[s] > cur.peak) { cur.peak = arr[s]; } } else {
            cur = { start: s, end: s + 1, peak: arr[s] };
            runs.push(cur);
          }
        }
      }
      merged = [];
      for (i = 0; i < runs.length; i++) {
        r = runs[i];
        if (merged.length && r.start - merged[merged.length - 1].end < t.mergeGap) {
          cur = merged[merged.length - 1];
          cur.end = r.end;
          if (r.peak > cur.peak) { cur.peak = r.peak; }
        } else {
          merged.push({ start: r.start, end: r.end, peak: r.peak });
        }
      }
      padded = [];
      for (i = 0; i < merged.length; i++) {
        r = merged[i];
        start = Math.max(0, r.start - t.leadIn);
        end = Math.min(duration, r.end + t.tail);
        if (end - start < t.minDuration) {
          end = Math.min(duration, start + t.minDuration);
          start = Math.max(0, Math.min(start, end - t.minDuration));
        }
        if (padded.length && start < padded[padded.length - 1].end) {
          padded[padded.length - 1].end = Math.max(padded[padded.length - 1].end, end);
          padded[padded.length - 1].peak = Math.max(padded[padded.length - 1].peak, r.peak);
        } else {
          padded.push({ start: start, end: end, peak: r.peak });
        }
      }
      for (i = 0; i < padded.length; i++) {
        start = padded[i].start;
        end = padded[i].end;
        peak = round3(Math.min(1, padded[i].peak));
        out.push({
          start: round3(Math.max(0, start + offset)),
          end: round3(Math.max(0, end + offset)),
          category: cat,
          confidence: peak,
          intensity: intensityOf(peak),
          action: o.actions && has(o.actions, cat) ? o.actions[cat] : (cat === 'language' ? 'mute' : 'skip'),
          source: 'auto',
          review: 'pending',
          signals: { subtitles: peak },
          note: notes[cat]
        });
      }
    }
    out = out.filter(function (x) { return x.end > x.start; });
    out.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end) || (CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)); });
    for (i = 0; i < out.length; i++) {
      out[i].intensity = intensityOf(out[i].confidence);
      out[i].signals.subtitles = out[i].confidence;
      out[i] = withId(out[i], (o.idPrefix || 'rsub') + pad(i + 1, 4));
    }
    return out;
  }

  function withId(r, id) {
    return {
      id: id, start: r.start, end: r.end, category: r.category, confidence: r.confidence,
      intensity: r.intensity, action: r.action, source: r.source, review: r.review,
      signals: r.signals, note: r.note
    };
  }

  function timingFor(cat, custom) {
    var base = has(TIMING, cat) ? TIMING[cat] : TIMING.defaults, t = {}, k, src;
    for (k in TIMING.defaults) { if (has(TIMING.defaults, k)) { t[k] = has(base, k) ? base[k] : TIMING.defaults[k]; } }
    src = custom && (has(custom, cat) ? custom[cat] : custom.defaults);
    if (src) { for (k in src) { if (has(t, k) && isNum(src[k])) { t[k] = src[k]; } } }
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* sync                                                                */
  /* ------------------------------------------------------------------ */

  /*
   * syncDetail(pageCues, fileCues[, opts]) -> {offset, matches, compared}
   * with offset null when confidence is low. Matching: the first opts.n
   * (default 40) page captions whose folded text has >= opts.minChars (8)
   * characters are looked up among ALL file captions (exact folded text, or
   * containment when both are >= 12 chars). Every match gives a delta
   * page.start - file.start; the largest cluster of deltas within
   * +-opts.tolerance (0.75 s) wins when it holds at least opts.minMatches (3)
   * distinct page captions and at least half of the matched ones. The offset
   * is the cluster median rounded to 0.01 s: pageTime = fileTime + offset.
   */
  function syncDetail(pageCues, fileCues, opts) {
    var o = opts || {}, n = o.n || 40, minChars = o.minChars || 8, tol = isNum(o.tolerance) ? o.tolerance : 0.75;
    var minMatches = o.minMatches || 3, page = [], files = [], i, j, f, p, deltas = [], matchedPages = {}, nMatched = 0;
    var best = null, lo, hi, members, cnt, distinct, med, k;
    pageCues = isArray(pageCues) ? pageCues : [];
    fileCues = isArray(fileCues) ? fileCues : [];
    for (i = 0; i < pageCues.length && page.length < n; i++) {
      p = fold(pageCues[i].text);
      if (p.length >= minChars) { page.push({ t: p, start: pageCues[i].start, i: page.length }); }
    }
    for (j = 0; j < fileCues.length; j++) {
      f = fold(fileCues[j].text);
      if (f.length >= minChars) { files.push({ t: f, start: fileCues[j].start }); }
    }
    for (i = 0; i < page.length; i++) {
      for (j = 0; j < files.length; j++) {
        if (page[i].t === files[j].t || (page[i].t.length >= 12 && files[j].t.length >= 12 &&
            (page[i].t.indexOf(files[j].t) >= 0 || files[j].t.indexOf(page[i].t) >= 0))) {
          deltas.push({ d: page[i].start - files[j].start, page: page[i].i });
          if (!has(matchedPages, page[i].i)) { matchedPages[page[i].i] = true; nMatched++; }
        }
      }
    }
    deltas.sort(function (a, b) { return a.d - b.d; });
    lo = 0;
    for (hi = 0; hi < deltas.length; hi++) {
      while (deltas[hi].d - deltas[lo].d > 2 * tol) { lo++; }
      members = deltas.slice(lo, hi + 1);
      distinct = {};
      cnt = 0;
      for (k = 0; k < members.length; k++) {
        if (!has(distinct, members[k].page)) { distinct[members[k].page] = true; cnt++; }
      }
      if (!best || cnt > best.cnt || (cnt === best.cnt && members.length > best.members.length)) {
        best = { cnt: cnt, members: members };
      }
    }
    if (!best || best.cnt < minMatches || best.cnt * 2 < nMatched) {
      return { offset: null, matches: best ? best.cnt : 0, compared: page.length };
    }
    members = best.members;
    k = Math.floor(members.length / 2);
    med = members.length % 2 ? members[k].d : (members[k - 1].d + members[k].d) / 2;
    return { offset: Math.round(med * 100) / 100, matches: best.cnt, compared: page.length };
  }

  function syncOffset(pageCues, fileCues, opts) {
    return syncDetail(pageCues, fileCues, opts).offset;
  }

  /* Shift cue times by `seconds` (dropping cues that end before 0). */
  function shiftCues(cues, seconds) {
    var out = [], i, c;
    for (i = 0; i < cues.length; i++) {
      c = cues[i];
      if (c.end + seconds <= 0) { continue; }
      out.push({ start: round3(Math.max(0, c.start + seconds)), end: round3(c.end + seconds), text: c.text });
    }
    return out;
  }

  return {
    CATEGORIES: CATEGORIES.slice(),
    THRESHOLDS: THRESHOLDS,
    fold: fold,
    cleanText: cleanText,
    parseSrt: parseSrt,
    parseVtt: parseVtt,
    parseTtml: parseTtml,
    parseJson3: parseJson3,
    parseAuto: parseAuto,
    compileLexicon: compileLexicon,
    scoreText: scoreText,
    score: score,
    maxScores: maxScores,
    langFamily: langFamily,
    guessLanguage: guessLanguage,
    rangesFromScores: rangesFromScores,
    syncOffset: syncOffset,
    syncDetail: syncDetail,
    shiftCues: shiftCues,
    round3: round3
  };
}));
