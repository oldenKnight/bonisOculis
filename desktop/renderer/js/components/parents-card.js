/* Parents card (DESIGN 7.12; Common Sense Media benchmark): counts per category with intensity,
   non-graphic, never a description, a timestamp list or an image. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var WORDS = { 1: 'intensity.mild', 2: 'intensity.moderate', 3: 'intensity.strong' };

  function dots(cat, n) {
    var word = BO.t(WORDS[n] || WORDS[1]);
    return BO.el('span', { 'class': 'bo-dots bo-dots--' + (n || 1) + ' bo-dots--' + cat, attrs: { role: 'img', 'aria-label': word } }, [BO.el('i'), BO.el('i'), BO.el('i')]);
  }

  // opts: {title, meta, pill, summary (BO.skipfile.summarise), headingLevel}
  function create(opts) {
    var o = opts || {};
    var s = o.summary || {};
    var list = BO.el('ul', { 'class': 'bo-parents-card__list' });
    BO.CATEGORIES.forEach(function (cat) {
      var e = s[cat] || { count: 0, maxIntensity: 0 };
      if (cat === 'other' && !e.count) { return; }
      var none = !e.count;
      list.appendChild(BO.el('li', { 'class': 'bo-parents-row bo-parents-row--' + cat + (none ? ' is-none' : ''), data: { category: cat } }, [
        BO.el('span', { 'class': 'bo-parents-row__icon' }, BO.icon('cat-' + cat)),
        BO.el('span', { 'class': 'bo-parents-row__name', text: BO.t('cat.' + cat) }),
        BO.el('span', { 'class': 'bo-parents-row__count', text: none ? BO.t('parents.none') : BO.tn('parents.scenes', e.count) }),
        none ? BO.el('span') : dots(cat, e.maxIntensity || 1),
        none ? BO.el('span', { 'class': 'bo-parents-row__word' }, BO.icon('check')) : BO.el('span', { 'class': 'bo-parents-row__word', text: BO.t(WORDS[e.maxIntensity || 1]) })
      ]));
    });
    var h = BO.el(o.headingLevel || 'h3', { 'class': 'bo-parents-card__title', text: o.title || '' });
    return BO.el('article', { 'class': 'bo-parents-card', attrs: { 'aria-label': BO.t('parents.label') } }, [
      BO.el('header', { 'class': 'bo-parents-card__header' }, [
        BO.el('div', null, [h, o.meta ? BO.el('p', { 'class': 'bo-parents-card__meta', text: o.meta }) : null]),
        o.pill || null
      ]),
      list,
      BO.el('footer', { 'class': 'bo-parents-card__footer', text: BO.t('parents.footer') })
    ]);
  }

  BO.parentsCard = { create: create, dots: dots, WORDS: WORDS };
}(window));
