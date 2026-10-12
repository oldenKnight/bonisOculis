/*
 * bonis oculis - toolbar popup. ES5, callbacks only.
 *
 * Talks to the content script of the current tab (chrome.tabs.sendMessage).
 * Opened as popup.html?tab=<id> it runs as a small window for one tab: file
 * inputs are shown inline there, because Chrome may close a toolbar popup
 * while a file chooser is open.
 */
(function () {
  'use strict';
  var BO = window.BO;
  var t = BO.i18n.t;
  var $ = function (id) { return document.getElementById(id); };
  var params = parseQuery(location.search);
  var windowMode = !!params.tab;
  var tab = null;
  var last = null;
  var settings = null;
  var keys = '';
  var MAX_FILE = 5 * 1024 * 1024;

  function parseQuery(q) {
    var out = {};
    String(q || '').replace(/^\?/, '').split('&').forEach(function (p) {
      var kv = p.split('=');
      if (kv[0]) { out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); }
    });
    return out;
  }

  function send(msg, cb) {
    if (!tab) { cb(null); return; }
    chrome.tabs.sendMessage(tab.id, msg, function (res) {
      var err = chrome.runtime.lastError;
      cb(err ? null : res);
    });
  }

  function resolveTab(cb) {
    if (windowMode) {
      chrome.tabs.get(+params.tab, function (tb) { void chrome.runtime.lastError; cb(tb || null); });
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { cb(tabs && tabs[0] ? tabs[0] : null); });
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                           */
  /* ------------------------------------------------------------------ */

  function showMessage(text, actions) {
    $('ready').hidden = true;
    $('msg').hidden = false;
    $('msgText').textContent = text;
    $('msgActions').hidden = !actions;
  }

  function sourceText(s) {
    var parts = [];
    if (s.pageTracks) { parts.push(t('sourcePage')); }
    if (s.subFile) { parts.push(t('sourceFile', [s.subFile])); }
    s.skipFiles.forEach(function (f) { parts.push(t('sourceSkip', [f.title || f.name])); });
    if (s.marks) { parts.push(t('sourceMarks', [s.marks])); }
    return parts.length ? parts.join(' · ') : t('sourceNone');
  }

  function render(s) {
    var anySource, noTrackKey;
    last = s;
    $('msg').hidden = true;
    $('ready').hidden = false;
    $('siteName').textContent = t(s.nameKey);
    anySource = s.pageTracks || s.subFile || s.skipFiles.length || s.marks;
    if (!anySource) {
      $('scenesLine').textContent = t('scenesWaiting');
    } else if (s.scenes === 0) {
      $('scenesLine').textContent = t('scenesNone');
    } else {
      $('scenesLine').textContent = s.scenes === 1 ? t('scenesOne') : t('scenesMany', [s.scenes]);
    }
    $('mutesLine').hidden = !s.mutes;
    $('mutesLine').textContent = s.mutes === 1 ? t('muteOne') : t('muteMany', [s.mutes]);
    BO.ui.chips($('catChips'), s.byCategory);
    $('sourceText').textContent = sourceText(s);

    noTrackKey = s.adapter === 'youtube' ? 'noTrackYoutube' : (s.adapter === 'generic' ? 'noTrackGeneric' : 'noTrackStreaming');
    $('noTrack').hidden = !!(s.pageTracks || s.subFile);
    $('noTrackText').textContent = t(noTrackKey);
    $('readCaptions').hidden = !s.canRequestSubs;
    $('drmNote').hidden = !(s.drm || s.seekMode === 'best-effort');
    $('rollingNote').hidden = !s.rolling;
    $('adNote').hidden = !s.ad;

    $('panicLabel').textContent = s.panic ? t('panicRestore') : t('panicButton');
    $('panicBtn').setAttribute('aria-pressed', s.panic ? 'true' : 'false');
    $('panicHint').textContent = keys ? t('panicHelp', [keys]) : '';
    $('panicHint').hidden = !keys;

    BO.ui.buildLevels($('levels'), s.levels, function (lv) {
      send({ t: 'setLevels', levels: lv }, function (res) { if (res && res.ok) { render(res); } });
    }, 'pv');
    $('resetLevels').hidden = !s.customLevels;
    $('levelsSkipNote').hidden = !s.skipFiles.length;

    renderFiles(s);
    renderTiming(s);
  }

  /* One timing row per external source: the subtitle file (with automatic
     matching against the page's own captions) and the skip files. */
  function timingRow(which, label, value, withSync) {
    var box = BO.ui.el('div', 'bo-stack'), row = BO.ui.el('div', 'bo-offset'), minus, plus, out, sync;
    box.appendChild(BO.ui.el('p', 'bo-offset__label', label));
    minus = BO.ui.el('button', 'bo-button bo-button--secondary bo-button--sm', t('timingEarlier'));
    plus = BO.ui.el('button', 'bo-button bo-button--secondary bo-button--sm', t('timingLater'));
    out = BO.ui.el('output', 'bo-offset__value', t('timingValue', [BO.ui.fmtOffset(value)]));
    minus.type = plus.type = 'button';
    minus.id = 'offMinus-' + which;
    plus.id = 'offPlus-' + which;
    out.id = 'offValue-' + which;
    out.setAttribute('aria-live', 'polite');
    minus.addEventListener('click', function () { setOffset(which, value - 0.5); });
    plus.addEventListener('click', function () { setOffset(which, value + 0.5); });
    row.appendChild(minus);
    row.appendChild(out);
    row.appendChild(plus);
    box.appendChild(row);
    if (withSync) {
      sync = BO.ui.el('button', 'bo-button bo-button--ghost bo-button--sm bo-button--block');
      sync.type = 'button';
      sync.id = 'autoSync';
      sync.appendChild(BO.ui.icon('clock'));
      sync.appendChild(BO.ui.el('span', null, t('autoSync')));
      sync.addEventListener('click', autoSync);
      box.appendChild(sync);
    }
    return box;
  }

  function renderTiming(s) {
    var rows = $('timingRows');
    BO.ui.clear(rows);
    if (s.subFile) { rows.appendChild(timingRow('sub', t('timingSubLabel'), s.offset, true)); }
    if (s.skipFiles.length) { rows.appendChild(timingRow('skip', t('timingSkipLabel'), s.skipOffset, false)); }
    $('timingNone').hidden = !!rows.firstChild;
  }

  function sceneCount(n) { return n === 1 ? t('sceneCountOne') : t('sceneCountMany', [n]); }

  function autoSync() {
    send({ t: 'autoSync' }, function (res) {
      if (!res || res.ok === false) { BO.ui.toast(t(res && res.error ? res.error : 'autoSyncFail'), true); return; }
      render(res);
      BO.ui.toast(t('autoSyncOk', [BO.ui.fmtOffset(res.synced)]));
    });
  }

  function fileRow(name, onRemove) {
    var li = BO.ui.el('li'), b = BO.ui.el('button', 'bo-button bo-button--ghost bo-button--sm');
    li.appendChild(BO.ui.el('span', null, name));
    b.type = 'button';
    b.appendChild(BO.ui.icon('trash'));
    b.appendChild(BO.ui.el('span', null, t('remove')));
    b.addEventListener('click', onRemove);
    li.appendChild(b);
    return li;
  }

  function renderFiles(s) {
    var subList = $('subList'), skipList = $('skipList');
    BO.ui.clear(subList);
    BO.ui.clear(skipList);
    if (s.subFile) {
      subList.appendChild(fileRow(s.subFile, function () { send({ t: 'removeSubFile' }, after('removed')); }));
    }
    s.skipFiles.forEach(function (f) {
      skipList.appendChild(fileRow((f.title || f.name) + ' · ' + t('scenesMany', [f.count]), function () {
        send({ t: 'removeSkip', key: f.key }, after('removed'));
      }));
    });
    subList.hidden = !subList.firstChild;
    skipList.hidden = !skipList.firstChild;
    $('subLabel').hidden = !windowMode;
    $('skipLabel').hidden = !windowMode;
    $('subWindow').hidden = windowMode;
    $('skipWindow').hidden = windowMode;
    $('fileWindowNote').hidden = windowMode;
  }

  function after(okKey) {
    return function (res) {
      if (!res || res.ok === false) { BO.ui.toast(t(res && res.error ? res.error : 'somethingWrong'), true); return; }
      render(res);
      if (okKey) { BO.ui.toast(t(okKey)); }
    };
  }

  function refresh() {
    if (!tab || !/^(https?|file):/i.test(tab.url || tab.pendingUrl || 'https:')) {
      showMessage(t('unsupportedPage'), false);
      return;
    }
    send({ t: 'getState' }, function (s) {
      if (!s) { showMessage(t('notSetUp'), true); return; }
      if (!s.hasVideo) { showMessage(t('noVideo'), false); return; }
      render(s);
    });
  }

  /* ------------------------------------------------------------------ */
  /* actions                                                             */
  /* ------------------------------------------------------------------ */

  function readFile(input, cb) {
    var f = input.files && input.files[0], r;
    if (!f) { return; }
    if (f.size > MAX_FILE) { BO.ui.toast(t('fileTooBig'), true); input.value = ''; return; }
    r = new FileReader();
    r.onload = function () { cb(f.name, String(r.result || '')); input.value = ''; };
    r.onerror = function () { BO.ui.toast(t('subFileEmpty'), true); input.value = ''; };
    r.readAsText(f);
  }

  function onSubFile() {
    readFile($('subInput'), function (name, text) {
      send({ t: 'useSubFile', name: name, text: text }, function (res) {
        if (!res || res.ok === false) { BO.ui.toast(t(res && res.error ? res.error : 'somethingWrong'), true); return; }
        render(res);
        BO.ui.toast(res.added === 1 ? t('subFileOkOne') : t('subFileOk', [res.added]));
      });
    });
  }

  function onSkipFile() {
    readFile($('skipInput'), function (name, text) {
      var parsed = BO.skipfile.fromJson(text);
      if (!parsed.ok) { BO.ui.toast(t('skipFileInvalid'), true); return; }
      send({ t: 'importSkip', doc: parsed.doc, name: name }, function (res) {
        if (!res || res.ok === false) { BO.ui.toast(t(res && res.error ? res.error : 'somethingWrong'), true); return; }
        render(res);
        BO.ui.toast(res.added === 1 ? t('skipFileOkOne') : t('skipFileOk', [res.added]));
      });
    });
  }

  function openFileWindow() {
    chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html?tab=' + tab.id), type: 'popup', width: 440, height: 720 });
    window.close();
  }

  function setOffset(which, v) {
    send({ t: 'setOffset', which: which, seconds: v }, function (res) { if (res && res.ok) { render(res); } });
  }

  function protectTab() {
    chrome.runtime.sendMessage({ t: 'contentFiles' }, function (files) {
      if (!files) { BO.ui.toast(t('somethingWrong'), true); return; }
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [files.hook], world: 'MAIN' }, function () {
        if (chrome.runtime.lastError) { BO.ui.toast(t('somethingWrong'), true); return; }
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: files.files }, function () {
          if (chrome.runtime.lastError) { BO.ui.toast(t('somethingWrong'), true); return; }
          setTimeout(refresh, 1500);
        });
      });
    });
  }

  function allowAll() {
    chrome.permissions.request({ origins: ['<all_urls>'] }, function (granted) {
      if (!granted) { return; }
      chrome.runtime.sendMessage({ t: 'syncGeneric' }, function () { BO.ui.toast(t('reloadToStart')); });
    });
  }

  function wire() {
    $('panicBtn').addEventListener('click', function () { send({ t: 'panic' }, function (res) { if (res) { render(res); } }); });
    $('readCaptions').addEventListener('click', function () { send({ t: 'requestSubtitles' }, function () { setTimeout(refresh, 2000); }); });
    $('resetLevels').addEventListener('click', function () { send({ t: 'setLevels', levels: null }, function (res) { if (res && res.ok) { render(res); } }); });
    $('subInput').addEventListener('change', onSubFile);
    $('skipInput').addEventListener('change', onSkipFile);
    $('subWindow').addEventListener('click', openFileWindow);
    $('skipWindow').addEventListener('click', openFileWindow);
    $('protectTab').addEventListener('click', protectTab);
    $('allowAll').addEventListener('click', allowAll);
    $('openOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
  }

  function applyLanguage() {
    BO.i18n.applyDom(document);
    BO.ui.langToggle(document.querySelector('.bo-head'), settings.lang, function (lang) {
      BO.store.setSettings({ lang: lang }, function (s) {
        settings = s;
        BO.i18n.load(lang, function () { applyLanguage(); if (last) { render(last); } else { refresh(); } });
      });
    });
  }

  function start() {
    if (windowMode) { document.body.classList.add('is-window'); $('filesBox').open = true; }
    wire();
    BO.store.getSettings(function (s) {
      settings = s;
      BO.i18n.load(s.lang, function () {
        applyLanguage();
        chrome.commands.getAll(function (list) {
          (list || []).forEach(function (c) { if (c.name === 'panic') { keys = c.shortcut || ''; } });
          resolveTab(function (tb) { tab = tb; refresh(); });
        });
      });
    });
  }

  start();
}());
