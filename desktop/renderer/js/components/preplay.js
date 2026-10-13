/* Parent-mode Play (planner decisions 1 and 7). Before mpv starts:
   - no readable scene list (never scanned, or damaged): ask "Play it without protection?" with an
     explicit button; nothing starts without that answer;
   - otherwise a sheet: "12 scenes will be skipped · 1 muted · 2 will play (below your level)",
     counts per kind of scene, and the buttons "Review first" and "Play".
   Kid mode never comes here: it plays protected titles directly. BO.playFlow(item). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var PARTS = ['skipped', 'covered', 'muted', 'below', 'letPlay'];

  function startPlay(id, unprotected) {
    BO.invoke('player:play', { id: id, kidMode: false, unprotected: !!unprotected }, function (r) {
      if (r.ok) { return; }
      if (r.error === 'needsConfirm') { askUnprotected({ id: id, title: (BO.store.item(id) || {}).title }, r.data && r.data.reason); return; }
      BO.toast.error(r.error);
    });
  }

  function askUnprotected(item, reason) {
    var damaged = reason === 'damaged';
    BO.modal.open({
      title: BO.t('preplay.noList.title'), icon: 'alert', danger: true,
      body: [BO.el('p', { text: BO.t(damaged ? 'preplay.noList.damaged' : 'preplay.noList.notScanned', { title: item.title || '' }) }),
        BO.el('p', { text: BO.t('preplay.noList.consequence') })],
      actions: [
        { label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' },
        { label: BO.t(damaged ? 'library.menu.rescan' : 'library.scanNow'), kind: 'secondary', id: 'scan', icon: 'rescan', onClick: function (close) {
          close();
          BO.invoke('scan:queue', { id: item.id }, function (r) { if (!r.ok) { BO.toast.error(r.error); } });
        } },
        { label: BO.t('preplay.noList.play'), kind: 'danger', id: 'play-unprotected', icon: 'play', onClick: function (close) { close(); startPlay(item.id, true); } }
      ]
    });
  }

  function summaryLine(totals) {
    var bits = [];
    PARTS.forEach(function (k) { if (totals[k]) { bits.push(BO.tn('preplay.part.' + k, totals[k])); } });
    return bits.length ? bits.join(' · ') : BO.t('preplay.nothing');
  }

  function sheet(item, d) {
    var rows = BO.el('ul', { 'class': 'bo-preplay__list' });
    BO.CATEGORIES.forEach(function (cat) {
      var c = d.byCategory[cat];
      if (!c) { return; }
      rows.appendChild(BO.el('li', { 'class': 'bo-preplay__row bo-cat--' + cat, data: { category: cat } }, [
        BO.el('span', { 'class': 'bo-preplay__cat' }, [BO.icon('cat-' + cat), BO.t('cat.' + cat)]),
        BO.el('span', { 'class': 'bo-preplay__what', text: summaryLine(c) })
      ]));
    });
    var body = [BO.el('p', { 'class': 'bo-lead bo-preplay__summary', data: { summary: '' }, text: summaryLine(d.totals) })];
    if (d.perMovie) { body.push(BO.el('p', { 'class': 'bo-caption', data: { perMovie: '' } }, [BO.icon('settings', 'bo-icon--sm'), BO.t('movieLevels.active')])); }
    if (rows.firstChild) { body.push(rows); }
    if (d.totals.below) { body.push(BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('alert'), BO.el('p', { text: BO.tn('preplay.belowNote', d.totals.below) })])); }
    if (d.pending) { body.push(BO.el('p', { 'class': 'bo-body-2', text: BO.tn('preplay.pendingNote', d.pending) })); }
    if (item.status !== 'protected') { body.push(BO.el('p', { 'class': 'bo-caption', text: BO.t('preplay.notForKids') })); }
    BO.modal.open({
      title: BO.t('preplay.title', { title: item.title }), icon: 'play', wide: true, variant: 'preplay', body: body,
      actions: [
        { label: BO.t('movieLevels.button'), kind: 'ghost', id: 'movie-levels', icon: 'settings', onClick: function (close) {
          close();
          BO.movieLevels.open(BO.store.item(item.id) || item, function (it) { playFlow(it || BO.store.item(item.id) || item); });
        } },
        { label: BO.t('preplay.reviewFirst'), kind: 'secondary', id: 'review-first', icon: 'eye', onClick: function (close) { close(); BO.router.go('review', { id: item.id }); } },
        { label: BO.t('library.play'), kind: 'primary', id: 'play', icon: 'play', autofocus: true, onClick: function (close) { close(); startPlay(item.id, false); } }
      ]
    });
  }

  function playFlow(item) {
    BO.invoke('player:preview', { id: item.id }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      if (!r.data.list) { askUnprotected(item, r.data.damaged ? 'damaged' : 'notScanned'); return; }
      sheet(item, r.data);
    });
  }

  BO.playFlow = playFlow;
  BO.preplay = { summaryLine: summaryLine };
}(window));
