/*
 * bonis oculis - service worker (classic script, ES5, no modules).
 *
 *   - panic key (chrome.commands 'panic', Alt+Shift+P by default): tells the
 *     active tab to black out + mute, or to restore on the second press
 *   - badge: number of planned scenes per tab
 *   - init data for content scripts: lexicons, strings, settings
 *   - generic adapter: registers the content scripts for every website only
 *     when the parent granted the optional <all_urls> permission
 * It makes no network request: it only reads files inside the extension.
 */
'use strict';

importScripts('../common/i18n.js', '../common/store.js');

var BO = self.BO;
var lexiconCache = null;
var GENERIC_IDS = ['bo-generic-hook', 'bo-generic'];
var CONTENT_FILES = ['shared/skipfile.js', 'shared/subscan.js', 'common/store.js', 'content/core.js', 'content/bridge.js',
  'adapters/base.js', 'adapters/generic.js', 'content/overlay.js', 'content/enforcer.js', 'content/main.js'];
var SITE_MATCHES = null;

function siteMatches() {
  var cs, i, out = [];
  if (SITE_MATCHES) { return SITE_MATCHES; }
  cs = chrome.runtime.getManifest().content_scripts || [];
  for (i = 0; i < cs.length; i++) { out = out.concat(cs[i].matches || []); }
  SITE_MATCHES = out.filter(function (m, k) { return out.indexOf(m) === k; });
  return SITE_MATCHES;
}

/* ---------------------------------------------------------------------- */
/* init data                                                              */
/* ---------------------------------------------------------------------- */

function loadLexicons(cb) {
  if (lexiconCache) { cb(lexiconCache); return; }
  BO.i18n.readJson(chrome.runtime.getURL('lexicon/en.json'), function (e1, en) {
    BO.i18n.readJson(chrome.runtime.getURL('lexicon/es.json'), function (e2, es) {
      if (en && es) { lexiconCache = { en: en, es: es }; }
      cb(lexiconCache);
    });
  });
}

function panicKeys(cb) {
  try {
    chrome.commands.getAll(function (list) {
      var i, keys = '';
      for (i = 0; list && i < list.length; i++) { if (list[i].name === 'panic') { keys = list[i].shortcut || ''; } }
      cb(keys);
    });
  } catch (e) { cb(''); }
}

function initData(cb) {
  BO.store.getSettings(function (settings) {
    BO.i18n.load(settings.lang, function () {
      loadLexicons(function (lex) {
        panicKeys(function (keys) {
          var t = BO.i18n.t;
          cb({
            settings: settings,
            lexicons: lex,
            uiLang: BO.i18n.uiLanguage(),
            strings: {
              overlaySkipped: t('overlaySkipped'),
              overlayHidden: t('overlayHidden'),
              overlayHiddenHint: keys ? t('overlayHiddenHint', [keys]) : ''
            }
          });
        });
      });
    });
  });
}

/* ---------------------------------------------------------------------- */
/* badge                                                                  */
/* ---------------------------------------------------------------------- */

function setBadge(tabId, count, panic) {
  var text = panic ? '■' : (count > 0 ? String(count) : '');
  try {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#0B555D' });
    if (chrome.action.setBadgeTextColor) { chrome.action.setBadgeTextColor({ tabId: tabId, color: '#FFFFFF' }); }
    chrome.action.setBadgeText({ tabId: tabId, text: text });
  } catch (e) { /* tab closed */ }
}

/* ---------------------------------------------------------------------- */
/* panic key                                                              */
/* ---------------------------------------------------------------------- */

function sendToTab(tabId, msg, cb) {
  try {
    chrome.tabs.sendMessage(tabId, msg, function (res) {
      var err = chrome.runtime.lastError;
      if (cb) { cb(err ? null : res); }
    });
  } catch (e) { if (cb) { cb(null); } }
}

function activeTab(cb) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
    if (tabs && tabs.length) { cb(tabs[0]); return; }
    chrome.tabs.query({ active: true }, function (all) { cb(all && all.length ? all[0] : null); });
  });
}

function onCommand(command, tab, cb) {
  var done = typeof cb === 'function' ? cb : function () {};
  if (command !== 'panic') { done(null); return; }
  function go(t) {
    if (!t || typeof t.id !== 'number') { done(null); return; }
    sendToTab(t.id, { t: 'panic' }, done);
  }
  if (tab && typeof tab.id === 'number') { go(tab); } else { activeTab(go); }
}

chrome.commands.onCommand.addListener(function (command, tab) { onCommand(command, tab); });

/* ---------------------------------------------------------------------- */
/* generic adapter registration (optional permission)                     */
/* ---------------------------------------------------------------------- */

function syncGenericRegistration(cb) {
  var done = typeof cb === 'function' ? cb : function () {};
  chrome.permissions.contains({ origins: ['<all_urls>'] }, function (granted) {
    chrome.scripting.getRegisteredContentScripts({ ids: GENERIC_IDS }, function (existing) {
      var have = existing && existing.length === GENERIC_IDS.length;
      if (granted && !have) {
        chrome.scripting.unregisterContentScripts({ ids: GENERIC_IDS }, function () {
          void chrome.runtime.lastError;
          chrome.scripting.registerContentScripts([
            { id: GENERIC_IDS[0], js: ['inject/hook.js'], matches: ['<all_urls>'], excludeMatches: siteMatches(), runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true },
            { id: GENERIC_IDS[1], js: CONTENT_FILES, matches: ['<all_urls>'], excludeMatches: siteMatches(), runAt: 'document_start', allFrames: false, persistAcrossSessions: true }
          ], function () { void chrome.runtime.lastError; done(true); });
        });
      } else if (!granted && existing && existing.length) {
        chrome.scripting.unregisterContentScripts({ ids: GENERIC_IDS }, function () { void chrome.runtime.lastError; done(false); });
      } else {
        done(!!granted);
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(function () { syncGenericRegistration(); });
chrome.runtime.onStartup.addListener(function () { syncGenericRegistration(); });
chrome.permissions.onAdded.addListener(function () { syncGenericRegistration(); });
chrome.permissions.onRemoved.addListener(function () { syncGenericRegistration(); });

/* ---------------------------------------------------------------------- */
/* messages                                                               */
/* ---------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || sender.id !== chrome.runtime.id) { return false; }
  switch (msg.t) {
    case 'init':
      initData(sendResponse);
      return true;
    case 'state':
      if (sender.tab && typeof sender.tab.id === 'number') { setBadge(sender.tab.id, msg.count || 0, !!msg.panic); }
      sendResponse({ ok: true });
      return false;
    case 'syncGeneric':
      syncGenericRegistration(function (on) { sendResponse({ ok: true, on: on }); });
      return true;
    case 'contentFiles':
      sendResponse({ hook: 'inject/hook.js', files: CONTENT_FILES });
      return false;
    default:
      return false;
  }
});

/* For tests and for the popup's panic button fallback. */
self.BO_BG = { onCommand: onCommand, setBadge: setBadge, syncGenericRegistration: syncGenericRegistration, CONTENT_FILES: CONTENT_FILES };
