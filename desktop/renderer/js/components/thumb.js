/* Blurred thumbnail (DESIGN 12.2): the stored file is already box-blurred; CSS blurs it again,
   tints it with the category veil and labels it with the category, never with a description.
   kinds: 'blurred' (default) | 'cleared' | 'locked'. Peek (12.3) swaps in a live frame that is
   still drawn with a 5 px blur, only while held. BO.thumb.create({category, src, kind, label}). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  function create(opts) {
    var o = opts || {};
    var fig = BO.el('figure', { 'class': 'bo-thumb' });
    var img = null;
    var blurredSrc = null;
    var cat = null;
    var kind = 'blurred';

    function render() {
      BO.clear(fig);
      fig.className = 'bo-thumb' + (cat ? ' bo-thumb--' + cat : '') + (kind === 'cleared' ? ' bo-thumb--cleared' : '') + (kind === 'locked' || !blurredSrc ? ' bo-thumb--locked' : '');
      if (kind === 'locked' || !blurredSrc) {
        fig.appendChild(BO.icon(kind === 'locked' ? 'lock' : 'eye-off'));
        fig.appendChild(BO.el('span', { 'class': 'bo-sr-only', text: BO.t(kind === 'locked' ? 'thumb.locked' : 'thumb.hidden') }));
        img = null;
        return;
      }
      img = BO.el('img', { 'class': 'bo-thumb__img', attrs: { src: blurredSrc, alt: '', draggable: 'false' } });
      fig.appendChild(img);
      fig.appendChild(BO.el('span', { 'class': 'bo-thumb__veil' }));
      if (kind !== 'cleared') {
        fig.appendChild(BO.el('span', { 'class': 'bo-thumb__eyeoff' }, BO.icon('eye-off')));
        if (cat && o.label !== false) {
          fig.appendChild(BO.el('figcaption', { 'class': 'bo-thumb__label' }, [BO.icon('cat-' + cat), BO.t('cat.' + cat)]));
        }
      }
    }

    function set(next) {
      if (next.category !== undefined) { cat = next.category; }
      if (next.src !== undefined) { blurredSrc = next.src; }
      if (next.kind !== undefined) { kind = next.kind; }
      render();
    }

    function peek(url) {
      if (!img) { return; }
      if (url) {
        img.src = url;
        fig.classList.add('is-peeking');
      } else {
        fig.classList.remove('is-peeking');
        img.src = blurredSrc;
      }
    }

    set({ category: o.category || null, src: o.src || null, kind: o.kind || 'blurred' });
    return { el: fig, set: set, peek: peek };
  }

  BO.thumb = { create: create };
}(window));
