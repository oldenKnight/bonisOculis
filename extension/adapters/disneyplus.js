/*
 * bonis oculis - Disney+ adapter.
 * Subtitles: segmented WebVTT (HLS); the player fetches small pieces a little
 * ahead of playback, so scenes are found shortly before they play (rolling),
 * not for the whole title up front. The <video> may live in a shadow root.
 * DRM: always. Seek: video.currentTime, best effort; cover + mute otherwise.
 */
(function (root) {
  'use strict';
  var BO = root.BO;
  var adapter = BO.adapters.create({
    id: 'disneyplus',
    nameKey: 'siteDisneyplus',
    seekMode: 'best-effort',
    rolling: true,
    matches: function (url) { return /^https:\/\/(www\.)?disneyplus\.com\//i.test(String(url)); },
    videoIdFromUrl: function (url) {
      var m = /\/(?:video|play)\/([A-Za-z0-9-]{6,64})/.exec(String(url));
      return m ? m[1] : '';
    },
    isDrm: function () { return true; }
  });
  BO.adapters.register(adapter);
}(typeof self !== 'undefined' ? self : this));
