/* Library (PLAN 5.2, DESIGN 8.1): title cards with status pills, Play, overflow menu (Review,
   Export, Rescan, Remove), the scan queue drawer below, drag and drop anywhere. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var grid = null;
  var header = null;
  var filter = null;
  var posters = {};
  var cards = {};

  function items() {
    var list = BO.store.get('library') || [];
    if (filter === 'review') { list = list.filter(function (it) { return it.status === 'needsReview'; }); }
    return list;
  }

  function meta(it) {
    var parts = [];
    if (it.year) { parts.push(String(it.year)); }
    if (it.duration) { parts.push(BO.fmt.duration(it.duration)); }
    return parts.join(' · ');
  }

  function play(it) {
    function go() {
      BO.invoke('player:play', { id: it.id, kidMode: false }, function (r) { if (!r.ok) { BO.toast.error(r.error); } });
    }
    if (it.status === 'protected') { go(); return; }
    BO.modal.confirm({
      title: BO.t('library.playUnprotected.title'), body: BO.t(it.status === 'needsReview' ? 'library.playUnprotected.review' : 'library.playUnprotected.text'),
      okLabel: BO.t('library.playUnprotected.ok'), okIcon: 'play', icon: 'alert'
    }, function (yes) { if (yes) { go(); } });
  }

  function rescan(it) {
    BO.invoke('scan:queue', { id: it.id }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      BO.toast.show({ kind: 'info', title: BO.t('library.queued', { title: it.title }) });
    });
  }

  function remove(it) {
    BO.modal.confirm({
      title: BO.t('library.remove.title'), body: BO.t('library.remove.text'), danger: true,
      cancelLabel: BO.t('library.remove.keep'), okLabel: BO.t('library.remove.ok'), okIcon: 'trash', icon: 'trash'
    }, function (yes) {
      if (!yes) { return; }
      BO.invoke('library:remove', { id: it.id }, function (r) {
        if (!r.ok) { BO.toast.error(r.error); return; }
        delete posters[it.id];
        BO.toast.show({ kind: 'success', title: BO.t('library.removed', { title: it.title }) });
      });
    });
  }

  function more(it, btn) {
    var scanning = it.status === 'scanning' || it.status === 'queued';
    BO.popupMenu.open(btn, [
      it.status !== 'protected' ? { id: 'play', label: BO.t('library.menu.play'), icon: 'play', onClick: function () { play(it); } } : null,
      { id: 'review', label: BO.t('library.menu.review'), icon: 'eye', disabled: scanning, onClick: function () { BO.router.go('review', { id: it.id }); } },
      { id: 'export', label: BO.t('library.menu.export'), icon: 'tv', disabled: scanning || it.status === 'notScanned', onClick: function () { BO.router.go('export', { id: it.id }); } },
      scanning ? { id: 'stop', label: BO.t('library.menu.stopScan'), icon: 'close', onClick: function () { BO.invoke('scan:cancel', { id: it.id }, function () {}); } } :
        { id: 'rescan', label: BO.t(it.status === 'notScanned' ? 'library.menu.scan' : 'library.menu.rescan'), icon: 'rescan', onClick: function () { rescan(it); } },
      { id: 'remove', label: BO.t('library.menu.remove'), icon: 'trash', danger: true, onClick: function () { remove(it); } }
    ]);
  }

  function primaryAction(it) {
    var scan = BO.store.get('scan') || {};
    var b;
    if (it.status === 'protected') {
      b = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', data: { act: 'play' } }, [BO.icon('play'), BO.t('library.play')]);
      b.addEventListener('click', function () { play(it); });
    } else if (it.status === 'needsReview') {
      b = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', data: { act: 'review' } }, [BO.icon('eye'), BO.t('library.review')]);
      b.addEventListener('click', function () { BO.router.go('review', { id: it.id }); });
    } else if (it.status === 'scanning' || it.status === 'queued') {
      var paused = scan.paused && scan.pauseReason === 'user';
      if (scan.running === it.id) {
        b = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: paused ? 'resume' : 'pause' } }, [BO.icon(paused ? 'play' : 'pause'), BO.t(paused ? 'drawer.resume' : 'drawer.pause')]);
        b.addEventListener('click', function () { BO.invoke(paused ? 'scan:resume' : 'scan:pause', {}, function () {}); });
      } else {
        b = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'unqueue' } }, [BO.icon('close'), BO.t('library.unqueue')]);
        b.addEventListener('click', function () { BO.invoke('scan:cancel', { id: it.id }, function () {}); });
      }
    } else if (it.status === 'needsAttention') {
      b = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'retry' } }, [BO.icon('rescan'), BO.t('library.retry')]);
      b.addEventListener('click', function () { rescan(it); });
    } else {
      b = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'scan' } }, [BO.icon('scan'), BO.t('library.scanNow')]);
      b.addEventListener('click', function () { rescan(it); });
    }
    return b;
  }

  function loadPoster(it, thumb) {
    var key = it.status;
    var cached = posters[it.id];
    if (cached && cached.key === key) { thumb.set({ kind: cached.kind, src: cached.src }); return; }
    BO.invoke('library:poster', { id: it.id }, function (r) {
      if (!r.ok || !r.data) { return; }
      posters[it.id] = { key: key, kind: r.data.kind, src: r.data.src };
      thumb.set({ kind: r.data.kind, src: r.data.src });
    });
  }

  function card(it) {
    var thumb = BO.thumb.create({ kind: 'locked', label: false });
    var titleId = BO.nextId('card-title');
    var moreBtn = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--icon', type: 'button', attrs: { 'aria-label': BO.t('library.more', { title: it.title }), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, data: { act: 'more' } }, BO.icon('more'));
    moreBtn.addEventListener('click', function () { more(it, moreBtn); });
    var hint = it.status === 'needsAttention' ? BO.el('p', { 'class': 'bo-title-card__hint', text: BO.t('attention.' + (it.error || 'scanFailed')) }) : null;
    var el = BO.el('article', { 'class': 'bo-title-card', attrs: { 'aria-labelledby': titleId }, data: { id: it.id, status: it.status } }, [
      thumb.el,
      BO.el('div', { 'class': 'bo-title-card__body' }, [
        BO.el('h2', { 'class': 'bo-title-card__title', id: titleId, text: it.title }),
        BO.el('p', { 'class': 'bo-title-card__meta', text: meta(it) }),
        BO.statusPill.create(it, BO.store.get('scan')),
        hint,
        BO.el('div', { 'class': 'bo-title-card__actions' }, [primaryAction(it), moreBtn])
      ])
    ]);
    loadPoster(it, thumb);
    return el;
  }

  function renderHeader() {
    var all = BO.store.get('library') || [];
    var prot = all.filter(function (it) { return it.status === 'protected'; }).length;
    BO.clear(header);
    var add = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--lg', type: 'button', data: { act: 'add' } }, [BO.icon('folder-plus'), BO.t('library.add')]);
    add.addEventListener('click', function () { BO.app.pickMovies(); });
    header.appendChild(BO.el('div', null, [
      BO.el('h1', { 'class': 'bo-page__title', text: BO.t(filter === 'review' ? 'nav.review' : 'library.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } }),
      BO.el('p', { 'class': 'bo-page__sub', text: filter === 'review' ? BO.tn('library.toReviewSub', items().length) : BO.t(all.length === 1 ? 'library.sub.one' : 'library.sub.other', { count: all.length, protected: prot }) })
    ]));
    header.appendChild(add);
  }

  function render() {
    if (!root) { return; }
    var hadFocus = window.document.activeElement;
    var cardEl = hadFocus && grid.contains(hadFocus) ? hadFocus.closest('[data-id]') : null;
    var focusKey = cardEl ? { id: cardEl.getAttribute('data-id'), act: hadFocus.getAttribute('data-act') } : null;
    renderHeader();
    BO.clear(grid);
    var list = items();
    cards = {};
    if (!list.length) {
      grid.className = 'bo-library__empty';
      if (filter === 'review') {
        grid.appendChild(BO.el('div', { 'class': 'bo-empty bo-card bo-card--flat' }, [
          BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('check')),
          BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('library.reviewEmpty.title') }),
          BO.el('p', { 'class': 'bo-empty__text', text: BO.t('library.reviewEmpty.text') })
        ]));
        return;
      }
      grid.appendChild(BO.el('div', { 'class': 'bo-empty' }, [
        BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('film')),
        BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('library.empty.title') }),
        BO.el('p', { 'class': 'bo-empty__text', text: BO.t('library.empty.text') })
      ]));
      grid.appendChild(BO.dropZone.create({ onPick: function () { BO.app.pickMovies(); } }).el);
      return;
    }
    grid.className = 'bo-grid--tiles';
    list.forEach(function (it) {
      var c = card(it);
      cards[it.id] = c;
      grid.appendChild(c);
    });
    if (focusKey && focusKey.id && cards[focusKey.id]) {
      var target = BO.qs('[data-act="' + focusKey.act + '"]', cards[focusKey.id]) || BO.qs('button', cards[focusKey.id]);
      if (target) { BO.focus(target); }
    }
  }

  BO.views.library = {
    init: function (section) {
      root = section;
      header = BO.el('header', { 'class': 'bo-page__header' });
      grid = BO.el('div', { 'class': 'bo-grid--tiles' });
      section.appendChild(BO.el('div', { 'class': 'bo-page' }, [header, grid]));
      BO.store.subscribe('library', function () { if (BO.router.current() === 'library') { render(); } });
      BO.store.subscribe('scan', function (s) {
        if (BO.router.current() !== 'library') { return; }
        // Only the running card changes with progress: refresh its pill in place.
        var running = s && s.running;
        var it = running && BO.store.item(running);
        if (it && cards[running]) {
          var pill = BO.qs('.bo-pill', cards[running]);
          if (pill) { pill.parentNode.replaceChild(BO.statusPill.create(it, s), pill); }
          var act = BO.qs('.bo-title-card__actions', cards[running]);
          if (act && act.firstChild) { act.replaceChild(primaryAction(it), act.firstChild); }
        }
      });
      BO.i18n.onChange(function () { posters = {}; if (BO.router.current() === 'library') { render(); } });
    },
    show: function (params) {
      filter = params && params.filter === 'review' ? 'review' : null;
      render();
    },
    hide: function () { BO.popupMenu.close(); }
  };
}(window));
