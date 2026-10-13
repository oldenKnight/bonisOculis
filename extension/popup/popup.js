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
    if (s.live && s.live.marks) { parts.push(t('sourceLive', [s.live.marks])); }
    return parts.length ? parts.join(' · ') : t('sourceNone');
  }

  function render(s) {
    var anySource, noTrackKey;
    last = s;
    $('msg').hidden = true;
    $('ready').hidden = false;
    $('siteName').textContent = s.adapter === 'generic' ? s.site : t(s.nameKey);
    anySource = s.pageTracks || s.subFile || s.skipFiles.length || s.marks || (s.live && s.live.marks);
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
    renderMarks(s);
    renderTiming(s);
    liveRefresh();
  }

  /* Moments hidden with the panic key or covered by live listening, with a
     two-step forget (the second step says what happens). */
  function renderMarks(s) {
    var live = s.live && s.live.marks ? s.live.marks : 0, parts = [];
    if (s.marks) { parts.push(t('sourceMarks', [s.marks])); }
    if (live) { parts.push(t('sourceLive', [live])); }
    $('marksBox').hidden = !parts.length;
    $('marksCount').textContent = parts.join(' · ');
    if (!parts.length) { $('forgetMarksConfirm').hidden = true; }
  }

  function forgetMarksAsk(on) {
    $('forgetMarksConfirm').hidden = !on;
    $('forgetMarks').hidden = on;
    (on ? $('forgetMarksNo') : $('forgetMarks')).focus();
  }

  function forgetMarksDo() {
    send({ t: 'forgetMarks' }, function (res) {
      forgetMarksAsk(false);
      if (!res || res.ok === false) { BO.ui.toast(t('somethingWrong'), true); return; }
      render(res);
      BO.ui.toast(t('forgetMarksDone'));
    });
  }

  /* No shortcut means Chrome gave Alt+Shift+P to someone else: say so, offer the fix. */
  function renderShortcutWarning(hasPanicCommand) {
    $('panicNoKey').hidden = !hasPanicCommand || !!keys;
  }

  /* ------------------------------------------------------------------ */
  /* live listening                                                      */
  /* ------------------------------------------------------------------ */

  var liveTimer = null;
  var liveBusy = false;
  var LIVE_ERRORS = ['liveNoCapture', 'liveModelFailed', 'liveTabGone', 'liveNoSound'];

  function liveRender(ls) {
    var sw = $('liveSwitch'), status = $('liveStatus'), text = '', isError = false, st = ls && ls.stats;
    sw.setAttribute('aria-checked', ls && ls.on ? 'true' : 'false');
    sw.setAttribute('aria-busy', liveBusy || (ls && ls.state === 'starting') ? 'true' : 'false');
    if (!ls) {
      text = t('liveError');
      isError = true;
    } else if (ls.error) {
      text = t(LIVE_ERRORS.indexOf(ls.error) >= 0 ? ls.error : 'liveError');
      isError = true;
    } else if (ls.state === 'starting' || liveBusy) {
      text = t('liveStarting');
    } else if (ls.on) {
      text = st && st.heardAgoMs >= 0 && st.heardAgoMs < 10000 ? t('liveOn') : t('liveOnNoSound');
    } else if (ls.otherTab) {
      text = t('liveOtherTab');
    }
    status.hidden = !text;
    status.classList.toggle('is-error', isError);
    $('liveStatusText').textContent = text;
    if (ls && ls.on && liveTimer === null) {
      liveTimer = setInterval(liveRefresh, 2000);
    } else if (!(ls && ls.on) && liveTimer !== null) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  function liveRefresh() {
    if (!tab || liveBusy) { return; }
    chrome.runtime.sendMessage({ t: 'liveState', tabId: tab.id }, function (ls) {
      void chrome.runtime.lastError;
      if (!liveBusy) { liveRender(ls || null); }
    });
  }

  /* The click is the user gesture chrome.tabCapture needs. */
  function liveToggle() {
    var on = $('liveSwitch').getAttribute('aria-checked') === 'true';
    if (!tab || liveBusy) { return; }
    liveBusy = true;
    liveRender({ on: !on, state: on ? 'off' : 'starting' });
    chrome.runtime.sendMessage({ t: on ? 'liveStop' : 'liveStart', tabId: tab.id }, function (res) {
      void chrome.runtime.lastError;
      liveBusy = false;
      if (!res || res.ok === false) {
        liveRender({ on: false, state: 'off', error: res && res.error ? res.error : 'liveError' });
        return;
      }
      liveRefresh();
    });
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
    rows.hidden = !rows.firstChild;
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
    $('liveSwitch').addEventListener('click', liveToggle);
    $('openShortcuts').addEventListener('click', function () { chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });
    $('forgetMarks').addEventListener('click', function () { forgetMarksAsk(true); });
    $('forgetMarksNo').addEventListener('click', function () { forgetMarksAsk(false); });
    $('forgetMarksYes').addEventListener('click', forgetMarksDo);
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
          var has = false;
          (list || []).forEach(function (c) { if (c.name === 'panic') { has = true; keys = c.shortcut || ''; } });
          renderShortcutWarning(has);
          resolveTab(function (tb) { tab = tb; refresh(); });
        });
      });
    });
  }

  start();
}());
