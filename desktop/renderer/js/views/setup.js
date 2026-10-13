/* First run (PLAN 5.1): language -> PIN (twice) -> recovery code (shown once, "I wrote it down")
   -> preset -> "Add your first movie". Every step is one screen. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var STEPS = ['language', 'pin', 'code', 'preset', 'movie'];
  var root = null;
  var step = 'language';
  var code = null;
  var preset = 'little-kids';
  var customLevels = null;

  function settings() { return BO.store.get('settings') || {}; }

  function frame(stepName, titleKey, leadKey, content, footer) {
    var idx = STEPS.indexOf(stepName) + 1;
    BO.clear(root);
    var progress = BO.el('ol', { 'class': 'bo-steps', attrs: { 'aria-label': BO.t('setup.progress', { n: idx, total: STEPS.length }) } },
      STEPS.map(function (s, i) { return BO.el('li', { 'class': 'bo-steps__dot' + (i < idx ? ' is-done' : '') + (i === idx - 1 ? ' is-current' : ''), attrs: { 'aria-current': i === idx - 1 ? 'step' : null } }); }));
    root.appendChild(BO.el('div', { 'class': 'bo-setup__inner bo-setup__inner--' + stepName }, [
      BO.el('div', { 'class': 'bo-setup__top' }, [BO.logo(true), progress]),
      BO.el('p', { 'class': 'bo-overline', text: BO.t('setup.step', { n: idx, total: STEPS.length }) }),
      BO.el('h1', { 'class': 'bo-setup__title', text: BO.t(titleKey), attrs: { tabindex: '-1', 'data-view-heading': '' } }),
      leadKey ? BO.el('p', { 'class': 'bo-lead', text: BO.t(leadKey) }) : null,
      BO.el('div', { 'class': 'bo-setup__content' }, content),
      footer ? BO.el('div', { 'class': 'bo-setup__footer' }, footer) : null
    ]));
    var h = BO.qs('[data-view-heading]', root);
    if (h) { BO.focus(h); }
  }

  function button(label, kind, icon, onClick, data) {
    return BO.el('button', { 'class': 'bo-button bo-button--' + kind + (kind === 'primary' ? ' bo-button--lg' : ''), type: 'button', data: data || null, on: { click: onClick } }, [icon && kind !== 'primary' ? BO.icon(icon) : null, label, icon && kind === 'primary' ? BO.icon(icon) : null]);
  }

  function go(next) { step = next; render(); }

  function setLang(lang, cb) {
    BO.invoke('settings:set', { patch: { lang: lang } }, function (r) {
      if (r.ok && r.data) {
        BO.store.set('settings', r.data.settings);
        if (r.data.strings) { BO.i18n.set(r.data.strings, lang); BO.i18n.apply(window.document); }
      }
      if (cb) { cb(); }
    });
  }

  function renderLanguage() {
    var current = settings().lang || 'es-MX';
    var opts = [{ lang: 'es-MX', label: 'Español (México)', sub: 'Usar la app en español' }, { lang: 'en-US', label: 'English (US)', sub: 'Use the app in English' }];
    var group = BO.el('div', { 'class': 'bo-choice-group', attrs: { role: 'radiogroup', 'aria-label': BO.t('setup.language.title') } });
    opts.forEach(function (o) {
      var b = BO.el('button', { 'class': 'bo-choice', type: 'button', attrs: { role: 'radio', 'aria-checked': o.lang === current ? 'true' : 'false', lang: o.lang }, data: { lang: o.lang } }, [
        BO.el('span', { 'class': 'bo-choice__icon' }, BO.icon('globe')),
        BO.el('span', { 'class': 'bo-choice__text' }, [BO.el('span', { 'class': 'bo-choice__title', text: o.label }), BO.el('span', { 'class': 'bo-choice__sub', text: o.sub })]),
        BO.el('span', { 'class': 'bo-choice__check' }, BO.icon('check'))
      ]);
      b.addEventListener('click', function () { setLang(o.lang, function () { render(); BO.focus(BO.qs('[data-lang="' + o.lang + '"]', root)); }); });
      group.appendChild(b);
    });
    frame('language', 'setup.language.title', 'setup.language.lead', group, [
      button(BO.t('common.continue'), 'primary', 'chevron-right', function () { go('pin'); }, { action: 'continue' })
    ]);
  }

  function renderPin() {
    var host = BO.el('div', { 'class': 'bo-setup__pin' });
    frame('pin', 'setup.pin.title', 'setup.pin.lead', host, [button(BO.t('common.back'), 'ghost', 'chevron-left', function () { go('language'); })]);
    BO.pinFlows.choose(host, {}, function (pin, pad) {
      BO.invoke('pin:set', { pin: pin }, function (r) {
        if (!r.ok) { pad.error(BO.t(r.error === 'pinWeak' ? 'pin.weak' : 'error.' + (r.error || 'failed') + '.title')); return; }
        code = r.data.recoveryCode;
        go('code');
      });
    });
  }

  function renderCode() {
    if (!code) { go('preset'); return; }
    frame('code', 'setup.code.title', 'setup.code.lead', BO.pinFlows.codeBlock(code, function () { code = null; go('preset'); }), null);
  }

  function renderPreset() {
    var choices = [
      { id: 'little-kids', icon: 'shield-check' },
      { id: 'teens', icon: 'eye' },
      { id: 'custom', icon: 'settings' }
    ];
    var group = BO.el('div', { 'class': 'bo-choice-group', attrs: { role: 'radiogroup', 'aria-label': BO.t('setup.preset.title') } });
    var pickers = BO.el('div', { 'class': 'bo-setup__levels', hidden: preset !== 'custom' });
    var levels = customLevels || JSON.parse(JSON.stringify(settings().levels || {}));
    BO.LEVEL_CATEGORIES.forEach(function (cat) {
      pickers.appendChild(BO.levelPicker.create({ category: cat, value: levels[cat] || 'strict', onChange: function (lv) { levels[cat] = lv; customLevels = levels; } }).el);
    });
    choices.forEach(function (c) {
      var b = BO.el('button', { 'class': 'bo-choice', type: 'button', attrs: { role: 'radio', 'aria-checked': preset === c.id ? 'true' : 'false' }, data: { preset: c.id } }, [
        BO.el('span', { 'class': 'bo-choice__icon' }, BO.icon(c.icon)),
        BO.el('span', { 'class': 'bo-choice__text' }, [BO.el('span', { 'class': 'bo-choice__title', text: BO.t('preset.' + c.id) }), BO.el('span', { 'class': 'bo-choice__sub', text: BO.t('preset.' + c.id + '.desc') })]),
        BO.el('span', { 'class': 'bo-choice__check' }, BO.icon('check'))
      ]);
      b.addEventListener('click', function () {
        preset = c.id;
        BO.qsa('.bo-choice', group).forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
        pickers.hidden = preset !== 'custom';
      });
      group.appendChild(b);
    });
    frame('preset', 'setup.preset.title', 'setup.preset.lead', [group, pickers, BO.el('p', { 'class': 'bo-caption', text: BO.t('setup.preset.later') })], [
      button(BO.t('common.continue'), 'primary', 'chevron-right', function () {
        var patch = preset === 'custom' ? { preset: 'custom', levels: levels } : { preset: preset };
        BO.invoke('settings:set', { patch: patch }, function (r) {
          if (!r.ok) { BO.toast.error(r.error); return; }
          BO.store.set('settings', r.data.settings);
          go('movie');
        });
      }, { action: 'continue' })
    ]);
  }

  function finish() {
    BO.invoke('settings:set', { patch: { setupDone: true } }, function (r) {
      if (r.ok) { BO.store.set('settings', r.data.settings); }
      BO.router.go('library');
    });
  }

  function renderMovie() {
    var dz = BO.dropZone.create({ title: BO.t('setup.movie.drop'), hint: BO.t('drop.hint'), onPick: function () { BO.app.pickMovies(function (res) { if (res && res.added && res.added.length) { finish(); } }); } });
    frame('movie', 'setup.movie.title', 'setup.movie.lead', [dz.el, BO.el('div', { 'class': 'bo-notice' }, [BO.icon('clock'), BO.el('p', { text: BO.t('setup.movie.note') })])], [
      button(BO.t('setup.movie.later'), 'ghost', null, finish, { action: 'later' })
    ]);
  }

  function render() {
    if (step === 'language') { renderLanguage(); } else if (step === 'pin') { renderPin(); } else if (step === 'code') { renderCode(); } else if (step === 'preset') { renderPreset(); } else { renderMovie(); }
  }

  BO.views.setup = {
    init: function (section) {
      root = section;
      root.classList.add('bo-setup');
    },
    show: function (params) {
      var boot = BO.store.get('boot') || {};
      step = params && params.step ? params.step : (boot.hasPin ? 'preset' : 'language');
      render();
    },
    hide: function () {},
    // Files dropped on the last step finish the wizard.
    onFilesAdded: function () { if (step === 'movie') { finish(); } },
    acceptsFiles: function () { return step === 'movie'; }
  };
}(window));
