/* Activity (planner decision 3; commission: audit trail). Parent only. Unlocks, wrong PINs,
   settings and level changes, plays (and "play without protection"), panic moments (kid or
   parent mode, title, time in the movie), approvals. Newest first, from userData/activity.jsonl. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var page = null;
  var ICONS = { setup: 'lock', unlock: 'unlock', pinFailed: 'alert', cooldown: 'clock', lock: 'lock', pinChanged: 'edit', pinRecovered: 'unlock',
    settings: 'settings', play: 'play', playUnprotected: 'alert', panic: 'panic', skip: 'check', letPlay: 'eye', skipAll: 'check',
    approveClean: 'shield-check', markReviewed: 'shield-check', trust: 'shield-check', movieLevels: 'settings', playerStopped: 'alert', import: 'upload', remove: 'trash', damaged: 'alert', integrity: 'alert' };
  var WARN = ['pinFailed', 'cooldown', 'playUnprotected', 'panic', 'damaged', 'integrity', 'playerStopped'];

  function fmtWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    return d.toLocaleDateString(BO.i18n.lang(), { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(BO.i18n.lang(), { hour: '2-digit', minute: '2-digit' });
  }

  var LANGS = { 'es-MX': 'Español (México)', 'en-US': 'English (US)' };

  function settingText(detail) {
    return String(detail || '').split('; ').map(function (part) {
      var m = /^levels\.(\w+) (\w+) -> (\w+)$/.exec(part);
      if (m) { return BO.t('activity.levelChange', { category: BO.t('cat.' + m[1]), from: BO.t('level.' + m[2]), to: BO.t('level.' + m[3]) }); }
      var k = /^(\w+) (.*) -> (.*)$/.exec(part);
      if (!k) { return part; }
      var label = BO.i18n.has('settings.' + k[1]) ? BO.t('settings.' + k[1]) : k[1];
      var v = k[3].replace(/^"|"$/g, '');
      // Plain words for every value (round 2, X9): language and preset names, minutes, on/off.
      if (k[1] === 'setupDone' && v === 'true') { return BO.t('activity.setupDone'); }
      if (v === 'true') { v = BO.t('common.on'); } else if (v === 'false') { v = BO.t('common.off'); } else if (LANGS[v]) { v = LANGS[v]; } else if (k[1] === 'preset' && BO.i18n.has('preset.' + v)) {
        v = BO.t('preset.' + v);
      } else if (k[1] === 'autoLockMinutes') { v = v === '0' ? BO.t('settings.autoLock.never') : BO.t('settings.autoLock.minutes', { n: v }); } else if (k[1] === 'nonSkipAction' && BO.i18n.has('action.' + v)) {
        v = BO.t('action.' + v);
      } else if (k[1] === 'panicKey') { v = v.toUpperCase(); }
      return label + ': ' + v;
    }).join(' · ');
  }

  function sentence(e) {
    var p = { title: e.title || '', seconds: e.seconds || 0, time: BO.fmt.time(e.movieTime || 0), count: e.count || 0, file: e.file || '' };
    switch (e.type) {
      case 'pinFailed': return BO.t(e.mode === 'kid' ? 'activity.pinFailed.kid' : 'activity.pinFailed.parent');
      case 'lock': return BO.t(e.reason === 'idle' ? 'activity.lock.idle' : (e.reason === 'blur' ? 'activity.lock.blur' : 'activity.lock.manual'));
      case 'play': return BO.t(e.mode === 'kid' ? 'activity.play.kid' : 'activity.play.parent', p);
      case 'panic': return BO.t(e.mode === 'kid' ? 'activity.panic.kid' : 'activity.panic.parent', p);
      case 'settings': return BO.t('activity.settings', { detail: settingText(e.detail) });
      case 'movieLevels': return BO.t(e.detail === 'usual' ? 'activity.movieLevels.usual' : 'activity.movieLevels', p);
      case 'playerStopped': return BO.t(e.mode === 'kid' ? 'activity.playerStopped.kid' : 'activity.playerStopped.parent', p);
      default: return BO.i18n.has('activity.' + e.type) ? BO.t('activity.' + e.type, p) : e.type;
    }
  }

  function render(list) {
    BO.clear(page);
    page.appendChild(BO.el('header', { 'class': 'bo-page__header' }, [BO.el('div', null, [
      BO.el('h1', { 'class': 'bo-page__title', text: BO.t('activity.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } }),
      BO.el('p', { 'class': 'bo-page__sub', text: BO.t('activity.lead') })
    ])]));
    if (!list.length) {
      page.appendChild(BO.el('div', { 'class': 'bo-empty bo-card bo-card--flat' }, [
        BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('clock')),
        BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('activity.empty') })
      ]));
      return;
    }
    var ul = BO.el('ol', { 'class': 'bo-activity', attrs: { 'aria-label': BO.t('activity.title') } });
    list.forEach(function (e) {
      ul.appendChild(BO.el('li', { 'class': 'bo-activity__row' + (WARN.indexOf(e.type) >= 0 ? ' is-warn' : ''), data: { type: e.type } }, [
        BO.el('span', { 'class': 'bo-activity__icon' }, BO.icon(ICONS[e.type] || 'info')),
        BO.el('span', { 'class': 'bo-activity__text', text: sentence(e) }),
        BO.el('time', { 'class': 'bo-activity__when', attrs: { datetime: e.at }, text: fmtWhen(e.at) })
      ]));
    });
    page.appendChild(ul);
  }

  function load() {
    BO.invoke('activity:list', {}, function (r) { render(r.ok && r.data ? r.data : []); });
  }

  BO.views.activity = {
    init: function (section) {
      page = BO.el('div', { 'class': 'bo-page bo-activity-page' });
      section.appendChild(page);
      BO.i18n.onChange(function () { if (BO.router.current() === 'activity') { load(); } });
    },
    show: function () { load(); },
    hide: function () {}
  };
}(window));
