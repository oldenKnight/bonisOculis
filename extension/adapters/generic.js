/*
 * bonis oculis - generic adapter: any page with an HTML5 <video>.
 * Subtitles: <track> elements (TextTrack API) and WebVTT/TTML the page
 * fetches (hook). Seek: video.currentTime. Video id: hash of the page
 * address and the video source address (blob: sources use the page only).
 */
(function (root) {
  'use strict';
  var BO = root.BO;
  var adapter = BO.adapters.create({
    id: 'generic',
    nameKey: 'siteGeneric',
    seekMode: 'reliable',
    readTextTracks: true,
    matches: function (url) { return /^(https?|file):/i.test(String(url)); },
    videoIdFromUrl: function (url) {
      var u = String(url).split('#')[0];
      return 'g' + BO.util.hash(u);
    },
    getVideoId: function () {
      var src = adapter.video && adapter.video.currentSrc ? adapter.video.currentSrc : '';
      if (/^(blob|data|mediasource):/i.test(src)) { src = ''; }
      return adapter.videoIdFromUrl(location.origin + location.pathname + location.search + '|' + src.split('#')[0]);
    }
  });
  BO.adapters.register(adapter);
}(typeof self !== 'undefined' ? self : this));
