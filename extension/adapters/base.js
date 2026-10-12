/*
 * bonis oculis - site adapters, common part (BO.adapters). ES5.
 *
 * Every adapter has the same interface:
 *   id                      'generic' | 'youtube' | 'netflix' | 'primevideo' | 'disneyplus'
 *   nameKey                 i18n key of the site name
 *   seekMode                'reliable' | 'best-effort' (DRM sites: black-out + mute is the dependable action)
 *   rolling                 true when subtitles arrive in pieces while playing (no full pre-read)
 *   matches(url)            true when this adapter handles the URL
 *   videoIdFromUrl(url)     stable id of the title, or '' (pure; tested in node)
 *   getVideoId()            id for the current page and video
 *   findVideo(cb)           cb(video) now and whenever the main <video> changes; returns stop()
 *   getSubtitleTracks(cb)   cb(track) for every captured track, now and later; returns stop()
 *   seekTo(seconds)         jump (may be ignored by the site; the enforcer verifies)
 *   currentTime()           seconds
 *   onTimeUpdate(fn)        fn() on timeupdate/seeking/seeked/play/ratechange; returns stop()
 *   isDrm()                 true when the video is protected (EME)
 *   isAdPlaying()           true while the site plays an ad in the same <video>
 *   requestSubtitles()      optional: ask the player to load captions (YouTube)
 * The adapters never read video frames or audio samples.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.adapters) { return; }

  var registry = [];
  var EVENTS = ['timeupdate', 'seeking', 'seeked', 'play', 'playing', 'pause', 'ratechange', 'loadedmetadata', 'durationchange'];

  function create(spec) {
    var a = {
      id: spec.id,
      nameKey: spec.nameKey,
      seekMode: spec.seekMode || 'reliable',
      rolling: !!spec.rolling,
      video: null,
      videoSelector: spec.videoSelector || null
    };

    a.matches = spec.matches;
    a.videoIdFromUrl = spec.videoIdFromUrl;

    a.getVideoId = spec.getVideoId || function () { return a.videoIdFromUrl(location.href); };

    a.pickVideo = spec.pickVideo || function () {
      return BO.util.biggestVideo(a.videoSelector) || (a.videoSelector ? BO.util.biggestVideo(null) : null);
    };

    a.findVideo = function (cb) {
      var stopped = false, timer;
      function look() {
        var v;
        if (stopped) { return; }
        v = a.pickVideo();
        if (v && v !== a.video && (v.isConnected !== false)) {
          a.video = v;
          cb(v);
        } else if (a.video && a.video.isConnected === false) {
          a.video = null;
          cb(null);
        }
      }
      look();
      timer = setInterval(look, 700);
      return function () { stopped = true; clearInterval(timer); };
    };

    a.currentTime = function () {
      return a.video ? a.video.currentTime || 0 : 0;
    };

    a.seekTo = spec.seekTo || function (seconds) {
      try { if (a.video) { a.video.currentTime = seconds; } } catch (e) { /* the site refused */ }
    };

    a.onTimeUpdate = function (fn) {
      var v = a.video, i;
      if (!v) { return function () {}; }
      for (i = 0; i < EVENTS.length; i++) { v.addEventListener(EVENTS[i], fn); }
      return function () { for (i = 0; i < EVENTS.length; i++) { v.removeEventListener(EVENTS[i], fn); } };
    };

    a.isDrm = spec.isDrm || function () {
      return !!(a.video && a.video.mediaKeys);
    };

    a.isAdPlaying = spec.isAdPlaying || function () { return false; };

    a.acceptsTrack = spec.acceptsTrack || function () { return true; };

    a.getSubtitleTracks = function (cb) {
      var stops = [];
      stops.push(BO.bridge.onTrack(function (t) { if (a.acceptsTrack(t)) { cb(t); } }));
      if (spec.readTextTracks) { stops.push(readTextTracks(a)); }
      return function () { var i; for (i = 0; i < stops.length; i++) { stops[i](); } };
    };

    if (spec.requestSubtitles) { a.requestSubtitles = spec.requestSubtitles; }
    return a;
  }

  /*
   * <track> elements: the browser loads the page's own track file when the
   * track is not disabled. A disabled track is switched to 'hidden' (loads,
   * shows nothing). Cues are read from the TextTrack API, so the extension
   * itself never requests anything.
   */
  function readTextTracks(a) {
    var seen = [], stopped = false, timer;
    function cueText(c) { return typeof c.text === 'string' ? c.text : ''; }
    function scan() {
      var v = a.video, list, i, tt, cues, out, j, k;
      if (stopped || !v || !v.textTracks) { return; }
      list = v.textTracks;
      for (i = 0; i < list.length; i++) {
        tt = list[i];
        if (tt.kind !== 'subtitles' && tt.kind !== 'captions') { continue; }
        if (tt.mode === 'disabled') { tt.mode = 'hidden'; }
        cues = tt.cues;
        if (!cues || !cues.length) { continue; }
        k = seen.indexOf(tt);
        if (k >= 0 && seen[k].__boCount === cues.length) { continue; }
        out = [];
        for (j = 0; j < cues.length; j++) {
          out.push({ start: BO.subscan.round3(cues[j].startTime), end: BO.subscan.round3(cues[j].endTime), text: BO.subscan.cleanText([cueText(cues[j])]) });
        }
        if (k < 0) { seen.push(tt); }
        tt.__boCount = cues.length;
        BO.bridge.addTrack({ key: 'texttrack|' + i + '|' + (tt.label || '') + '|' + (tt.language || ''), url: '', lang: tt.language || '', format: 'vtt', cues: out.filter(function (c) { return c.text && c.end > c.start; }), source: 'texttrack' });
      }
    }
    scan();
    timer = setInterval(scan, 1000);
    return function () { stopped = true; clearInterval(timer); };
  }

  function register(adapter) { registry.push(adapter); }

  /* First registered adapter that matches; generic matches everything and is registered last. */
  function pick(url) {
    var i, generic = null;
    for (i = 0; i < registry.length; i++) {
      if (registry[i].id === 'generic') { generic = registry[i]; continue; }
      if (registry[i].matches(url)) { return registry[i]; }
    }
    return generic && generic.matches(url) ? generic : null;
  }

  function urlParam(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(String(url));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  BO.adapters = { create: create, register: register, pick: pick, list: function () { return registry.slice(); }, urlParam: urlParam };
}(typeof self !== 'undefined' ? self : this));
