/*
 * bonis oculis content script - orchestration (BO.content). ES5.
 *
 * 1. At document_start: start the bridge (nonce handshake with the hook).
 * 2. Ask the service worker for lexicons, strings and settings.
 * 3. Find the main <video> through the site adapter; attach the enforcer.
 * 4. Plan = ranges from the page's subtitles (subscan) + the parent's own
 *    subtitle file (shifted by the offset) + imported skip files (offset) +
 *    moments hidden with the panic key. All are enforced together (catch
 *    too much rather than too little). The subtitle file and the skip files
 *    each have their own offset (they may come from different editions).
 * 5. Report the number of planned scenes to the service worker (badge) and
 *    answer the popup.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.content) { return; }

  var adapter = BO.adapters.pick(location.href);
  if (!adapter) { return; }

  var sub = BO.subscan;
  var store = BO.store;
  var lexicons = null;
  var settings = { levels: store.DEFAULT_LEVELS, lang: 'auto' };
  var strings = null;
  var uiLang = 'en';
  var site = adapter.id === 'generic' ? location.hostname || 'file' : adapter.id;
  var videoId = '';
  var record = { offset: 0, skipOffset: 0, panic: [] };
  var skipFiles = [];
  var plan = [];
  var summary = { scenes: 0, mutes: 0, byCategory: {} };
  var video = null;
  var lastHref = location.href;
  var initTries = 0;
  var ready = false;

  BO.bridge.start();

  var overlay = BO.overlay.create(function () { return adapter.video; });
  var enforcer = BO.enforcer.create({
    adapter: adapter,
    overlay: overlay,
    onEvent: function (name) { if (name === 'blocked' || name === 'panic') { report(); } }
  });

  /* ------------------------------------------------------------------ */
  /* start-up                                                            */
  /* ------------------------------------------------------------------ */

  function init() {
    BO.util.toBackground({ t: 'init' }, function (res) {
      if (!res || !res.lexicons) {
        initTries++;
        if (initTries < 8) { setTimeout(init, 500 * initTries); }
        return;
      }
      lexicons = { en: sub.compileLexicon(res.lexicons.en), es: sub.compileLexicon(res.lexicons.es) };
      applyInit(res);
      if (!ready) {
        ready = true;
        adapter.findVideo(onVideo);
        adapter.getSubtitleTracks(debouncedRecompute);
        setInterval(watchNavigation, 1000);
      }
    });
  }

  function applyInit(res) {
    settings = res.settings || settings;
    strings = res.strings || null;
    uiLang = res.uiLang === 'es' ? 'es' : 'en';
    if (strings) { overlay.setStrings(strings); }
  }

  function onVideo(v) {
    video = v;
    if (!v) { enforcer.detach(); report(); return; }
    enforcer.attach();
    v.addEventListener('durationchange', debouncedRecompute);
    loadRecord(function () { recompute(); });
  }

  function currentVideoId() {
    return adapter.getVideoId() || 'page-' + BO.util.hash(location.origin + location.pathname);
  }

  function loadRecord(cb) {
    var id = currentVideoId();
    videoId = id;
    store.getVideo(site, id, function (v) {
      if (videoId !== id) { return; }
      record = v;
      store.getSkipFiles(site, id, function (list) {
        if (videoId !== id) { return; }
        skipFiles = list;
        if (cb) { cb(); }
      });
    });
  }

  /* Single-page sites change the title without reloading the page. */
  function watchNavigation() {
    var id;
    if (location.href === lastHref) { return; }
    lastHref = location.href;
    id = currentVideoId();
    if (id === videoId) { return; }
    BO.bridge.reset(function (t) { return id.length >= 6 && t.url.indexOf(id) >= 0; });
    plan = [];
    enforcer.setRanges([]);
    loadRecord(function () { recompute(); });
  }

  /* ------------------------------------------------------------------ */
  /* planning                                                            */
  /* ------------------------------------------------------------------ */

  function duration() {
    var d = video ? video.duration : NaN;
    return typeof d === 'number' && isFinite(d) && d > 0 ? d : undefined;
  }

  function lexFor(lang, cues) {
    var fam = sub.langFamily(lang) || sub.guessLanguage(cues, uiLang);
    return lexicons[fam === 'es' ? 'es' : 'en'];
  }

  function levels() { return store.cleanLevels(record.levels || settings.levels); }

  function pageTracks() {
    return BO.bridge.list().filter(function (t) { return adapter.acceptsTrack(t); });
  }

  function pageCues() {
    var all = [];
    pageTracks().forEach(function (t) { all = all.concat(t.cues); });
    all.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    return all;
  }

  function fileCues() {
    if (!record.subFile || typeof record.subFile.text !== 'string') { return []; }
    return sub.parseAuto(record.subFile.text, record.subFile.name).cues;
  }

  function rangesFromCues(cues, lang, prefix, lv) {
    if (!cues.length) { return []; }
    return sub.rangesFromScores(sub.score(cues, lexFor(lang, cues), { duration: duration() }), lv, { duration: duration(), lang: uiLang, idPrefix: prefix });
  }

  function buildPlan() {
    var lv = levels(), out = [], tracks = pageTracks(), scores = [], i, list, j, r, off = record.offset || 0, skipOff = record.skipOffset || 0, d = duration();
    if (!lexicons) { return []; }
    for (i = 0; i < tracks.length; i++) {
      scores.push(sub.score(tracks[i].cues, lexFor(tracks[i].lang, tracks[i].cues), { duration: d }));
    }
    if (scores.length) {
      out = out.concat(sub.rangesFromScores(sub.maxScores(scores), lv, { duration: d, lang: uiLang, idPrefix: 'rpage' }));
    }
    out = out.concat(rangesFromCues(sub.shiftCues(fileCues(), off), '', 'rfile', lv));
    for (i = 0; i < skipFiles.length; i++) {
      list = BO.skipfile.enforced(skipFiles[i].doc);
      for (j = 0; j < list.length; j++) {
        r = list[j];
        r.start = Math.max(0, r.start + skipOff);
        r.end = r.end + skipOff;
        r.source = r.source || 'imported';
        if (r.end > r.start) { out.push(r); }
      }
    }
    for (i = 0; i < record.panic.length; i++) {
      r = record.panic[i];
      if (r && r.end > r.start) {
        out.push({ id: 'rpanic' + i, start: r.start, end: r.end, category: 'other', confidence: 1, action: 'skip', source: 'panic', review: 'approved' });
      }
    }
    for (i = 0; i < out.length; i++) { if (out[i].action === 'blur' || out[i].action === 'hide') { out[i].action = 'hide'; } }
    out.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
    return out;
  }

  /* Overlapping ranges count as one scene; mutes inside a skipped stretch are not counted. */
  function summarise(list) {
    var visual = [], mutes = [], byCategory = {}, i, r, cur = null, scenes = 0, n = 0;
    for (i = 0; i < list.length; i++) {
      r = list[i];
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      if (r.action === 'mute') { mutes.push(r); } else { visual.push(r); }
    }
    for (i = 0; i < visual.length; i++) {
      if (!cur || visual[i].start > cur.end) { cur = { start: visual[i].start, end: visual[i].end }; scenes++; } else if (visual[i].end > cur.end) { cur.end = visual[i].end; }
    }
    cur = null;
    for (i = 0; i < mutes.length; i++) {
      if (coveredBy(mutes[i], visual)) { continue; }
      if (!cur || mutes[i].start > cur.end) { cur = { start: mutes[i].start, end: mutes[i].end }; n++; } else if (mutes[i].end > cur.end) { cur.end = mutes[i].end; }
    }
    return { scenes: scenes, mutes: n, byCategory: byCategory };
  }

  function coveredBy(r, list) {
    var i;
    for (i = 0; i < list.length; i++) { if (list[i].start <= r.start && list[i].end >= r.end) { return true; } }
    return false;
  }

  function recompute() {
    plan = buildPlan();
    summary = summarise(plan);
    enforcer.setRanges(plan);
    report();
  }

  var debouncedRecompute = BO.util.debounce(function () { if (ready && video) { recompute(); } }, 250);

  /* ------------------------------------------------------------------ */
  /* state for the popup and the badge                                   */
  /* ------------------------------------------------------------------ */

  function state() {
    var tracks = pageTracks(), es = enforcer.state();
    return {
      ok: true,
      adapter: adapter.id,
      nameKey: adapter.nameKey,
      seekMode: adapter.seekMode,
      rolling: adapter.rolling,
      hasVideo: !!video,
      videoId: videoId,
      site: site,
      drm: !!(video && adapter.isDrm()),
      ad: !!(adapter.isAdPlaying && adapter.isAdPlaying()),
      canRequestSubs: typeof adapter.requestSubtitles === 'function',
      pageTracks: tracks.length,
      pageCues: tracks.reduce(function (n, t) { return n + t.cues.length; }, 0),
      subFile: record.subFile ? record.subFile.name || 'subtitles' : null,
      skipFiles: skipFiles.map(function (f) {
        return { key: f.key, title: (f.doc.media && f.doc.media.title) || f.name || '', name: f.name, count: BO.skipfile.enforced(f.doc).length };
      }),
      marks: record.panic.length,
      levels: levels(),
      customLevels: !!record.levels,
      offset: record.offset || 0,
      skipOffset: record.skipOffset || 0,
      panic: enforcer.isPanic(),
      blocked: es.blocked,
      scenes: summary.scenes,
      mutes: summary.mutes,
      byCategory: summary.byCategory,
      ranges: plan.map(function (r) { return { id: r.id, start: r.start, end: r.end, category: r.category, action: r.action, confidence: r.confidence, source: r.source }; }),
      enforcer: es
    };
  }

  function report() {
    BO.util.toBackground({ t: 'state', count: summary.scenes + summary.mutes, panic: enforcer.isPanic(), hasVideo: !!video });
  }

  /* ------------------------------------------------------------------ */
  /* messages                                                            */
  /* ------------------------------------------------------------------ */

  function togglePanic() {
    var res = enforcer.togglePanic(), id = videoId;
    if (res.range) {
      res.range.at = new Date().toISOString();
      record.panic = record.panic.concat([res.range]);
      store.addPanic(site, id, res.range, function () { recompute(); });
    } else {
      report();
    }
    return res;
  }

  function saveRecord(patch, cb) {
    store.setVideo(site, videoId, patch, function (v) {
      record = v;
      recompute();
      if (cb) { cb(); }
    });
  }

  function handle(msg, reply) {
    var cues, res, d, check;
    switch (msg && msg.t) {
      case 'getState':
        reply(state());
        return false;
      case 'panic':
        togglePanic();
        reply(state());
        return false;
      case 'setLevels':
        saveRecord({ levels: msg.levels ? store.cleanLevels(msg.levels) : null }, function () { reply(state()); });
        return true;
      case 'useSubFile':
        cues = sub.parseAuto(String(msg.text || ''), msg.name).cues;
        if (!cues.length) { reply({ ok: false, error: 'subFileEmpty' }); return false; }
        saveRecord({ subFile: { name: String(msg.name || '').slice(0, 200), text: String(msg.text) } }, function () {
          var s = state();
          s.added = rangesFromCues(sub.shiftCues(cues, record.offset || 0), '', 'rfile', levels()).length;
          reply(s);
        });
        return true;
      case 'removeSubFile':
        saveRecord({ subFile: null }, function () { reply(state()); });
        return true;
      case 'importSkip':
        check = BO.skipfile.validate(msg.doc);
        if (!check.ok) { reply({ ok: false, error: 'skipFileInvalid' }); return false; }
        store.putSkipFile(site, videoId, msg.doc, msg.name, function () {
          loadRecord(function () {
            recompute();
            var s = state();
            s.added = BO.skipfile.enforced(msg.doc).length;
            reply(s);
          });
        });
        return true;
      case 'removeSkip':
        store.remove(String(msg.key), function () { loadRecord(function () { recompute(); reply(state()); }); });
        return true;
      case 'setOffset':
        d = Number(msg.seconds);
        if (!isFinite(d) || Math.abs(d) > 36000) { reply(state()); return false; }
        res = {};
        res[msg.which === 'skip' ? 'skipOffset' : 'offset'] = Math.round(d * 100) / 100;
        saveRecord(res, function () { reply(state()); });
        return true;
      case 'autoSync':
        cues = fileCues();
        if (!cues.length) { reply({ ok: false, error: 'autoSyncNeedFile' }); return false; }
        res = sub.syncDetail(pageCues(), cues);
        if (res.offset === null) { reply({ ok: false, error: 'autoSyncFail', matches: res.matches }); return false; }
        saveRecord({ offset: res.offset }, function () { var s = state(); s.synced = res.offset; reply(s); });
        return true;
      case 'requestSubtitles':
        reply({ ok: !!(adapter.requestSubtitles && adapter.requestSubtitles()) });
        return false;
      case 'forgetMarks':
        saveRecord({ panic: [] }, function () { reply(state()); });
        return true;
      case 'reinit':
        init();
        reply({ ok: true });
        return false;
      default:
        return false;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (sender && sender.id && sender.id !== chrome.runtime.id) { return false; }
    try {
      return handle(msg, sendResponse);
    } catch (e) {
      sendResponse({ ok: false, error: 'somethingWrong' });
      return false;
    }
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') { return; }
    if (changes.settings) {
      BO.util.toBackground({ t: 'init' }, function (res) { if (res) { applyInit(res); recompute(); } });
    }
    if (videoId && (changes[store.videoKey(site, videoId)] || Object.keys(changes).some(function (k) { return k.indexOf('skip|' + site + '|' + videoId + '|') === 0; }))) {
      loadRecord(function () { recompute(); });
    }
  });

  BO.content = { state: state, recompute: recompute };
  init();
}(typeof self !== 'undefined' ? self : this));
