/* Renderer strings: BO.i18n.t(key, params). The dictionary comes from main (app:state), flat keys
   with {placeholders}; never concatenate translated fragments (DESIGN 13.8). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var dict = {};
  var lang = 'en-US';
  var listeners = [];

  function t(key, params) {
    var s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : null;
    if (typeof s !== 'string') {
      if (window.console && console.warn) { console.warn('missing string ' + key); }
      return key;
    }
    if (!params) { return s; }
    return s.replace(/\{(\w+)\}/g, function (m, k) { return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m; });
  }

  /* Plural helper: key + '.one' when n === 1, else key + '.other'. */
  function tn(key, n, params) {
    var p = params || {};
    p.count = n;
    return t(key + (n === 1 ? '.one' : '.other'), p);
  }

  function set(newDict, newLang) {
    dict = newDict || {};
    lang = newLang || lang;
    window.document.documentElement.setAttribute('lang', lang === 'es-MX' ? 'es-MX' : 'en-US');
    listeners.forEach(function (fn) { try { fn(lang); } catch (e) { /* listener */ } });
  }

  /* Static markup: data-i18n (text), data-i18n-label (aria-label), data-i18n-title (title). */
  function apply(root) {
    BO.qsa('[data-i18n]', root).forEach(function (n) { n.textContent = t(n.getAttribute('data-i18n')); });
    BO.qsa('[data-i18n-label]', root).forEach(function (n) { n.setAttribute('aria-label', t(n.getAttribute('data-i18n-label'))); });
    BO.qsa('[data-i18n-title]', root).forEach(function (n) { n.setAttribute('title', t(n.getAttribute('data-i18n-title'))); });
  }

  function has(key) { return Object.prototype.hasOwnProperty.call(dict, key) && typeof dict[key] === 'string'; }

  BO.i18n = { t: t, tn: tn, has: has, set: set, apply: apply, lang: function () { return lang; }, onChange: function (fn) { listeners.push(fn); } };
  BO.t = t;
}(window));
