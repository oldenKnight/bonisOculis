/* Export / Send to TV (PLAN 5.6): choose a movie, then three cards: clean copy for USB (an exact
   re-encode: a confirm dialog with the measured time first, then progress with the time left and
   Cancel; audio is always AAC), Kodi list (.edl), skip file (.bonis.json). Each card says in plain
   words what it is for and links to the TV help. Import of a skip file lives here too. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var page = null;
  var selectedId = null;
  var clean = { running: false, pct: 0, etaSec: null, state: null };
  var keepHevc = false;
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

  function progressText() {
    var pct = Math.max(0, Math.min(100, Math.round(clean.pct || 0)));
    if (typeof clean.etaSec === 'number' && clean.etaSec > 0) {
      return BO.t('cleancopy.progress', { pct: pct, min: Math.max(1, Math.ceil(clean.etaSec / 60)) });
    }
    return BO.t('cleancopy.progressStarting', { pct: pct });
  }

  // Before the copy: how long it will take on this computer, and what will be left out.
  function confirmCopy(cb) {
    var status = BO.el('p', { 'class': 'bo-body-2', attrs: { role: 'status' }, data: { estimate: '' } }, [BO.el('span', { 'class': 'bo-spinner', attrs: { 'aria-hidden': 'true' } }), BO.t('cleancopy.estimate.measuring')]);
    var notes = BO.el('div', { 'class': 'bo-stack', data: { notes: '' } });
    var answered = false;
    var m = BO.modal.open({
      title: BO.t('cleancopy.confirm.title'), icon: 'usb', variant: 'clean-confirm',
      body: [BO.el('p', { text: BO.t('cleancopy.confirm.text') }), status, notes],
      actions: [
        { label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' },
        { label: BO.t('cleancopy.confirm.ok'), kind: 'primary', id: 'ok', icon: 'usb', onClick: function (close) { answered = true; close(); cb(true); } }
      ],
      onClose: function () { if (!answered) { BO.invoke('export:cancel', {}, function () {}); cb(false); } }
    });
    BO.invoke('export:estimate', { id: selectedId, keepHevc: keepHevc }, function (r) {
      if (answered || !m.el.isConnected) { return; }
      BO.clear(status);
      BO.clear(notes);
      if (!r.ok) {
        status.appendChild(document.createTextNode(BO.t('cleancopy.estimate.unknown')));
        return;
      }
      var d = r.data;
      status.appendChild(BO.el('strong', { text: BO.t(d.words.key, d.words.params) }));
      status.appendChild(document.createTextNode(' ' + BO.t(d.hw ? 'cleancopy.encoder.hw' : 'cleancopy.encoder.sw')));
      if (d.subtitles) { notes.appendChild(BO.el('div', { 'class': 'bo-notice', data: { note: 'subtitles' } }, [BO.icon('info'), BO.el('p', { text: BO.t('cleancopy.subtitles') })])); }
      if (d.hdrConverted) { notes.appendChild(BO.el('div', { 'class': 'bo-notice bo-notice--warning', data: { note: 'hdr' } }, [BO.icon('alert'), BO.el('p', { text: BO.t('cleancopy.hdr') })])); }
    });
  }

  function renderClean() {
    if (!cleanCard) { return; }
    var body = BO.qs('.bo-export__dynamic', cleanCard);
    BO.clear(body);
    if (clean.running) {
      var pct = Math.max(0, Math.min(100, Math.round(clean.pct || 0)));
      var cancel = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'clean-cancel' } }, [BO.icon('close'), BO.t('common.cancel')]);
      cancel.addEventListener('click', function () { BO.invoke('export:cancel', {}, function () {}); });
      body.appendChild(BO.el('div', { 'class': 'bo-export__progress' }, [
        BO.el('p', { 'class': 'bo-body-2', attrs: { role: 'status' }, data: { progress: '' }, text: progressText() }),
        BO.el('progress', { 'class': 'bo-progress bo-progress--thick', attrs: { value: pct, max: 100, 'aria-label': progressText() } }),
        cancel
      ]));
      return;
    }
    var start = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', disabled: !selectedId, data: { act: 'export-clean' } }, [BO.icon('usb'), BO.t('export.clean.button')]);
    var where = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', disabled: !selectedId, data: { act: 'clean-where' } }, [BO.icon('folder-plus'), BO.t('export.clean.where')]);
    function go(dir) {
      clean = { running: true, pct: 0, etaSec: null, state: 'running' };
      renderClean();
      var payload = { id: selectedId, keepHevc: keepHevc };
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
    // A copy for the TV of a movie still waiting for review: say so before making it.
    function guarded(fn) {
      var it = BO.store.item(selectedId);
      function ask() { confirmCopy(function (yes) { if (yes) { fn(); } }); }
      if (!it || it.status === 'protected') { ask(); return; }
      BO.modal.confirm({ title: BO.t('export.clean.unreviewed.title'), body: BO.t('export.clean.unreviewed.text'), icon: 'alert',
        okLabel: BO.t('export.clean.unreviewed.ok'), cancelLabel: BO.t('library.review') }, function (yes) {
        if (yes) { ask(); } else { BO.router.go('review', { id: selectedId }); }
      });
    }
    start.addEventListener('click', function () { guarded(function () { go(null); }); });
    where.addEventListener('click', function () { pickFolder(function (d) { guarded(function () { go(d); }); }); });
    // HEVC can only be kept with a Mac's video chip (encoders.js); elsewhere the copy is H.264.
    if ((BO.store.get('boot') || {}).platform === 'darwin') {
      var hevc = BO.el('input', { 'class': 'bo-switch__input', type: 'checkbox', id: BO.nextId('hevc'), data: { setting: 'keepHevc' } });
      hevc.checked = keepHevc;
      hevc.addEventListener('change', function () { keepHevc = hevc.checked; });
      body.appendChild(BO.el('label', { 'class': 'bo-switch', attrs: { 'for': hevc.id } }, [hevc, BO.el('span', { 'class': 'bo-switch__track' }), BO.el('span', { 'class': 'bo-switch__label', text: BO.t('cleancopy.keepHevc') })]));
      body.appendChild(BO.el('p', { 'class': 'bo-caption', text: BO.t('cleancopy.keepHevcHelp') }));
    }
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
      // Round 3, N-R6: one line with a link, so the cards' buttons stay above the fold.
      var go = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', data: { act: 'review-first' } }, [BO.icon('eye'), BO.t('library.review')]);
      go.addEventListener('click', function () { BO.router.go('review', { id: cur.id }); });
      page.appendChild(BO.el('div', { 'class': 'bo-notice bo-notice--warning bo-export__waiting', data: { banner: 'waiting' } }, [BO.icon('alert'), BO.el('p', { text: BO.tn('export.waiting', cur.pending || 0) }), go]));
    }
    // Same order as the help: the clean copy is the easiest way to the TV.
    page.appendChild(BO.el('div', { 'class': 'bo-export__grid' }, [
      cleanCardEl(),
      exportCard('edl', 'tv', 'export:edl'),
      exportCard('json', 'download', 'export:json')
    ]));
  }

  BO.views['export'] = {
    init: function (section) {
      root = section;
      page = BO.el('div', { 'class': 'bo-page bo-export' });
      root.appendChild(page);
      BO.on('export:progress', function (p) {
        if (!p) { return; }
        if (p.state === 'running') {
          clean.running = true;
          clean.pct = typeof p.pct === 'number' ? p.pct : Math.round((p.done || 0) / Math.max(0.001, p.total || 1) * 100);
          clean.etaSec = typeof p.etaSec === 'number' ? p.etaSec : null;
        }
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
