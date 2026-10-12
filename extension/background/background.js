/*
 * bonis oculis - service worker (classic script, ES5, no modules).
 *
 *   - panic key (chrome.commands 'panic', Alt+Shift+P by default): tells the
 *     active tab to black out + mute, or to restore on the second press
 *   - badge: number of planned scenes per tab
 *   - init data for content scripts: lexicons, strings, settings
 *   - generic adapter: registers the content scripts for every website only
 *     when the parent granted the optional <all_urls> permission
 *   - live listening (experimental, one tab at a time): turned on from the
 *     popup (a user gesture), gets a stream id with chrome.tabCapture, opens
 *     the offscreen document (offscreen/offscreen.html) that hears the tab and
 *     classifies it, relays its cover/release decisions to the tab's content
 *     script, and stops everything when the tab closes or the switch is off
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
              overlayHiddenHint: keys ? t('overlayHiddenHint', [keys]) : '',
              overlayLive: t('overlayLive'),
              overlayLiveHint: t('overlayLiveHint'),
              overlayListening: t('overlayListening')
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

var badgeState = {};

/* count: planned scenes; panic: hidden now; a dot and a red badge while live listening hears this tab. */
function setBadge(tabId, count, panic) {
  var listening = live.tabId === tabId && live.state === 'listening', text;
  badgeState[tabId] = { count: count || 0, panic: !!panic };
  text = panic ? '■' : (count > 0 ? String(count) : '');
  if (listening && !panic) { text = '●' + text; }
  try {
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: listening ? '#B42318' : '#0B555D' });
    if (chrome.action.setBadgeTextColor) { chrome.action.setBadgeTextColor({ tabId: tabId, color: '#FFFFFF' }); }
    chrome.action.setBadgeText({ tabId: tabId, text: text });
    chrome.action.setTitle({ tabId: tabId, title: listening ? BO.i18n.t('liveBadgeTitle') : BO.i18n.t('extName') });
  } catch (e) { /* tab closed */ }
}

function refreshBadge(tabId) {
  var b = badgeState[tabId] || { count: 0, panic: false };
  if (typeof tabId === 'number') { setBadge(tabId, b.count, b.panic); }
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
/* live listening (experimental)                                          */
/* ---------------------------------------------------------------------- */

var OFFSCREEN = 'offscreen/offscreen.html';
var live = { tabId: null, state: 'off', error: null, stats: null, test: false };
var liveLoaded = false;
var offscreenWaiting = null;

function isTestBuild() { return /BO_TEST/.test(chrome.runtime.getManifest().version_name || ''); }

/* The worker may be stopped and restarted while a tab is listened to: the
   state lives in chrome.storage.session (memory only, cleared with the browser). */
function withLive(cb) {
  if (liveLoaded) { cb(); return; }
  try {
    chrome.storage.session.get('live', function (r) {
      void chrome.runtime.lastError;
      if (!liveLoaded && r && r.live && typeof r.live.tabId === 'number') { live = r.live; }
      liveLoaded = true;
      cb();
    });
  } catch (e) { liveLoaded = true; cb(); }
}

function saveLive() {
  try { chrome.storage.session.set({ live: live }, function () { void chrome.runtime.lastError; }); } catch (e) { /* no session storage */ }
}

function hasOffscreen(cb) {
  try {
    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN)] }, function (list) {
      void chrome.runtime.lastError;
      cb(!!(list && list.length));
    });
  } catch (e) { cb(false); }
}

function ensureOffscreen(cb) {
  if (offscreenWaiting) { offscreenWaiting.push(cb); return; }
  offscreenWaiting = [cb];
  function done(ok) {
    var w = offscreenWaiting;
    offscreenWaiting = null;
    w.forEach(function (f) { f(ok); });
  }
  hasOffscreen(function (has) {
    if (has) { done(true); return; }
    chrome.offscreen.createDocument({
      url: OFFSCREEN,
      reasons: ['USER_MEDIA'],
      justification: 'Live listening: hears the sound of the one tab the parent chose, in memory, to cover a scene as it starts.'
    }, function () {
      var err = chrome.runtime.lastError;
      done(!err || /single offscreen/i.test(err.message || ''));
    });
  });
}

function closeOffscreen(cb) {
  hasOffscreen(function (has) {
    if (!has) { cb(); return; }
    chrome.offscreen.closeDocument(function () { void chrome.runtime.lastError; cb(); });
  });
}

function toOffscreen(msg, cb) {
  msg.target = 'offscreen';
  msg.testBuild = isTestBuild();
  try {
    chrome.runtime.sendMessage(msg, function (res) {
      var err = chrome.runtime.lastError;
      cb(err ? null : res);
    });
  } catch (e) { cb(null); }
}

function liveSet(next) {
  var old = live.tabId;
  live = next;
  saveLive();
  if (typeof old === 'number') { refreshBadge(old); }
  if (typeof live.tabId === 'number' && live.tabId !== old) { refreshBadge(live.tabId); }
}

/* Stops listening (and uncovers the tab). error: a message key, or null. */
function liveStop(error, cb) {
  var done = typeof cb === 'function' ? cb : function () {};
  withLive(function () {
    var tabId = live.tabId;
    toOffscreen({ t: 'offStop', reason: error || 'off' }, function (res) {
      closeOffscreen(function () {
        liveSet({ tabId: null, state: 'off', error: error || null, errorTab: tabId, stats: res && res.stats ? res.stats : live.stats, test: false });
        if (typeof tabId === 'number') {
          sendToTab(tabId, { t: 'live', cover: false, stopped: true });
          sendToTab(tabId, { t: 'liveListening', on: false });
          refreshBadge(tabId);
        }
        done({ ok: true, stats: live.stats });
      });
    });
  });
}

function liveStarted(tabId, test, res, cb) {
  if (!res || !res.ok) {
    liveStop((res && res.error) || 'liveModelFailed', function () { cb({ ok: false, error: (res && res.error) || 'liveModelFailed' }); });
    return;
  }
  liveSet({ tabId: tabId, state: 'listening', error: null, stats: null, test: !!test, since: Date.now() });
  sendToTab(tabId, { t: 'liveListening', on: true });
  cb({ ok: true, capture: res.capture, rate: res.rate, loadMs: res.loadMs });
}

/* From the popup: the user just turned the switch on for this tab. */
function liveStart(tabId, cb) {
  withLive(function () {
    function go() {
      liveSet({ tabId: tabId, state: 'starting', error: null, stats: null, test: false });
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, function (streamId) {
        var err = chrome.runtime.lastError;
        if (err || !streamId) { liveStop('liveNoCapture', function () { cb({ ok: false, error: 'liveNoCapture' }); }); return; }
        ensureOffscreen(function (ok) {
          if (!ok) { liveStop('liveModelFailed', function () { cb({ ok: false, error: 'liveModelFailed' }); }); return; }
          toOffscreen({ t: 'offStart', tabId: tabId, streamId: streamId }, function (res) { liveStarted(tabId, false, res, cb); });
        });
      });
    }
    if (live.tabId !== null && live.state !== 'off') { liveStop(null, go); } else { go(); }
  });
}

/* Test builds only: classify a local audio file (opts.url) or feed score
   windows (opts.frames) for tabId instead of capturing the tab. */
function liveTest(tabId, opts, cb) {
  if (!isTestBuild()) { cb({ ok: false, error: 'notAllowed' }); return; }
  withLive(function () {
    function go() {
      ensureOffscreen(function (ok) {
        if (!ok) { cb({ ok: false, error: 'liveModelFailed' }); return; }
        if (opts.frames) {
          toOffscreen({ t: 'offFeed', tabId: tabId, frames: opts.frames, intervalMs: opts.intervalMs }, function (res) { liveStarted(tabId, true, res, cb); });
        } else {
          toOffscreen({ t: 'offTest', tabId: tabId, url: opts.url }, function (res) { liveStarted(tabId, true, res, cb); });
        }
      });
    }
    if (live.tabId !== null && live.state !== 'off') { liveStop(null, go); } else { go(); }
  });
}

function liveState(tabId, cb) {
  withLive(function () {
    cb({
      ok: true,
      on: live.tabId === tabId && live.state !== 'off',
      state: live.tabId === tabId ? live.state : 'off',
      otherTab: live.tabId !== null && live.tabId !== tabId && live.state !== 'off',
      error: live.errorTab === tabId ? live.error : null,
      stats: live.tabId === tabId ? live.stats : null
    });
  });
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  delete badgeState[tabId];
  withLive(function () { if (live.tabId === tabId) { liveStop('liveTabGone'); } });
});

/* ---------------------------------------------------------------------- */
/* messages                                                               */
/* ---------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  var tabId = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  if (!msg || sender.id !== chrome.runtime.id || msg.target === 'offscreen') { return false; }
  switch (msg.t) {
    case 'init':
      initData(function (data) {
        withLive(function () {
          data.live = tabId !== null && live.tabId === tabId && live.state === 'listening';
          sendResponse(data);
        });
      });
      return true;
    case 'liveStart':
      liveStart(Number(msg.tabId), sendResponse);
      return true;
    case 'liveStop':
      withLive(function () {
        if (live.tabId === Number(msg.tabId) || msg.tabId === undefined) { liveStop(null, sendResponse); } else { sendResponse({ ok: true }); }
      });
      return true;
    case 'liveState':
      liveState(Number(msg.tabId), sendResponse);
      return true;
    case 'liveEvent':
      /* from the offscreen document: cover or release the tab it listens to */
      sendToTab(msg.tabId, { t: 'live', cover: !!msg.cover, category: msg.category, score: msg.score, muteElement: !!msg.muteElement });
      sendResponse({ ok: true });
      return false;
    case 'liveStatus':
      withLive(function () {
        if (live.tabId === msg.tabId) { live.stats = msg.stats; saveLive(); }
        sendResponse({ ok: true });
      });
      return true;
    case 'liveEnded':
      withLive(function () {
        if (live.tabId === msg.tabId) { liveStop(msg.reason || 'liveTabGone', sendResponse); } else { sendResponse({ ok: true }); }
      });
      return true;
    case 'state':
      withLive(function () {
        if (tabId !== null) { setBadge(tabId, msg.count || 0, !!msg.panic); }
        sendResponse({ ok: true });
      });
      return true;
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
self.BO_BG = {
  onCommand: onCommand, setBadge: setBadge, syncGenericRegistration: syncGenericRegistration, CONTENT_FILES: CONTENT_FILES,
  liveStart: liveStart, liveStop: liveStop, liveState: liveState, liveTest: liveTest, toOffscreen: toOffscreen
};
