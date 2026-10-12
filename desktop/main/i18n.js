'use strict';
// Main-process strings (menu, dialogs, toasts sent to the renderer). Flat keys in
// desktop/locales/<lang>.json with {placeholders}; the renderer gets the same dictionary.

var fs = require('fs');
var path = require('path');

var LANGS = ['es-MX', 'en-US'];
var FALLBACK = 'en-US';

function pickLang(osLocale) {
  return /^es/i.test(String(osLocale || '')) ? 'es-MX' : 'en-US';
}

function format(str, params) {
  if (!params) { return str; }
  return String(str).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
  });
}

function createI18n(dir, lang) {
  var dicts = {};
  var current = LANGS.indexOf(lang) >= 0 ? lang : FALLBACK;

  function load(l) {
    if (!dicts[l]) {
      try { dicts[l] = JSON.parse(fs.readFileSync(path.join(dir, l + '.json'), 'utf8')); } catch (e) { dicts[l] = {}; }
    }
    return dicts[l];
  }

  function t(key, params) {
    var d = load(current);
    var s = Object.prototype.hasOwnProperty.call(d, key) ? d[key] : load(FALLBACK)[key];
    if (typeof s !== 'string') { return key; }
    return format(s, params);
  }

  return {
    t: t,
    lang: function () { return current; },
    setLang: function (l) { if (LANGS.indexOf(l) >= 0) { current = l; } return current; },
    dict: function (l) { return load(LANGS.indexOf(l) >= 0 ? l : current); },
    short: function () { return current.slice(0, 2); }
  };
}

module.exports = { createI18n: createI18n, pickLang: pickLang, format: format, LANGS: LANGS };
