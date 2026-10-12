/* Export / Send to TV (PLAN 5.6): choose a movie, then three cards: skip file (.bonis.json), Kodi
   list (.edl), clean copy for USB (progress, Cancel, optional AAC). Each card says in plain words
   what it is for and links to the TV help. Import of a skip file lives here too. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var page = null;
  var selectedId = null;
  var clean = { running: false, done: 0, total: 1, state: null };
  var cleanCard = null;

  function exportable() {
    return (BO.store.get('library') || []).filter(function (it) { return it.status === 'protected' || it.status === 'needsReview'; });
  }

  function reveal(path) {
    return { label: BO.t('export.showInFolder'), onClick: function () { BO.invoke('app:reveal', { path: path }, function () {}); } };
  }

  function runExport(channel, kind, dir) {
    var payload = { id: selectedId };
    if (dir) { payload.dir = dir; }
    BO.invoke(channel, payload, function (r) {
      if (!r.ok && r.error === 'notWritable' && !dir) {
        BO.modal.confirm({ title: BO.t('export.notWritable.title'), body: BO.t('export.notWritable.text'), okLabel: BO.t('export.chooseFolder'), okIcon: 'folder-plus', icon: 'alert' }, function (yes) {
          if (!yes) { return; }
          pickFolder(function (d) { runExport(channel, kind, d); });
        });
        return;
      }
      if (!r.ok) { BO.toast.error(r.error); return; }
      BO.toast.show({ kind: 'success', title: BO.t('export.saved.' + kind), text: r.data.path, actions: [reveal(r.data.path)] });
    });
  }

  function pickFolder(cb) {
    BO.invoke('export:pickFolder', {}, function (r) {
      if (r.ok && r.data && r.data.dir) { cb(r.data.dir); }
    });
  }

  function helpLink() {
    var b = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', data: { act: 'tv-help' } }, [BO.icon('help'), BO.t('export.howTv')]);
    b.addEventListener('click', function () { BO.router.go('help', { anchor: 'tv' }); });
    return b;
  }

  function exportCard(kind, iconName, channel) {
    var b = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', disabled: !selectedId, data: { act: 'export-' + kind } }, [BO.icon('download'), BO.t('export.' + kind + '.button')]);
    b.addEventListener('click', function () { runExport(channel, kind); });
    return BO.el('article', { 'class': 'bo-card bo-export__card', data: { card: kind } }, [
      BO.el('span', { 'class': 'bo-export__icon' }, BO.icon(iconName)),
      BO.el('h2', { 'class': 'bo-export__title', text: BO.t('export.' + kind + '.title') }),
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('export.' + kind + '.text') }),
      BO.el('div', { 'class': 'bo-export__actions' }, [b, helpLink()])
    ]);
  }

  function renderClean() {
    if (!cleanCard) { return; }
    var body = BO.qs('.bo-export__dynamic', cleanCard);
    BO.clear(body);
    if (clean.running) {
      var pct = Math.round(clean.done / Math.max(1, clean.total) * 100);
      var cancel = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'clean-cancel' } }, [BO.icon('close'), BO.t('common.cancel')]);
      cancel.addEventListener('click', function () { BO.invoke('export:cancel', {}, function () {}); });
      body.appendChild(BO.el('div', { 'class': 'bo-export__progress' }, [
        BO.el('p', { 'class': 'bo-body-2', attrs: { role: 'status' }, text: BO.t('export.clean.progress', { pct: pct }) }),
        BO.el('progress', { 'class': 'bo-progress bo-progress--thick', attrs: { value: pct, max: 100, 'aria-label': BO.t('export.clean.progress', { pct: pct }) } }),
        cancel
      ]));
      return;
    }
    var aac = BO.el('input', { 'class': 'bo-switch__input', type: 'checkbox', id: BO.nextId('aac'), data: { setting: 'aac' } });
    var start = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', disabled: !selectedId, data: { act: 'export-clean' } }, [BO.icon('usb'), BO.t('export.clean.button')]);
    var where = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', disabled: !selectedId, data: { act: 'clean-where' } }, [BO.icon('folder-plus'), BO.t('export.clean.where')]);
    function go(dir) {
      clean = { running: true, done: 0, total: 1, state: 'running' };
      renderClean();
      var payload = { id: selectedId, aac: aac.checked };
      if (dir) { payload.dir = dir; }
      BO.invoke('export:clean', payload, function (r) {
        clean.running = false;
        renderClean();
        if (!r.ok) {
          if (r.error === 'cancelled') { BO.toast.show({ kind: 'info', title: BO.t('export.clean.cancelled') }); return; }
          BO.toast.error(r.error);
          return;
        }
        BO.toast.show({ kind: 'success', title: BO.t('export.saved.clean'), text: r.data.path, actions: [reveal(r.data.path)] });
      });
    }
    start.addEventListener('click', function () { go(null); });
    where.addEventListener('click', function () { pickFolder(function (d) { go(d); }); });
    body.appendChild(BO.el('label', { 'class': 'bo-switch', attrs: { 'for': aac.id } }, [aac, BO.el('span', { 'class': 'bo-switch__track' }), BO.el('span', { 'class': 'bo-switch__label', text: BO.t('export.clean.aac') })]));
    body.appendChild(BO.el('p', { 'class': 'bo-caption', text: BO.t('export.clean.aacHelp') }));
    body.appendChild(BO.el('div', { 'class': 'bo-export__actions' }, [start, where, helpLink()]));
  }

  function cleanCardEl() {
    cleanCard = BO.el('article', { 'class': 'bo-card bo-export__card', data: { card: 'clean' } }, [
      BO.el('span', { 'class': 'bo-export__icon' }, BO.icon('usb')),
      BO.el('h2', { 'class': 'bo-export__title', text: BO.t('export.clean.title') }),
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('export.clean.text') }),
      BO.el('div', { 'class': 'bo-export__dynamic' })
    ]);
    renderClean();
    return cleanCard;
  }

  function importFlow() {
    BO.invoke('import:json', {}, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      var d = r.data || {};
      if (d.canceled) { return; }
      if (d.needsPick) { pickTarget(d); return; }
      importDone(d);
    });
  }

  function importDone(d) {
    var it = BO.store.item(d.id);
    BO.toast.show({ kind: d.warning ? 'warning' : 'success', title: BO.t('import.done', { title: it ? it.title : '' }),
      text: d.warning ? BO.t('import.warning.' + d.warning) : null,
      actions: [{ label: BO.t('library.review'), onClick: function () { BO.router.go('review', { id: d.id }); } }] });
  }

  function pickTarget(d) {
    if (!d.candidates || !d.candidates.length) {
      BO.toast.show({ kind: 'warning', title: BO.t('import.noMovies.title'), text: BO.t('import.noMovies.text') });
      BO.invoke('import:json', { token: d.token }, function () {});
      return;
    }
    var sel = BO.el('select', { 'class': 'bo-input bo-select', id: BO.nextId('imp') });
    d.candidates.forEach(function (c) { sel.appendChild(BO.el('option', { text: c.title, attrs: { value: c.id } })); });
    var picked = false;
    BO.modal.open({
      title: BO.t('import.pick.title'), icon: 'upload',
      body: [BO.el('p', { text: BO.t('import.pick.text', { title: d.title || '' }) }),
        BO.el('div', { 'class': 'bo-field' }, [BO.el('label', { 'class': 'bo-field__label', attrs: { 'for': sel.id }, text: BO.t('import.pick.label') }), sel]),
        BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('alert'), BO.el('p', { text: BO.t('import.warning.offsetUnknown') })])],
      actions: [
        { label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' },
        { label: BO.t('import.pick.ok'), kind: 'primary', id: 'ok', icon: 'upload', onClick: function (close) {
          picked = true;
          close();
          BO.invoke('import:json', { token: d.token, targetId: sel.value }, function (r) {
            if (!r.ok) { BO.toast.error(r.error); return; }
            importDone(r.data);
          });
        } }
      ],
      onClose: function () { if (!picked) { BO.invoke('import:json', { token: d.token }, function () {}); } }
    });
  }

  function render() {
    BO.clear(page);
    var list = exportable();
    if (selectedId && !list.some(function (it) { return it.id === selectedId; })) { selectedId = null; }
    if (!selectedId && list.length) { selectedId = list[0].id; }
    var importBtn = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'import' } }, [BO.icon('upload'), BO.t('import.button')]);
    importBtn.addEventListener('click', importFlow);
    page.appendChild(BO.el('header', { 'class': 'bo-page__header' }, [
      BO.el('div', null, [
        BO.el('h1', { 'class': 'bo-page__title', text: BO.t('export.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } }),
        BO.el('p', { 'class': 'bo-page__sub', text: BO.t('export.lead') })
      ]),
      importBtn
    ]));
    if (!list.length) {
      page.appendChild(BO.el('div', { 'class': 'bo-empty bo-card bo-card--flat' }, [
        BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('tv')),
        BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('export.empty.title') }),
        BO.el('p', { 'class': 'bo-empty__text', text: BO.t('export.empty.text') })
      ]));
      return;
    }
    var sel = BO.el('select', { 'class': 'bo-input bo-select', id: BO.nextId('exp'), data: { act: 'movie' } });
    list.forEach(function (it) {
      var o = BO.el('option', { text: it.title, attrs: { value: it.id } });
      if (it.id === selectedId) { o.selected = true; }
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { selectedId = sel.value; render(); BO.focus(BO.qs('select', page)); });
    var cur = BO.store.item(selectedId);
    page.appendChild(BO.el('div', { 'class': 'bo-field bo-export__movie' }, [BO.el('label', { 'class': 'bo-field__label', attrs: { 'for': sel.id }, text: BO.t('export.movie') }), sel]));
    if (cur && cur.status !== 'protected') {
      page.appendChild(BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('alert'), BO.el('p', { text: BO.tn('export.notReviewed', cur.pending || 0) })]));
    }
    page.appendChild(BO.el('div', { 'class': 'bo-export__grid' }, [
      exportCard('json', 'download', 'export:json'),
      exportCard('edl', 'tv', 'export:edl'),
      cleanCardEl()
    ]));
  }

  BO.views['export'] = {
    init: function (section) {
      root = section;
      page = BO.el('div', { 'class': 'bo-page bo-export' });
      root.appendChild(page);
      BO.on('export:progress', function (p) {
        if (!p) { return; }
        if (p.state === 'running') { clean.running = true; clean.done = p.done || 0; clean.total = p.total || 1; }
        if (BO.router.current() === 'export') { renderClean(); }
      });
    },
    show: function (params) {
      if (params && params.id) { selectedId = params.id; }
      render();
    },
    hide: function () {}
  };
}(window));
