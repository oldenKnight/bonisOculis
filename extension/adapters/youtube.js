/*
 * bonis oculis - YouTube adapter.
 * Subtitles: the player's own /api/timedtext request (json3 or srv3), seen by
 * the hook. YouTube downloads captions only when CC is on, so
 * requestSubtitles() presses the CC button once and turns it back off after
 * the track arrives. Seek: video.currentTime works. Ads play in the same
 * <video>; ranges are not applied while an ad shows.
 */
(function (root) {
  'use strict';
  var BO = root.BO;
  var turnedOn = false;

  function ccButton() { return document.querySelector('.ytp-subtitles-button'); }

  var adapter = BO.adapters.create({
    id: 'youtube',
    nameKey: 'siteYoutube',
    seekMode: 'reliable',
    videoSelector: 'video.html5-main-video',
    matches: function (url) { return /^https:\/\/(www\.|m\.)?youtube(-nocookie)?\.com\//i.test(String(url)); },
    videoIdFromUrl: function (url) {
      var u = String(url), m = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(u) || /\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})/.exec(u);
      return m ? m[1] : '';
    },
    acceptsTrack: function (t) { return /timedtext/.test(t.url) || t.source !== 'hook'; },
    isAdPlaying: function () { return !!document.querySelector('.html5-video-player.ad-showing'); },
    requestSubtitles: function () {
      var b = ccButton();
      if (b && b.getAttribute('aria-pressed') === 'false') { b.click(); turnedOn = true; return true; }
      return !!b;
    }
  });

  BO.bridge.onTrack(function (t) {
    var b;
    if (turnedOn && /timedtext/.test(t.url)) {
      turnedOn = false;
      b = ccButton();
      if (b && b.getAttribute('aria-pressed') === 'true') { b.click(); }
    }
  });

  BO.adapters.register(adapter);
}(typeof self !== 'undefined' ? self : this));
