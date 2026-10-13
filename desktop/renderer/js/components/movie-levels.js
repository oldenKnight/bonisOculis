/* "For this movie" (board round 2, decision 6): the levels for one title, stored in its library
   index entry (never in the skip file). "Use my usual levels" removes them. The player, the pre-play
   sheet, the review, the Kodi list and the clean copy all follow them (one code path in main:
   enforce.settingsFor). BO.movieLevels.open(item, cb(updatedItem|null)). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var CATS = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];

  function open(item, cb) {
    var done = typeof cb === 'function' ? cb : function () {};
    var usual = (BO.store.get('settings') || {}).levels || {};
    var own = item.levels || null;
    var levels = {};
    CATS.forEach(function (c) { levels[c] = (own || usual)[c] || 'strict'; });
    var pickers = BO.el('div', { 'class': 'bo-movie-levels__pickers' });
    CATS.forEach(function (cat) {
      pickers.appendChild(BO.levelPicker.create({ category: cat, value: levels[cat], onChange: function (lv) { levels[cat] = lv; } }).el);
    });
    var answered = false;
    function save(lv, close) {
      answered = true;
      BO.invoke('library:setLevels', lv ? { id: item.id, levels: lv } : { id: item.id, levels: null }, function (r) {
        close();
        if (!r.ok) { BO.toast.error(r.error); done(null); return; }
        BO.toast.show({ kind: 'success', title: BO.t(lv ? 'movieLevels.saved' : 'movieLevels.reset', { title: item.title }) });
        done(r.data);
      });
    }
    var actions = [{ label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' }];
    if (own) { actions.push({ label: BO.t('movieLevels.useUsual'), kind: 'secondary', id: 'use-usual', icon: 'undo', onClick: function (close) { save(null, close); } }); }
    actions.push({ label: BO.t('movieLevels.save'), kind: 'primary', id: 'save-levels', icon: 'check', onClick: function (close) { save(levels, close); } });
    BO.modal.open({
      title: BO.t('movieLevels.title', { title: item.title }), icon: 'settings', wide: true, variant: 'movie-levels',
      body: [BO.el('p', { text: BO.t('movieLevels.text') }), own ? BO.el('p', { 'class': 'bo-caption', data: { perMovie: '' }, text: BO.t('movieLevels.active') }) : null, pickers],
      actions: actions,
      onClose: function () { if (!answered) { done(null); } }
    });
  }

  BO.movieLevels = { open: open };
}(window));
