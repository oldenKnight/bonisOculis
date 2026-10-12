/* Settings (PLAN 5.5, DESIGN 8.3): Protection, Playback, Scanning, Privacy, Language, PIN, About.
   Every control saves at once (settings:set); there is no Save button. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var nav = null;
  var content = null;
  var SECTIONS = ['protection', 'playback', 'scanning', 'privacy', 'language', 'pin', 'about'];
  var pickers = {};
  var aside = null;

  /* Wide windows (DESIGN 8.3): the aside repeats the explanation of the control in use. */
  function explain(cat) {
    if (!aside) { return; }
    BO.clear(aside);
    var card;
    if (cat) {
      var lv = (s().levels || {})[cat] || 'off';
      card = BO.el('div', { 'class': 'bo-card bo-card--flat bo-cat--' + cat }, [
        BO.el('p', { 'class': 'bo-overline', text: BO.t('settings.aside.title') }),
        BO.el('h2', { 'class': 'bo-settings__aside-title' }, [BO.t('cat.' + cat) + ': ' + BO.t('level.' + lv)]),
        BO.el('p', { 'class': 'bo-body-2', text: BO.t(cat === 'language' && lv !== 'off' ? 'level.' + lv + '.descLanguage' : 'level.' + lv + '.desc') }),
        BO.el('p', { 'class': 'bo-caption', text: BO.t('settings.protection.when') })
      ]);
    } else {
      card = BO.el('div', { 'class': 'bo-card bo-card--flat' }, [
        BO.el('p', { 'class': 'bo-overline', text: BO.t('settings.aside.title') }),
        BO.el('p', { 'class': 'bo-body-2', text: BO.t('settings.aside.default') }),
        BO.el('div', { 'class': 'bo-notice' }, [BO.icon('shield-check'), BO.el('p', { text: BO.t('privacy.lead') })])
      ]);
    }
    aside.appendChild(card);
  }

  function s() { return BO.store.get('settings') || {}; }

  function save(patch, cb) {
    BO.invoke('settings:set', { patch: patch }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      BO.store.set('settings', r.data.settings);
      if (r.data.strings) { BO.i18n.set(r.data.strings, r.data.settings.lang); BO.i18n.apply(window.document); }
      if (cb) { cb(r.data.settings); }
    });
  }

  function card(key, children) {
    return BO.el('section', { 'class': 'bo-card bo-settings__card', id: 'settings-' + key, attrs: { 'aria-labelledby': 'settings-' + key + '-h' } },
      [BO.el('h2', { 'class': 'bo-settings__h', id: 'settings-' + key + '-h', text: BO.t('settings.' + key), attrs: { tabindex: '-1' } })].concat(children));
  }

  function switchRow(key, titleKey, helpKey) {
    var input = BO.el('input', { 'class': 'bo-switch__input', type: 'checkbox', id: BO.nextId('sw-' + key), data: { setting: key } });
    input.checked = !!s()[key];
    input.addEventListener('change', function () { var p = {}; p[key] = input.checked; save(p); });
    var titleId = BO.nextId('swt');
    input.setAttribute('aria-labelledby', titleId);
    return BO.el('div', { 'class': 'bo-settings-row' }, [
      BO.el('div', null, [BO.el('div', { 'class': 'bo-settings-row__title', id: titleId, text: BO.t(titleKey) }), helpKey ? BO.el('p', { 'class': 'bo-settings-row__help', text: BO.t(helpKey) }) : null]),
      BO.el('label', { 'class': 'bo-switch', attrs: { 'for': input.id } }, [input, BO.el('span', { 'class': 'bo-switch__track' }),
        BO.el('span', { 'class': 'bo-switch__label' }, BO.el('b', { 'class': 'bo-switch__state', attrs: { 'data-on': BO.t('common.on'), 'data-off': BO.t('common.off') } }))])
    ]);
  }

  function segmented(options, value, label, onPick) {
    var seg = BO.el('div', { 'class': 'bo-segmented bo-segmented--inline', attrs: { role: 'group', 'aria-label': label } });
    options.forEach(function (o) {
      var b = BO.el('button', { 'class': 'bo-segmented__opt', type: 'button', attrs: { 'aria-pressed': o.value === value ? 'true' : 'false', lang: o.lang || null }, data: { value: o.value } }, [o.icon ? BO.icon(o.icon) : null, o.label]);
      b.addEventListener('click', function () {
        BO.qsa('.bo-segmented__opt', seg).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        onPick(o.value);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  function protection() {
    var st = s();
    pickers = {};
    var presetSeg = segmented([
      { value: 'little-kids', label: BO.t('preset.little-kids') }, { value: 'teens', label: BO.t('preset.teens') }, { value: 'custom', label: BO.t('preset.custom') }
    ], st.preset, BO.t('settings.preset'), function (v) {
      save({ preset: v }, function (ns) { BO.LEVEL_CATEGORIES.forEach(function (c) { if (pickers[c]) { pickers[c].set(ns.levels[c]); } }); });
    });
    var list = BO.el('div', { 'class': 'bo-settings__levels' });
    BO.LEVEL_CATEGORIES.forEach(function (cat) {
      var p = BO.levelPicker.create({ category: cat, value: (st.levels || {})[cat], onChange: function (lv) {
        var levels = JSON.parse(JSON.stringify(s().levels || {}));
        levels[cat] = lv;
        save({ preset: 'custom', levels: levels }, function () {
          explain(cat);
          BO.qsa('.bo-segmented__opt', presetSeg).forEach(function (x) { x.setAttribute('aria-pressed', x.getAttribute('data-value') === 'custom' ? 'true' : 'false'); });
        });
      } });
      pickers[cat] = p;
      p.el.addEventListener('focusin', function () { explain(cat); });
      p.el.addEventListener('mouseenter', function () { explain(cat); });
      list.appendChild(p.el);
    });
    return card('protection', [
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('settings.protection.lead') }),
      BO.el('div', { 'class': 'bo-field' }, [BO.el('span', { 'class': 'bo-field__label', text: BO.t('settings.preset') }), presetSeg]),
      list,
      BO.el('div', { 'class': 'bo-notice' }, [BO.icon('info'), BO.el('p', { text: BO.t('settings.protection.when') })])
    ]);
  }

  function playback() {
    var st = s();
    var keySel = BO.el('select', { 'class': 'bo-input bo-select', id: BO.nextId('panic'), data: { setting: 'panicKey' } });
    'abcdefghjklmnpqrstvwxyz'.split('').forEach(function (k) {
      var o = BO.el('option', { text: k.toUpperCase(), attrs: { value: k } });
      if (k === st.panicKey) { o.selected = true; }
      keySel.appendChild(o);
    });
    var sheet = BO.el('div', { 'class': 'bo-settings__hotkeys' }, BO.hotkeys.create({ panicKey: st.panicKey }));
    keySel.addEventListener('change', function () {
      save({ panicKey: keySel.value }, function (ns) { BO.clear(sheet).appendChild(BO.hotkeys.create({ panicKey: ns.panicKey })); });
    });
    return card('playback', [
      switchRow('skipScenes', 'settings.skipScenes', 'settings.skipScenes.help'),
      BO.el('div', { 'class': 'bo-settings-row bo-settings-row--stack' }, [
        BO.el('div', null, [BO.el('div', { 'class': 'bo-settings-row__title', text: BO.t('settings.nonSkip') }), BO.el('p', { 'class': 'bo-settings-row__help', text: BO.t('settings.nonSkip.help') })]),
        segmented([{ value: 'hide', label: BO.t('action.hide'), icon: 'eye-off' }, { value: 'blur', label: BO.t('action.blur'), icon: 'eye-off' }], st.nonSkipAction, BO.t('settings.nonSkip'), function (v) { save({ nonSkipAction: v }); })
      ]),
      BO.el('div', { 'class': 'bo-settings-row' }, [
        BO.el('div', null, [BO.el('label', { 'class': 'bo-settings-row__title', attrs: { 'for': keySel.id }, text: BO.t('settings.panicKey') }), BO.el('p', { 'class': 'bo-settings-row__help', text: BO.t('settings.panicKey.help') })]),
        keySel
      ]),
      switchRow('lockOnStart', 'settings.lockOnStart', 'settings.lockOnStart.help'),
      switchRow('reduceMotion', 'settings.reduceMotion', 'settings.reduceMotion.help'),
      BO.el('h3', { 'class': 'bo-settings__sub', text: BO.t('settings.hotkeys') }),
      sheet
    ]);
  }

  function scanning() {
    var st = s();
    var cpus = Math.max(1, window.navigator.hardwareConcurrency || 4);
    var sel = BO.el('select', { 'class': 'bo-input bo-select', id: BO.nextId('threads'), data: { setting: 'threads' } });
    var i;
    for (i = 1; i <= cpus; i++) {
      var o = BO.el('option', { text: String(i), attrs: { value: String(i) } });
      if (i === st.threads) { o.selected = true; }
      sel.appendChild(o);
    }
    sel.addEventListener('change', function () { save({ threads: parseInt(sel.value, 10) }); });
    return card('scanning', [
      switchRow('scanOnlyPluggedIn', 'settings.pluggedIn', 'settings.pluggedIn.help'),
      switchRow('pauseWhilePlaying', 'settings.pauseWhilePlaying', 'settings.pauseWhilePlaying.help'),
      BO.el('div', { 'class': 'bo-settings-row' }, [
        BO.el('div', null, [BO.el('label', { 'class': 'bo-settings-row__title', attrs: { 'for': sel.id }, text: BO.t('settings.threads') }), BO.el('p', { 'class': 'bo-settings-row__help', text: BO.t('settings.threads.help') })]),
        sel
      ])
    ]);
  }

  function privacy() {
    var never = ['privacy.never.network', 'privacy.never.account', 'privacy.never.telemetry', 'privacy.never.frames', 'privacy.never.share'];
    return card('privacy', [
      BO.el('div', { 'class': 'bo-notice' }, [BO.icon('shield-check'), BO.el('p', { text: BO.t('privacy.lead') })]),
      BO.el('h3', { 'class': 'bo-settings__sub', text: BO.t('privacy.neverTitle') }),
      BO.el('ul', { 'class': 'bo-checklist' }, never.map(function (k) { return BO.el('li', null, [BO.icon('check'), BO.el('span', { text: BO.t(k) })]); })),
      BO.el('h3', { 'class': 'bo-settings__sub', text: BO.t('privacy.limitsTitle') }),
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('privacy.limits') }),
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('privacy.bypass') })
    ]);
  }

  function language() {
    return card('language', [
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('settings.language.lead') }),
      segmented([{ value: 'es-MX', label: 'Español (México)', lang: 'es-MX' }, { value: 'en-US', label: 'English (US)', lang: 'en-US' }], s().lang, BO.t('settings.language'), function (v) {
        save({ lang: v }, function () { render(); var h = BO.qs('#settings-language-h', root); if (h) { BO.focus(h); } });
      })
    ]);
  }

  function pin() {
    var change = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'change-pin' } }, [BO.icon('edit'), BO.t('settings.pin.change')]);
    change.addEventListener('click', function () { BO.pinFlows.change(); });
    var lock = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'lock-now' } }, [BO.icon('lock'), BO.t('nav.lock')]);
    lock.addEventListener('click', function () { BO.app.lock(); });
    return card('pin', [
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('settings.pin.lead') }),
      BO.el('div', { 'class': 'bo-toolbar' }, [change, lock]),
      BO.el('p', { 'class': 'bo-caption', text: BO.t('settings.pin.recovery') })
    ]);
  }

  function about() {
    var dl = BO.el('dl', { 'class': 'bo-kv bo-about' });
    var lic = BO.el('button', { 'class': 'bo-button bo-button--ghost', type: 'button', data: { act: 'licences' } }, [BO.icon('info'), BO.t('settings.about.licences')]);
    lic.addEventListener('click', function () { BO.router.go('help', { doc: 'licenses' }); });
    BO.invoke('app:version', {}, function (r) {
      if (!r.ok) { return; }
      var v = r.data;
      [['bonis oculis', v.app], ['Electron', v.electron], ['Chromium', v.chrome], ['Node.js', v.node], ['mpv', v.mpv || BO.t('settings.about.missing')], ['FFmpeg', v.ffmpeg || BO.t('settings.about.missing')]].forEach(function (pair) {
        dl.appendChild(BO.el('dt', { text: pair[0] }));
        dl.appendChild(BO.el('dd', { 'class': 'bo-num', text: pair[1] || '' }));
      });
    });
    return card('about', [BO.el('p', { 'class': 'bo-body-2', text: BO.t('settings.about.lead') }), dl, lic]);
  }

  function render() {
    BO.clear(content);
    BO.clear(nav);
    content.appendChild(BO.el('h1', { 'class': 'bo-page__title', text: BO.t('settings.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } }));
    [protection(), playback(), scanning(), privacy(), language(), pin(), about()].forEach(function (c) { content.appendChild(c); });
    SECTIONS.forEach(function (key, i) {
      var b = BO.el('button', { 'class': 'bo-nav__item', type: 'button', attrs: { 'aria-current': i === 0 ? 'true' : null }, data: { section: key } }, BO.el('span', { 'class': 'bo-nav__label', text: BO.t('settings.' + key) }));
      b.addEventListener('click', function () {
        BO.qsa('.bo-nav__item', nav).forEach(function (x) { x.removeAttribute('aria-current'); });
        b.setAttribute('aria-current', 'true');
        var target = BO.qs('#settings-' + key, content);
        if (target) { target.scrollIntoView({ block: 'start' }); BO.focus(BO.qs('#settings-' + key + '-h', content)); }
      });
      nav.appendChild(b);
    });
  }

  BO.views.settings = {
    init: function (section) {
      root = section;
      nav = BO.el('nav', { 'class': 'bo-nav bo-settings__nav', attrs: { 'aria-label': BO.t('settings.sections') } });
      content = BO.el('div', { 'class': 'bo-settings__content' });
      aside = BO.el('aside', { 'class': 'bo-settings__aside', attrs: { 'aria-label': BO.t('settings.aside.title') } });
      root.appendChild(BO.el('div', { 'class': 'bo-settings' }, [nav, content, aside]));
      BO.i18n.onChange(function () { nav.setAttribute('aria-label', BO.t('settings.sections')); });
    },
    show: function (params) {
      render();
      explain(null);
      if (params && params.section) {
        var target = BO.qs('#settings-' + params.section, content);
        if (target) { target.scrollIntoView({ block: 'start' }); }
      }
    },
    hide: function () {}
  };
}(window));
