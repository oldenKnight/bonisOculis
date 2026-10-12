/*
 * bonis oculis - Netflix adapter.
 * Subtitles: TTML/DFXP or WebVTT the player downloads when subtitles are on
 * (hook). DRM: always. Seek: setting video.currentTime breaks Netflix
 * playback, so it is never used; seekTo asks the player API through the hook
 * (best effort, private API). Whether or not the jump happens, the enforcer
 * covers the picture and mutes until the scene ends.
 */
(function (root) {
  'use strict';
  var BO = root.BO;
  var adapter = BO.adapters.create({
    id: 'netflix',
    nameKey: 'siteNetflix',
    seekMode: 'best-effort',
    matches: function (url) { return /^https:\/\/www\.netflix\.com\//i.test(String(url)); },
    videoIdFromUrl: function (url) {
      var m = /\/watch\/(\d+)/.exec(String(url));
      return m ? m[1] : '';
    },
    isDrm: function () { return true; },
    seekTo: function (seconds) { BO.bridge.send({ cmd: 'netflix-seek', seconds: seconds }); }
  });
  BO.adapters.register(adapter);
}(typeof self !== 'undefined' ? self : this));
