/* bonis oculis renderer core: the BO namespace, DOM helpers, formatting, the IPC bridge. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO = window.BO || {};
  var document = window.document;

  BO.views = BO.views || {};
  BO.CATEGORIES = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language', 'other'];
  BO.LEVEL_CATEGORIES = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];

  /* el('button', {class: 'a b', text: 'x', on: {click: fn}, attrs: {'aria-label': 'y'}, vars: {'--s': '3%'}}, [children]) */
  function el(tag, opts, children) {
    var node = document.createElement(tag);
    var o = opts || {};
    var k;
    if (o['class']) { node.className = o['class']; }
    if (o.text !== undefined && o.text !== null) { node.textContent = String(o.text); }
    if (o.id) { node.id = o.id; }
    if (o.type) { node.type = o.type; }
    if (o.hidden) { node.hidden = true; }
    if (o.disabled) { node.disabled = true; }
    if (o.attrs) { for (k in o.attrs) { if (Object.prototype.hasOwnProperty.call(o.attrs, k) && o.attrs[k] !== null && o.attrs[k] !== undefined && o.attrs[k] !== false) { node.setAttribute(k, o.attrs[k] === true ? '' : String(o.attrs[k])); } } }
    if (o.data) { for (k in o.data) { if (Object.prototype.hasOwnProperty.call(o.data, k)) { node.setAttribute('data-' + k, String(o.data[k])); } } }
    if (o.vars) { for (k in o.vars) { if (Object.prototype.hasOwnProperty.call(o.vars, k)) { node.style.setProperty(k, String(o.vars[k])); } } }
    if (o.on) { for (k in o.on) { if (Object.prototype.hasOwnProperty.call(o.on, k)) { node.addEventListener(k, o.on[k]); } } }
    append(node, children);
    return node;
  }

  function append(node, children) {
    var i;
    if (children === undefined || children === null || children === false) { return node; }
    if (Object.prototype.toString.call(children) !== '[object Array]') { children = [children]; }
    for (i = 0; i < children.length; i++) {
      if (children[i] === null || children[i] === undefined || children[i] === false) { continue; }
      node.appendChild(typeof children[i] === 'string' ? document.createTextNode(children[i]) : children[i]);
    }
    return node;
  }

  var SVG = 'http://www.w3.org/2000/svg';

  function icon(name, cls) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'bo-icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', '#bo-i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } return node; }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* 1:10:02 or 15:02, optionally with tenths (1:10:02.5). */
  function fmtTime(sec, tenths) {
    var s = Math.max(0, sec || 0);
    var whole = tenths ? Math.floor(s * 10 + 0.5) / 10 : Math.floor(s + 0.5);
    var h = Math.floor(whole / 3600);
    var m = Math.floor((whole % 3600) / 60);
    var r = whole - h * 3600 - m * 60;
    var secStr = tenths ? (r < 10 ? '0' : '') + r.toFixed(1) : pad2(Math.floor(r));
    return (h ? h + ':' + pad2(m) : String(m)) + ':' + secStr;
  }

  /* "1 h 52 min" / "52 min" / "45 s" (same in both languages, DESIGN 13.7). */
  function fmtDuration(sec) {
    var s = Math.round(sec || 0);
    if (s < 60) { return s + ' s'; }
    var h = Math.floor(s / 3600);
    var m = Math.round((s % 3600) / 60);
    if (m === 60) { h += 1; m = 0; }
    return h ? h + ' h ' + m + ' min' : m + ' min';
  }

  function invoke(channel, payload, cb) {
    var done = typeof cb === 'function' ? cb : function () {};
    if (!window.bo || typeof window.bo.invoke !== 'function') { done({ ok: false, error: 'noBridge', data: null }); return; }
    window.bo.invoke(channel, payload || {}, done);
  }

  function on(event, fn) { if (window.bo && window.bo.on) { window.bo.on(event, fn); } }

  /* Gives focus to an element without scrolling the page more than needed. */
  function focus(node) {
    if (!node) { return; }
    try { node.focus({ preventScroll: false }); } catch (e) { node.focus(); }
  }

  var uid = 0;
  function nextId(prefix) { uid += 1; return (prefix || 'bo') + '-' + uid; }

  BO.el = el;
  BO.append = append;
  BO.icon = icon;
  BO.clear = clear;
  BO.qs = qs;
  BO.qsa = qsa;
  BO.debounce = debounce;
  BO.fmt = { time: fmtTime, duration: fmtDuration };
  BO.invoke = invoke;
  BO.on = on;
  BO.focus = focus;
  BO.nextId = nextId;
}(window));
