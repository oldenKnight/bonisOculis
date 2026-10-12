/*
 * bonis oculis - options page: default levels, websites, shortcut, privacy,
 * forget everything. ES5, callbacks only.
 */
(function () {
  'use strict';
  var BO = window.BO;
  var t = BO.i18n.t;
  var $ = function (id) { return document.getElementById(id); };
  var settings = null;
  var keys = '';

  function renderLevels() {
    BO.ui.buildLevels($('levels'), settings.levels, function (lv) {
      BO.store.setSettings({ levels: lv }, function (s) { settings = s; BO.ui.toast(t('saved')); });
    }, 'ov');
  }

  function renderSites() {
    chrome.permissions.contains({ origins: ['<all_urls>'] }, function (on) {
      $('sitesStatus').textContent = on ? t('sitesAllOn') : t('sitesAllOff');
      $('sitesOn').hidden = on;
      $('sitesOff').hidden = !on;
    });
  }

  function renderShortcut() {
    $('shortcutText').textContent = keys ? t('shortcutHelp', [keys]) : t('shortcutNotSet');
  }

  function render() {
    BO.i18n.applyDom(document);
    document.title = t('optionsTitle');
    BO.ui.langToggle(document.querySelector('.bo-ohead'), settings.lang, function (lang) {
      BO.store.setSettings({ lang: lang }, function (s) {
        settings = s;
        BO.i18n.load(lang, render);
      });
    });
    renderLevels();
    renderSites();
    renderShortcut();
  }

  function preset(name) {
    BO.store.setSettings({ levels: BO.store.PRESETS[name] }, function (s) { settings = s; renderLevels(); BO.ui.toast(t('saved')); });
  }

  function wire() {
    $('presetLittle').addEventListener('click', function () { preset('little'); });
    $('presetTeens').addEventListener('click', function () { preset('teens'); });
    $('sitesOn').addEventListener('click', function () {
      chrome.permissions.request({ origins: ['<all_urls>'] }, function () {
        chrome.runtime.sendMessage({ t: 'syncGeneric' }, function () { renderSites(); });
      });
    });
    $('sitesOff').addEventListener('click', function () {
      chrome.permissions.remove({ origins: ['<all_urls>'] }, function () {
        chrome.runtime.sendMessage({ t: 'syncGeneric' }, function () { renderSites(); });
      });
    });
    $('openShortcuts').addEventListener('click', function () { chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });
    $('forget').addEventListener('click', function () { $('forgetConfirm').hidden = false; $('forgetNo').focus(); });
    $('forgetNo').addEventListener('click', function () { $('forgetConfirm').hidden = true; $('forget').focus(); });
    $('forgetYes').addEventListener('click', function () {
      BO.store.forgetAll(function () {
        $('forgetConfirm').hidden = true;
        BO.store.getSettings(function (s) { settings = s; BO.i18n.load(s.lang, render); BO.ui.toast(t('forgetAllDone')); });
      });
    });
  }

  wire();
  BO.store.getSettings(function (s) {
    settings = s;
    chrome.commands.getAll(function (list) {
      (list || []).forEach(function (c) { if (c.name === 'panic') { keys = c.shortcut || ''; } });
      BO.i18n.load(s.lang, render);
    });
  });
}());
