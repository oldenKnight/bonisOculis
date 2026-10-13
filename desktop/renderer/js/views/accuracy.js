/* Check accuracy (brief 6.5, LEDGER D13): a parent chooses a hand-marked .bonis.json for a title;
   the analyzer's evaluate compares it with the title's current skip file and this screen shows,
   per kind of scene, how much we caught, how much of what we flagged was right, the seconds missed
   and the false alarms, with a plain sentence for every column. The last result is kept per title.
   ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var page = null;
  var selectedId = null;
  var busy = false;
  var COLS = [
    { key: 'recall', kind: 'pct', label: 'acc.col.recall', help: 'acc.help.recall' },
    { key: 'precision', kind: 'pct', label: 'acc.col.precision', help: 'acc.help.precision' },
    { key: 'f1', kind: 'pct', label: 'acc.col.f1', help: 'acc.help.f1' },
    { key: 'secondsMissed', kind: 'sec', label: 'acc.col.missed', help: 'acc.help.missed' },
    { key: 'secondsFalselyFlagged', kind: 'sec', label: 'acc.col.false', help: 'acc.help.false' },
    { key: 'rangeHitRate', kind: 'pct', label: 'acc.col.hit', help: 'acc.help.hit' }
  ];

  function checkable() {
    return (BO.store.get('library') || []).filter(function (it) { return it.status === 'protected' || it.status === 'needsReview'; });
  }

  // DESIGN 13.7: "Oct 12, 2026" / "12 oct 2026".
  function dateText(d) { return d.toLocaleDateString(BO.i18n.lang(), { year: 'numeric', month: 'short', day: 'numeric' }).replace('.', ''); }

  function pct(v) { return v === null || v === undefined ? null : Math.round(v * 100) + '%'; }

  function cell(v, kind) {
    if (v === null || v === undefined) { return BO.el('td', { 'class': 'bo-acc__num bo-acc__na', attrs: { title: BO.t('acc.na') } }, [BO.el('span', { attrs: { 'aria-hidden': 'true' }, text: '—' }), BO.el('span', { 'class': 'bo-sr-only', text: BO.t('acc.na') })]); }
    return BO.el('td', { 'class': 'bo-acc__num', text: kind === 'pct' ? pct(v) : BO.fmt.duration(v) });
  }

  function table(rep) {
    var head = BO.el('tr', null, [BO.el('th', { attrs: { scope: 'col' }, text: BO.t('acc.col.kind') })].concat(COLS.map(function (c) {
      return BO.el('th', { 'class': 'bo-acc__num', attrs: { scope: 'col' }, text: BO.t(c.label) });
    })));
    var rows = [];
    var order = BO.CATEGORIES.filter(function (c) { return rep.categories[c]; }).concat(['all']);
    order.forEach(function (cat) {
      var r = rep.categories[cat];
      var name = cat === 'all' ? BO.el('th', { attrs: { scope: 'row' }, text: BO.t('acc.allKinds') }) :
        BO.el('th', { 'class': 'bo-cat--' + cat, attrs: { scope: 'row' } }, [BO.el('span', { 'class': 'bo-acc__cat' }, [BO.icon('cat-' + cat), BO.t('cat.' + cat)])]);
      rows.push(BO.el('tr', { 'class': cat === 'all' ? 'bo-acc__total' : null, data: { category: cat } }, [name].concat(COLS.map(function (c) { return cell(r[c.key], c.kind); }))));
    });
    return BO.el('div', { 'class': 'bo-acc__table-wrap' }, BO.el('table', { 'class': 'bo-acc__table' }, [
      BO.el('caption', { 'class': 'bo-sr-only', text: BO.t('acc.tableCaption') }), BO.el('thead', null, head), BO.el('tbody', null, rows)
    ]));
  }

  function summary(rep) {
    var all = rep.categories.all;
    if (!all.truthSeconds) { return BO.t('acc.summary.noTruth', { flagged: BO.fmt.duration(all.predSeconds || 0) }); }
    return BO.t('acc.summary', { caught: pct(all.recall), missed: BO.fmt.duration(all.secondsMissed), falseAlarms: BO.fmt.duration(all.secondsFalselyFlagged) });
  }

  function copyText(item, res) {
    var text = BO.t('acc.copyHeader', { title: item.title, date: res.at.slice(0, 10) }) + '\n\n' + res.markdown + '\n';
    BO.invoke('app:copyText', { text: text }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      BO.toast.show({ kind: 'success', title: BO.t('acc.copied') });
    });
  }

  function result(item) {
    var res = item.accuracy;
    if (!res || !res.report) {
      return BO.el('div', { 'class': 'bo-empty bo-card bo-card--flat' }, [
        BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('check')),
        BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('acc.empty.title') }),
        BO.el('p', { 'class': 'bo-empty__text', text: BO.t('acc.empty.text') })
      ]);
    }
    var copy = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', data: { act: 'copy' } }, [BO.icon('download'), BO.t('acc.copy')]);
    copy.addEventListener('click', function () { copyText(item, res); });
    var defs = BO.el('dl', { 'class': 'bo-acc__defs' });
    COLS.forEach(function (c) {
      defs.appendChild(BO.el('dt', { text: BO.t(c.label) }));
      defs.appendChild(BO.el('dd', { text: BO.t(c.help) }));
    });
    var at = new Date(res.at);
    var autoAt = res.autoAt ? new Date(res.autoAt) : null;
    return BO.el('section', { 'class': 'bo-card bo-acc__result', attrs: { 'aria-labelledby': 'acc-result-h' } }, [
      BO.el('h2', { 'class': 'bo-acc__h', id: 'acc-result-h', text: BO.t('acc.resultTitle') }),
      BO.el('p', { 'class': 'bo-body-2 bo-acc__compared', data: { compared: '' }, text: BO.t('acc.compared', { file: res.truthName, date: autoAt && !isNaN(autoAt.getTime()) ? dateText(autoAt) : '?' }) }),
      BO.el('p', { 'class': 'bo-lead bo-acc__summary', text: summary(res.report) }),
      res.sameCopy ? null : BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('alert'), BO.el('p', { text: BO.t('acc.otherCopy') })]),
      table(res.report),
      BO.el('h3', { 'class': 'bo-acc__sub', text: BO.t('acc.howToRead') }),
      defs,
      BO.el('div', { 'class': 'bo-notice' }, [BO.icon('info'), BO.el('p', { text: BO.t('acc.honest', { tolerance: res.report.tolerance === null ? 3 : res.report.tolerance }) })]),
      BO.el('p', { 'class': 'bo-caption', text: BO.t('acc.meta', { file: res.truthName, date: isNaN(at.getTime()) ? '' : dateText(at) }) }),
      BO.el('div', { 'class': 'bo-toolbar' }, [copy])
    ]);
  }

  function run() {
    if (busy || !selectedId) { return; }
    busy = true;
    render();
    BO.invoke('accuracy:run', { id: selectedId }, function (r) {
      busy = false;
      if (!r.ok) { render(); BO.toast.error(r.error); return; }
      if (r.data && r.data.canceled) { render(); return; }
      BO.app.refreshLibrary(function () {
        render();
        var h = BO.qs('#acc-result-h', page);
        if (h) { h.setAttribute('tabindex', '-1'); BO.focus(h); }
      });
    });
  }

  function render() {
    if (!page) { return; }
    BO.clear(page);
    var list = checkable();
    if (selectedId && !list.some(function (it) { return it.id === selectedId; })) { selectedId = null; }
    if (!selectedId && list.length) { selectedId = list[0].id; }
    page.appendChild(BO.el('header', { 'class': 'bo-page__header' }, [BO.el('div', null, [
      BO.el('h1', { 'class': 'bo-page__title', text: BO.t('acc.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } }),
      BO.el('p', { 'class': 'bo-page__sub', text: BO.t('acc.lead') })
    ])]));
    if (!list.length) {
      page.appendChild(BO.el('div', { 'class': 'bo-empty bo-card bo-card--flat' }, [
        BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('scan')),
        BO.el('h2', { 'class': 'bo-empty__title', text: BO.t('acc.noMovies.title') }),
        BO.el('p', { 'class': 'bo-empty__text', text: BO.t('acc.noMovies.text') })
      ]));
      return;
    }
    var sel = BO.el('select', { 'class': 'bo-input bo-select', id: BO.nextId('acc'), data: { act: 'movie' } });
    list.forEach(function (it) {
      var o = BO.el('option', { text: it.title, attrs: { value: it.id } });
      if (it.id === selectedId) { o.selected = true; }
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { selectedId = sel.value; render(); BO.focus(BO.qs('select', page)); });
    var pick = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', disabled: busy, data: { act: 'pick-truth' } },
      [BO.icon(busy ? 'clock' : 'upload'), BO.t(busy ? 'acc.running' : 'acc.pick')]);
    pick.addEventListener('click', run);
    page.appendChild(BO.el('div', { 'class': 'bo-card bo-acc__setup' }, [
      BO.el('div', { 'class': 'bo-field bo-acc__movie' }, [BO.el('label', { 'class': 'bo-field__label', attrs: { 'for': sel.id }, text: BO.t('export.movie') }), sel]),
      BO.el('p', { 'class': 'bo-body-2', text: BO.t('acc.how') }),
      BO.el('div', { 'class': 'bo-toolbar' }, [pick])
    ]));
    page.appendChild(result(BO.store.item(selectedId) || {}));
  }

  BO.views.accuracy = {
    init: function (section) {
      page = BO.el('div', { 'class': 'bo-page bo-acc' });
      section.appendChild(page);
      BO.i18n.onChange(function () { if (BO.router.current() === 'accuracy') { render(); } });
    },
    show: function (params) {
      if (params && params.id) { selectedId = params.id; }
      render();
    },
    hide: function () {}
  };
}(window));
