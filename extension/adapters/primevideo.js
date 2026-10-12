/*
 * bonis oculis - Prime Video adapter (primevideo.com and Amazon video pages).
 * Subtitles: TTML2/DFXP or WebVTT the player downloads (hook). DRM: always.
 * Seek: video.currentTime, best effort (the player may override it); the
 * enforcer covers and mutes whenever the jump does not happen. Trailers and
 * ads may play in other <video> elements; the biggest playing one is used.
 */
(function (root) {
  'use strict';
  var BO = root.BO;
  var adapter = BO.adapters.create({
    id: 'primevideo',
    nameKey: 'sitePrimevideo',
    seekMode: 'best-effort',
    videoSelector: '.webPlayerSDKContainer video, [id^="dv-web-player"] video',
    matches: function (url) {
      var u = String(url);
      return /^https:\/\/www\.primevideo\.com\//i.test(u) ||
        /^https:\/\/www\.amazon\.(com|com\.mx|es|co\.uk|ca)\/(gp\/video\/|([^?#]*\/)?dp\/)/i.test(u);
    },
    videoIdFromUrl: function (url) {
      var u = String(url), m = /\/(?:gp\/video\/)?detail\/([A-Za-z0-9.]{6,40})/.exec(u) || /\/dp\/([A-Za-z0-9]{6,20})/.exec(u);
      if (m) { return m[1]; }
      m = /[?&]gti=([^&#]+)/.exec(u);
      return m ? decodeURIComponent(m[1]) : '';
    },
    isDrm: function () { return true; }
  });
  BO.adapters.register(adapter);
}(typeof self !== 'undefined' ? self : this));
