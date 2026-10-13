'use strict';
// App settings: defaults, validation of every key a renderer may set, persistence through the
// HMAC envelope in store.js (settings.json).

var os = require('os');

var FILE = 'settings.json';
var CATS = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
var LEVELS = ['off', 'light', 'moderate', 'strict'];
var PRESETS = {
  'little-kids': { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'strict' },
  teens: { nudity: 'moderate', sex: 'moderate', implied: 'light', kissing: 'light', gore: 'moderate', language: 'off' }
};

function cpuThreads() {
  var n = 2;
  try { n = os.cpus().length || 2; } catch (e) { /* default */ }
  return n;
}

function defaults(lang) {
  return {
    version: 1,
    lang: lang || 'en-US',
    setupDone: false,
    preset: 'little-kids',
    levels: copy(PRESETS['little-kids']),
    skipScenes: true,
    nonSkipAction: 'hide',
    panicKey: 'p',
    lockOnStart: true,
    scanOnlyPluggedIn: true,
    pauseWhilePlaying: true,
    threads: Math.max(1, Math.floor(cpuThreads() / 2)),
    reduceMotion: false,
    thorough: false,
    listenSpeech: true,
    autoLockMinutes: 10,
    analyzerCommand: null,
    windowBounds: null,
    integrity: null
  };
}

function copy(v) { return JSON.parse(JSON.stringify(v)); }

function validLevels(v) {
  var i;
  if (!v || typeof v !== 'object') { return false; }
  for (i = 0; i < CATS.length; i++) { if (LEVELS.indexOf(v[CATS[i]]) < 0) { return false; } }
  return true;
}

// Each validator returns the cleaned value or undefined (rejected).
var RULES = {
  lang: function (v) { return v === 'es-MX' || v === 'en-US' ? v : undefined; },
  setupDone: function (v) { return typeof v === 'boolean' ? v : undefined; },
  preset: function (v) { return v === 'little-kids' || v === 'teens' || v === 'custom' ? v : undefined; },
  levels: function (v) { return validLevels(v) ? copy(v) : undefined; },
  skipScenes: function (v) { return typeof v === 'boolean' ? v : undefined; },
  nonSkipAction: function (v) { return v === 'hide' || v === 'blur' ? v : undefined; },
  panicKey: function (v) { return typeof v === 'string' && /^[a-z]$/.test(v) && 'iou'.indexOf(v) < 0 ? v : undefined; },
  lockOnStart: function (v) { return typeof v === 'boolean' ? v : undefined; },
  scanOnlyPluggedIn: function (v) { return typeof v === 'boolean' ? v : undefined; },
  pauseWhilePlaying: function (v) { return typeof v === 'boolean' ? v : undefined; },
  threads: function (v) { return typeof v === 'number' && v >= 1 && v <= 64 && Math.floor(v) === v ? v : undefined; },
  reduceMotion: function (v) { return typeof v === 'boolean' ? v : undefined; },
  thorough: function (v) { return typeof v === 'boolean' ? v : undefined; },
  listenSpeech: function (v) { return typeof v === 'boolean' ? v : undefined; },
  autoLockMinutes: function (v) { return [0, 5, 10, 30].indexOf(v) >= 0 ? v : undefined; },
  analyzerCommand: function (v) {
    if (v === null) { return null; }
    if (v && typeof v.cmd === 'string' && (!v.args || Array.isArray(v.args))) {
      return { cmd: v.cmd, args: (v.args || []).map(String), cwd: typeof v.cwd === 'string' ? v.cwd : null };
    }
    return undefined;
  },
  // Main-only: the result of the bundled-files check (integrity.js).
  integrity: function (v) {
    if (v === null) { return null; }
    if (!v || typeof v !== 'object' || typeof v.version !== 'string') { return undefined; }
    var list = Array.isArray(v.damaged) ? v.damaged.slice(0, 50).filter(function (d) { return d && typeof d.file === 'string'; })
      .map(function (d) { return { file: d.file.slice(0, 300), reason: String(d.reason || '').slice(0, 40) }; }) : [];
    return { version: v.version.slice(0, 40), at: typeof v.at === 'string' ? v.at.slice(0, 40) : null, checked: typeof v.checked === 'number' ? v.checked : 0,
      missing: typeof v.missing === 'number' ? v.missing : 0, damaged: list };
  },
  windowBounds: function (v) {
    if (v === null) { return null; }
    if (v && ['x', 'y', 'width', 'height'].every(function (k) { return typeof v[k] === 'number' && isFinite(v[k]); })) {
      return { x: v.x, y: v.y, width: v.width, height: v.height, maximized: !!v.maximized };
    }
    return undefined;
  }
};

// Keys the renderer may change through settings:set (analyzerCommand, windowBounds and integrity are main-only).
var RENDERER_KEYS = ['lang', 'setupDone', 'preset', 'levels', 'skipScenes', 'nonSkipAction', 'panicKey',
  'lockOnStart', 'scanOnlyPluggedIn', 'pauseWhilePlaying', 'threads', 'reduceMotion', 'thorough', 'listenSpeech', 'autoLockMinutes'];

function createSettings(options) {
  var o = options || {};
  var store = o.store;
  var data = null;
  var listeners = [];

  function load(osLang) {
    var d = defaults(osLang);
    var stored = store.readEnvelope(FILE);
    var k, v;
    if (stored && typeof stored === 'object') {
      for (k in RULES) {
        if (Object.prototype.hasOwnProperty.call(RULES, k) && Object.prototype.hasOwnProperty.call(stored, k)) {
          v = RULES[k](stored[k]);
          if (v !== undefined) { d[k] = v; }
        }
      }
    }
    data = d;
    return copy(data);
  }

  function get() { return copy(data); }

  function value(k) { return data[k]; }

  // patch from main (any key) or renderer (fromRenderer = true). Returns {ok, error?, data}.
  function set(patch, fromRenderer) {
    var k, v, changed = [];
    if (!patch || typeof patch !== 'object') { return { ok: false, error: 'badPayload' }; }
    for (k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) { continue; }
      if (!RULES[k] || (fromRenderer && RENDERER_KEYS.indexOf(k) < 0)) { return { ok: false, error: 'unknownSetting' }; }
      v = RULES[k](patch[k]);
      if (v === undefined) { return { ok: false, error: 'badValue' }; }
    }
    for (k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        v = RULES[k](patch[k]);
        if (JSON.stringify(data[k]) !== JSON.stringify(v)) { data[k] = v; changed.push(k); }
      }
    }
    if (patch.preset && PRESETS[patch.preset] && !patch.levels) {
      data.levels = copy(PRESETS[patch.preset]);
      if (changed.indexOf('levels') < 0) { changed.push('levels'); }
    }
    if (changed.length) {
      store.writeEnvelope(FILE, data);
      listeners.forEach(function (fn) { try { fn(changed, get()); } catch (e) { /* listener */ } });
    }
    return { ok: true, data: get(), changed: changed };
  }

  function onChange(fn) { listeners.push(fn); }

  return { load: load, get: get, value: value, set: set, onChange: onChange };
}

module.exports = { createSettings: createSettings, defaults: defaults, PRESETS: PRESETS, CATS: CATS, LEVELS: LEVELS, RENDERER_KEYS: RENDERER_KEYS };
