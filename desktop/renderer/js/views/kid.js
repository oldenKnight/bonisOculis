/* Kid mode (PLAN 5.3, DESIGN 8.4): only Protected titles, big Play tiles, nothing else but the
   lock (a PIN pad for the parent). Main serves only kid-safe channels while locked. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var grid = null;
  var list = [];
  var posters = {};

  function tile(it) {
    var thumb = BO.thumb.create({ kind: 'locked', label: false });
    var b = BO.el('button', { 'class': 'bo-play-tile bo-play-tile--kid', type: 'button', attrs: { 'aria-label': BO.t('kid.play', { title: it.title }) }, data: { id: it.id } }, [
      BO.el('span', { 'class': 'bo-play-tile__media' }, [thumb.el, BO.el('span', { 'class': 'bo-play-tile__badge' }, BO.icon('play'))]),
      BO.el('span', { 'class': 'bo-play-tile__body' }, [
        BO.el('span', { 'class': 'bo-play-tile__title', text: it.title }),
        it.duration ? BO.el('span', { 'class': 'bo-play-tile__meta', text: BO.fmt.duration(it.duration) }) : null
      ])
    ]);
    b.addEventListener('click', function () {
      BO.invoke('player:play', { id: it.id, kidMode: true }, function (r) { if (!r.ok) { BO.toast.error(r.error === 'kidRefused' ? 'kidRefused' : r.error); } });
    });
    var cached = posters[it.id];
    if (cached) { thumb.set(cached); } else {
      BO.invoke('library:poster', { id: it.id }, function (r) {
        if (r.ok && r.data) { posters[it.id] = { kind: r.data.kind, src: r.data.src }; thumb.set(posters[it.id]); }
      });
    }
    return b;
  }

  function render() {
    BO.clear(grid);
    if (!list.length) {
      grid.appendChild(BO.el('div', { 'class': 'bo-empty bo-kid__empty' }, [
        BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('film')),
        BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('kid.empty.title') }),
        BO.el('p', { 'class': 'bo-empty__text', text: BO.t('kid.empty.text') })
      ]));
      return;
    }
    list.forEach(function (it) { grid.appendChild(tile(it)); });
  }

  function load() {
    BO.invoke('library:list', {}, function (r) {
      list = r.ok && r.data ? r.data.filter(function (it) { return it.status === 'protected'; }) : [];
      render();
    });
  }

  function unlock() {
    BO.pinPad.ask({ purpose: 'unlock', heading: BO.t('kid.parentTitle'), text: BO.t('kid.parentText'), allowRecover: true, onForgot: function () { BO.pinFlows.recover(); } }, function () {});
  }

  function build() {
    BO.clear(root);
    var lockBtn = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--lg bo-kid__lock', type: 'button', data: { act: 'parent' } }, [BO.icon('lock'), BO.t('kid.parent')]);
    lockBtn.addEventListener('click', unlock);
    grid = BO.el('div', { 'class': 'bo-kid__grid' });
    root.appendChild(BO.el('div', { 'class': 'bo-kid__bar' }, [BO.logo(true), lockBtn]));
    root.appendChild(BO.el('div', { 'class': 'bo-kid__body' }, [
      BO.el('h1', { 'class': 'bo-kid__title', text: BO.t('kid.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } }),
      grid
    ]));
  }

  BO.views.kid = {
    init: function (section) {
      root = section;
      root.classList.add('bo-kid');
      build();
      BO.i18n.onChange(function () { if (BO.router.current() === 'kid') { build(); render(); } });
    },
    show: function () { posters = {}; build(); load(); },
    hide: function () {}
  };
}(window));
