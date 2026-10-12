/*
 * bonis oculis extension - storage layout (BO.store). ES5, callbacks only.
 *
 * Everything lives in chrome.storage.local, inside this browser profile.
 *   settings                          {levels, lang}
 *   video|<site>|<videoId>            {levels?, offset, skipOffset, subFile?: {name, text}, panic: [{start, end, at}]}
 *   skip|<site>|<videoId>|<oshash>    {doc, name, importedAt}  (imported .bonis.json)
 * <site> is the adapter id (youtube, netflix, primevideo, disneyplus) or the
 * host name for the generic adapter; <oshash> is the desktop file's
 * fingerprint from the skip file, so two editions of a movie never collide.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  var CATEGORIES = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
  var LEVELS = ['off', 'light', 'moderate', 'strict'];
  var DEFAULT_LEVELS = { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'off' };
  var PRESETS = {
    little: { nudity: 'strict', sex: 'strict', implied: 'strict', kissing: 'strict', gore: 'strict', language: 'strict' },
    teens: { nudity: 'moderate', sex: 'moderate', implied: 'light', kissing: 'light', gore: 'moderate', language: 'off' }
  };
  var MAX_PANIC = 200;

  function local() { return chrome.storage.local; }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function done(cb) { return typeof cb === 'function' ? cb : function () {}; }

  function cleanLevels(levels) {
    var out = {}, i, c;
    for (i = 0; i < CATEGORIES.length; i++) {
      c = CATEGORIES[i];
      out[c] = levels && LEVELS.indexOf(levels[c]) >= 0 ? levels[c] : DEFAULT_LEVELS[c];
    }
    return out;
  }

  function videoKey(site, id) { return 'video|' + site + '|' + id; }
  function skipPrefix(site, id) { return 'skip|' + site + '|' + id + '|'; }
  function skipKey(site, id, fp) { return skipPrefix(site, id) + fp; }

  function getSettings(cb) {
    local().get('settings', function (r) {
      var s = (r && r.settings) || {};
      done(cb)({ levels: cleanLevels(s.levels), lang: s.lang === 'en' || s.lang === 'es' ? s.lang : 'auto' });
    });
  }

  function setSettings(patch, cb) {
    getSettings(function (s) {
      var k;
      for (k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) { s[k] = patch[k]; } }
      s.levels = cleanLevels(s.levels);
      local().set({ settings: s }, function () { done(cb)(s); });
    });
  }

  function getVideo(site, id, cb) {
    var key = videoKey(site, id);
    local().get(key, function (r) {
      var v = (r && r[key]) || {};
      if (typeof v.offset !== 'number' || !isFinite(v.offset)) { v.offset = 0; }
      if (typeof v.skipOffset !== 'number' || !isFinite(v.skipOffset)) { v.skipOffset = 0; }
      if (Object.prototype.toString.call(v.panic) !== '[object Array]') { v.panic = []; }
      done(cb)(v);
    });
  }

  /* patch: shallow merge; a key set to null is removed. */
  function setVideo(site, id, patch, cb) {
    getVideo(site, id, function (v) {
      var k, o = {};
      for (k in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) { continue; }
        if (patch[k] === null) { delete v[k]; } else { v[k] = patch[k]; }
      }
      if (v.panic.length > MAX_PANIC) { v.panic = v.panic.slice(v.panic.length - MAX_PANIC); }
      v.updated = new Date().toISOString();
      o[videoKey(site, id)] = v;
      local().set(o, function () { done(cb)(v); });
    });
  }

  function addPanic(site, id, range, cb) {
    getVideo(site, id, function (v) {
      var list = v.panic.slice();
      list.push(range);
      setVideo(site, id, { panic: list }, cb);
    });
  }

  /* -> [{key, doc, name, importedAt}] newest first */
  function getSkipFiles(site, id, cb) {
    var prefix = skipPrefix(site, id);
    local().get(null, function (all) {
      var out = [], k;
      for (k in all) {
        if (Object.prototype.hasOwnProperty.call(all, k) && k.indexOf(prefix) === 0 && all[k] && all[k].doc) {
          out.push({ key: k, doc: all[k].doc, name: all[k].name || '', importedAt: all[k].importedAt || '' });
        }
      }
      out.sort(function (a, b) { return a.importedAt < b.importedAt ? 1 : (a.importedAt > b.importedAt ? -1 : 0); });
      done(cb)(out);
    });
  }

  function putSkipFile(site, id, doc, name, cb) {
    var fp = doc && doc.media && doc.media.fingerprint && doc.media.fingerprint.oshash ? doc.media.fingerprint.oshash : 'nofingerprint';
    var key = skipKey(site, id, fp), o = {};
    o[key] = { doc: doc, name: String(name || ''), importedAt: new Date().toISOString() };
    local().set(o, function () { done(cb)(key); });
  }

  function remove(key, cb) { local().remove(key, function () { done(cb)(); }); }

  function forgetAll(cb) { local().clear(function () { done(cb)(); }); }

  BO.store = {
    CATEGORIES: CATEGORIES,
    LEVELS: LEVELS,
    DEFAULT_LEVELS: copy(DEFAULT_LEVELS),
    PRESETS: copy(PRESETS),
    cleanLevels: cleanLevels,
    videoKey: videoKey,
    skipKey: skipKey,
    getSettings: getSettings,
    setSettings: setSettings,
    getVideo: getVideo,
    setVideo: setVideo,
    addPanic: addPanic,
    getSkipFiles: getSkipFiles,
    putSkipFile: putSkipFile,
    remove: remove,
    forgetAll: forgetAll
  };
}(typeof self !== 'undefined' ? self : this));
