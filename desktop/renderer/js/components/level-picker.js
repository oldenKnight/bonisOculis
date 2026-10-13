/* Level picker (DESIGN 7.4): native radios styled as a segmented control, the description of the
   checked level shown under it by CSS alone. BO.levelPicker.create({category, value, onChange}). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var LEVELS = ['off', 'light', 'moderate', 'strict'];

  function create(opts) {
    var o = opts || {};
    var cat = o.category;
    var name = BO.nextId('lv-' + cat);
    var inputs = {};
    var fs = BO.el('fieldset', { 'class': 'bo-level bo-cat--' + cat, data: { category: cat } });
    fs.appendChild(BO.el('legend', { 'class': 'bo-level__legend' }, [BO.icon('cat-' + cat), BO.t('cat.' + cat)]));
    fs.appendChild(BO.el('p', { 'class': 'bo-level__def', text: BO.t('cat.' + cat + '.def') }));
    LEVELS.forEach(function (lv) {
      var input = BO.el('input', { 'class': 'bo-level__input bo-level__input--' + lv, type: 'radio', id: name + '-' + lv, attrs: { name: name, value: lv } });
      input.checked = o.value === lv;
      input.addEventListener('change', function () { if (input.checked && o.onChange) { o.onChange(lv); } });
      inputs[lv] = input;
      fs.appendChild(input);
    });
    var seg = BO.el('div', { 'class': 'bo-segmented' });
    LEVELS.forEach(function (lv, i) {
      seg.appendChild(BO.el('label', { 'class': 'bo-segmented__opt bo-segmented__opt--' + lv, attrs: { 'for': name + '-' + lv } }, [
        BO.el('span', { 'class': 'bo-bars bo-bars--' + i, attrs: { 'aria-hidden': 'true' } }, [BO.el('i'), BO.el('i'), BO.el('i')]),
        BO.el('span', { text: BO.t('level.' + lv) })
      ]));
    });
    fs.appendChild(seg);
    LEVELS.forEach(function (lv) {
      fs.appendChild(BO.el('p', { 'class': 'bo-level__desc bo-level__desc--' + lv }, [BO.icon('info'), BO.el('span', { text: BO.t(cat === 'language' && lv !== 'off' ? 'level.' + lv + '.descLanguage' : 'level.' + lv + '.desc') })]));
    });
    return {
      el: fs,
      set: function (lv) { if (inputs[lv]) { inputs[lv].checked = true; } },
      setDisabled: function (dis) {
        fs.classList.toggle('is-disabled', !!dis);
        LEVELS.forEach(function (lv) { inputs[lv].disabled = !!dis; });
      }
    };
  }

  BO.levelPicker = { create: create, LEVELS: LEVELS };
}(window));
