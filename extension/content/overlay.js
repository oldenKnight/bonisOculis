/*
 * bonis oculis - black-out overlay (BO.overlay). ES5.
 *
 * An opaque box over the video element's bounding box (fixed position,
 * highest z-index), with the logo mark and a short line of text. No video
 * pixel shows through and no visual filter is ever used on the video.
 * Lives in a closed shadow root so page styles cannot change it; the host's
 * own inline styles are !important. If the page puts the <video> element
 * itself in fullscreen, nothing can be drawn above it, so fullscreen is
 * exited first; a fullscreen container gets the overlay inside it.
 * Clicks pass through (pointer-events: none) so the player stays usable.
 *
 * Live listening adds a small "Listening" tag in the video's top-left corner
 * (a separate host, a few pixels tall, never over the middle of the picture)
 * for as long as the tab's sound is being listened to.
 *
 * Colours: the dark-theme tokens of desktop/renderer/css/tokens.css
 * (--bo-text #F3EFE6, --bo-primary #5BBFC8) on pure black, written here
 * because a content script cannot load the extension's CSS into the page.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.overlay) { return; }

  var MARK = 'M1 16C6 4 26 4 31 16C26 28 6 28 1 16ZM16 9.4a6.6 6.6 0 1 0 0 13.2a6.6 6.6 0 1 0 0-13.2ZM16 12.9a3.1 3.1 0 1 0 0 6.2a3.1 3.1 0 1 0 0-6.2ZM17.6 13.7a1.05 1.05 0 1 0 0 2.1a1.05 1.05 0 1 0 0-2.1Z';
  var CSS = ':host{all:initial}' +
    '.box{position:absolute;inset:0;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6em;' +
    'font-family:"Atkinson Hyperlegible Next","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;color:#F3EFE6;text-align:center;line-height:1.3;padding:1em;box-sizing:border-box;overflow:hidden}' +
    'svg{width:3em;height:3em;fill:#5BBFC8}' +
    '.title{font-weight:700;font-size:1em;margin:0}' +
    '.hint{font-size:.8em;margin:0;color:#D2CBBB;max-width:28em}';
  var TAG_CSS = ':host{all:initial}' +
    '.tag{display:inline-flex;align-items:center;gap:6px;padding:3px 8px 3px 7px;border-radius:999px;background:rgba(0,0,0,.72);color:#F3EFE6;' +
    'font:600 12px/1.2 "Atkinson Hyperlegible Next","Segoe UI",system-ui,-apple-system,Arial,sans-serif;white-space:nowrap}' +
    '.dot{width:8px;height:8px;border-radius:50%;background:#F97066;box-shadow:0 0 0 2px rgba(249,112,102,.35)}';
  var IMPORTANT = 'important';

  function create(getVideo) {
    var host = null, shadow = null, titleEl = null, hintEl = null, shown = false, kind = null;
    var strings = { overlaySkipped: 'Scene skipped', overlayHidden: 'Hidden', overlayHiddenHint: '', overlayLive: 'Covered for a moment', overlayLiveHint: '', overlayListening: 'Listening' };
    var tag = null, tagText = null, listening = false, tagTimer = null;

    function build() {
      var style, box, svg, path;
      host = document.createElement('div');
      host.id = 'bonis-oculis-overlay';
      host.setAttribute('aria-live', 'polite');
      shadow = host.attachShadow({ mode: 'closed' });
      style = document.createElement('style');
      style.textContent = CSS;
      box = document.createElement('div');
      box.className = 'box';
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 32 32');
      svg.setAttribute('aria-hidden', 'true');
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', MARK);
      svg.appendChild(path);
      titleEl = document.createElement('p');
      titleEl.className = 'title';
      hintEl = document.createElement('p');
      hintEl.className = 'hint';
      box.appendChild(svg);
      box.appendChild(titleEl);
      box.appendChild(hintEl);
      shadow.appendChild(style);
      shadow.appendChild(box);
    }

    function css(prop, value) { host.style.setProperty(prop, value, IMPORTANT); }

    function text() {
      if (kind === 'panic') {
        titleEl.textContent = strings.overlayHidden;
        hintEl.textContent = strings.overlayHiddenHint || '';
        hintEl.style.display = strings.overlayHiddenHint ? '' : 'none';
      } else if (kind === 'live') {
        titleEl.textContent = strings.overlayLive;
        hintEl.textContent = strings.overlayLiveHint || '';
        hintEl.style.display = strings.overlayLiveHint ? '' : 'none';
      } else {
        titleEl.textContent = strings.overlaySkipped;
        hintEl.textContent = '';
        hintEl.style.display = 'none';
      }
    }

    function place() {
      var v = getVideo(), fs = document.fullscreenElement || document.webkitFullscreenElement || null, parent, r, x, y, w, h, vw, vh;
      if (fs && v && fs === v) {
        try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) { /* ignore */ }
        fs = null;
      }
      parent = fs || document.documentElement || document.body;
      if (!parent) { return; }
      if (host.parentNode !== parent) { parent.appendChild(host); }
      vw = window.innerWidth || document.documentElement.clientWidth || 0;
      vh = window.innerHeight || document.documentElement.clientHeight || 0;
      r = v && v.isConnected !== false ? v.getBoundingClientRect() : null;
      if (!r || r.width < 2 || r.height < 2) {
        x = 0; y = 0; w = vw; h = vh;
      } else {
        x = Math.floor(r.left) - 1; y = Math.floor(r.top) - 1; w = Math.ceil(r.width) + 2; h = Math.ceil(r.height) + 2;
      }
      css('position', 'fixed');
      css('left', x + 'px');
      css('top', y + 'px');
      css('width', w + 'px');
      css('height', h + 'px');
      css('z-index', '2147483647');
      css('display', 'block');
      css('margin', '0');
      css('padding', '0');
      css('border', '0');
      css('background', '#000');
      css('pointer-events', 'none');
      css('opacity', '1');
      css('visibility', 'visible');
      css('transform', 'none');
      css('font-size', Math.max(13, Math.min(30, Math.round(w / 30))) + 'px');
    }

    function show(k) {
      if (!host) { build(); }
      if (k !== kind || !shown) { kind = k; text(); }
      place();
      shown = true;
      placeTag();
    }

    function hide() {
      if (!host || !shown) { return; }
      shown = false;
      kind = null;
      css('display', 'none');
      if (host.parentNode) { host.parentNode.removeChild(host); }
    }

    function setStrings(s) {
      var k;
      for (k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) { strings[k] = s[k]; } }
      if (shown) { text(); }
      if (tagText) { tagText.textContent = strings.overlayListening; }
    }

    /* ---- the "Listening" tag ---- */

    function buildTag() {
      var sh, style, box, dot;
      tag = document.createElement('div');
      tag.id = 'bonis-oculis-listening';
      tag.setAttribute('role', 'status');
      sh = tag.attachShadow({ mode: 'closed' });
      style = document.createElement('style');
      style.textContent = TAG_CSS;
      box = document.createElement('span');
      box.className = 'tag';
      dot = document.createElement('span');
      dot.className = 'dot';
      dot.setAttribute('aria-hidden', 'true');
      tagText = document.createElement('span');
      tagText.textContent = strings.overlayListening;
      box.appendChild(dot);
      box.appendChild(tagText);
      sh.appendChild(style);
      sh.appendChild(box);
    }

    function placeTag() {
      var v = getVideo(), fs = document.fullscreenElement || document.webkitFullscreenElement || null, parent, r, x = 8, y = 8;
      if (!tag || !listening) { return; }
      parent = fs && fs !== v ? fs : (document.documentElement || document.body);
      if (!parent) { return; }
      if (tag.parentNode !== parent || parent.lastChild !== tag) { parent.appendChild(tag); }
      r = v && v.isConnected !== false ? v.getBoundingClientRect() : null;
      if (r && r.width > 2 && r.height > 2) { x = Math.max(0, Math.round(r.left) + 8); y = Math.max(0, Math.round(r.top) + 8); }
      tag.style.setProperty('position', 'fixed', IMPORTANT);
      tag.style.setProperty('left', x + 'px', IMPORTANT);
      tag.style.setProperty('top', y + 'px', IMPORTANT);
      tag.style.setProperty('z-index', '2147483647', IMPORTANT);
      tag.style.setProperty('display', 'block', IMPORTANT);
      tag.style.setProperty('pointer-events', 'none', IMPORTANT);
      tag.style.setProperty('margin', '0', IMPORTANT);
      tag.style.setProperty('opacity', '1', IMPORTANT);
      tag.style.setProperty('visibility', 'visible', IMPORTANT);
    }

    function setListening(on) {
      on = !!on;
      if (on === listening) { if (on) { placeTag(); } return; }
      listening = on;
      if (on) {
        if (!tag) { buildTag(); }
        placeTag();
        tagTimer = setInterval(placeTag, 1000);
        window.addEventListener('scroll', placeTag, true);
        window.addEventListener('resize', placeTag);
        document.addEventListener('fullscreenchange', placeTag);
      } else {
        if (tagTimer !== null) { clearInterval(tagTimer); tagTimer = null; }
        window.removeEventListener('scroll', placeTag, true);
        window.removeEventListener('resize', placeTag);
        document.removeEventListener('fullscreenchange', placeTag);
        if (tag && tag.parentNode) { tag.parentNode.removeChild(tag); }
      }
    }

    return { show: show, hide: hide, setStrings: setStrings, setListening: setListening, isShown: function () { return shown; }, isListening: function () { return listening; } };
  }

  BO.overlay = { create: create };
}(typeof self !== 'undefined' ? self : this));
