/*
 * bonis oculis extension - strings (BO.i18n). ES5.
 *
 * Every string lives in _locales/<lang>/messages.json. By default Chrome
 * picks the language (chrome.i18n.getMessage). The language toggle (en /
 * es-MX) loads the other messages.json from the extension's own package
 * (chrome-extension://, never the network) and formats it the same way.
 * Used by the popup, the options page and the service worker.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  var table = null;
  var current = 'auto';
  var DIRS = { en: 'en', es: 'es_MX' };

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  /* chrome.i18n semantics: $NAME$ -> placeholders.name.content, $1..$9 -> subs, $$ -> $. */
  function format(entry, subs) {
    var msg = String(entry.message || ''), ph = entry.placeholders || {};
    msg = msg.replace(/\$([A-Za-z0-9_@]+)\$/g, function (m, name) {
      var k, lower = name.toLowerCase();
      for (k in ph) {
        if (Object.prototype.hasOwnProperty.call(ph, k) && k.toLowerCase() === lower) { return String(ph[k].content); }
      }
      return '';
    });
    return msg.replace(/\$(\$|[1-9])/g, function (m, d) {
      if (d === '$') { return '$'; }
      return subs && subs[+d - 1] !== undefined ? String(subs[+d - 1]) : '';
    });
  }

  function t(key, subs) {
    var m;
    if (subs !== undefined && !isArray(subs)) { subs = [subs]; }
    if (subs) { subs = subs.map(function (s) { return String(s); }); }
    if (table && table[key]) { return format(table[key], subs); }
    try { m = chrome.i18n.getMessage(key, subs); } catch (e) { m = ''; }
    return m || key;
  }

  function uiLanguage() {
    var l;
    if (current === 'es' || current === 'en') { return current; }
    try { l = chrome.i18n.getUILanguage(); } catch (e) { l = 'en'; }
    return /^es/i.test(l) ? 'es' : 'en';
  }

  /* load('auto' | 'en' | 'es', cb) */
  function load(lang, cb) {
    var done = typeof cb === 'function' ? cb : function () {};
    if (lang !== 'en' && lang !== 'es') { table = null; current = 'auto'; done(); return; }
    readJson(chrome.runtime.getURL('_locales/' + DIRS[lang] + '/messages.json'), function (err, json) {
      if (err || !json) { table = null; current = 'auto'; } else { table = json; current = lang; }
      done();
    });
  }

  /* Reads a file from the extension package. */
  function readJson(url, cb) {
    var xhr;
    if (typeof XMLHttpRequest === 'function') {
      xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) { cb(e); return; }
        cb(null, j);
      };
      xhr.onerror = function () { cb(new Error('read failed')); };
      xhr.send();
      return;
    }
    /* service worker: no XHR there, fetch is the only reader of package files */
    fetch(url).then(function (r) { return r.text(); }).then(function (text) {
      var j = null;
      try { j = JSON.parse(text); } catch (e) { cb(e); return; }
      cb(null, j);
    }, function (e) { cb(e); });
  }

  /* data-i18n="key", data-i18n-aria-label="key", data-i18n-title="key" */
  function applyDom(rootEl) {
    var r = rootEl || document, list, i, el;
    list = r.querySelectorAll('[data-i18n]');
    for (i = 0; i < list.length; i++) { el = list[i]; el.textContent = t(el.getAttribute('data-i18n')); }
    list = r.querySelectorAll('[data-i18n-aria-label]');
    for (i = 0; i < list.length; i++) { el = list[i]; el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'))); }
    list = r.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < list.length; i++) { el = list[i]; el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); }
    if (r === document && document.documentElement) {
      document.documentElement.setAttribute('lang', uiLanguage() === 'es' ? 'es-MX' : 'en-US');
    }
  }

  BO.i18n = { t: t, load: load, uiLanguage: uiLanguage, applyDom: applyDom, format: format, readJson: readJson };
}(typeof self !== 'undefined' ? self : this));
