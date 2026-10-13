/* Hotkey cheat sheet (DESIGN 7.13): Watching, Marking, Panic. Used in Settings > Playback and on
   the Now playing panel (kid mode leaves Marking out: the keys are off there). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  function kbd(content) {
    return BO.el('kbd', { 'class': 'bo-kbd' }, typeof content === 'string' ? content : content);
  }

  function row(keys, label, panic) {
    var k = BO.el('span', { 'class': 'bo-keys' });
    keys.forEach(function (combo, i) {
      if (i > 0) { k.appendChild(BO.el('span', { 'class': 'bo-keys__sep', text: BO.t('keys.or') })); }
      combo.forEach(function (key, j) {
        if (j > 0) { k.appendChild(BO.el('span', { 'class': 'bo-keys__sep', text: '+' })); }
        k.appendChild(kbd(key));
      });
    });
    return BO.el('div', { 'class': 'bo-hotkeys__row' + (panic ? ' bo-hotkeys__row--panic' : '') }, [k, BO.el('span', { 'class': 'bo-hotkeys__label', text: label })]);
  }

  function group(titleKey, rows) {
    return BO.el('div', { 'class': 'bo-hotkeys__group' }, [BO.el('h4', { 'class': 'bo-overline bo-hotkeys__title', text: BO.t(titleKey) })].concat(rows));
  }

  // opts: {panicKey, kid}
  function create(opts) {
    var o = opts || {};
    var pk = String(o.panicKey || 'p').toUpperCase();
    var groups = [
      group('keys.watching', [
        row([[BO.t('keys.space')]], BO.t('keys.pause')),
        row([[BO.icon('chevron-left')], [BO.icon('chevron-right')]], BO.t('keys.seek')),
        row([[BO.icon('chevron-down')], [BO.icon('chevron-down', 'bo-icon--up')]], BO.t('keys.seekMinute')),
        row([['F']], BO.t('keys.fullscreen')),
        row([['M']], BO.t('keys.mute'))
      ])
    ];
    if (!o.kid) {
      groups.push(group('keys.marking', [
        row([['I']], BO.t('keys.markIn')),
        row([['O']], BO.t('keys.markOut')),
        row([['U']], BO.t('keys.undo'))
      ]));
    }
    groups.push(group('keys.panic', [
      row([[pk], [BO.t('keys.ctrl'), BO.t('keys.space')]], BO.t('keys.panicHide'), true),
      row([[pk], [BO.t('keys.enter')]], BO.t('keys.panicShow')),
      row([[BO.icon('chevron-right')]], BO.t('keys.panicAhead'))
    ]));
    return BO.el('div', { 'class': 'bo-hotkeys' }, groups);
  }

  BO.hotkeys = { create: create };
}(window));
