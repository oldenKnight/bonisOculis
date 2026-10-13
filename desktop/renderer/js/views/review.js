/* Review (PLAN 5.4, DESIGN 7.10-7.12, 8.2, 12): decide every flagged scene without watching it.
   Left: bar (Back, title, Mark as fully reviewed, Approve all), category summary, timeline with the
   blurred strip, list of scenes. Right: the scene panel (category, intensity, certainty, signal
   bars, action, note, edges +-0.5 s / +-5 s, Approve, Reject, hold to peek) or, with nothing
   selected, the parents card. Every change is saved at once; a toast offers Undo.
   Keys (planner decision 14): selecting a scene moves focus to "Skip this scene"; S skips, L lets it
   play, N / P go to the next / previous scene. The panel and the list say what will really happen
   with the current levels ("Below your Kissing level - will play unless you skip it"). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var document = window.document;
  var root = null;
  var mainCol = null;
  var panel = null;
  var bar = null;
  var summary = null;
  var listEl = null;
  var timeline = null;
  var id = null;
  var doc = null;
  var item = null;
  var selected = null;
  var thumbs = {};
  var savedToast = null;
  var toastTimer = null;
  var peekState = { holding: false, timer: null, thumb: null };
  var damaged = false;
  var focusPanel = false;
  var ACTIONS = ['skip', 'hide', 'blur', 'mute'];
  var STATE_PILL = { pending: ['review', 'eye', 'review.state.pending'], approved: ['protected', 'check', 'review.state.approved'], rejected: ['not-scanned', 'close', 'review.state.rejected'] };

  function duration() {
    var d = (doc && doc.media && doc.media.duration) || (item && item.duration) || 0;
    if (!d && doc) { doc.ranges.forEach(function (r) { if (r.end > d) { d = r.end; } }); }
    return d || 1;
  }

  function sorted() { return doc ? doc.ranges.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; }) : []; }

  function rangeById(rid) {
    var i;
    for (i = 0; doc && i < doc.ranges.length; i++) { if (doc.ranges[i].id === rid) { return doc.ranges[i]; } }
    return null;
  }

  function stateOf(r) { return r.review === 'approved' ? 'approved' : (r.review === 'rejected' ? 'rejected' : 'pending'); }

  // Scene cuts known from the scan: the fingerprint's list plus the cuts ranges were snapped to.
  function sceneCuts() {
    var out = [];
    var fp = doc && doc.media && doc.media.fingerprint;
    if (fp && fp.sceneCuts) { out = fp.sceneCuts.slice(); }
    (doc ? doc.ranges : []).forEach(function (r) {
      if (typeof r.cutStart === 'number') { out.push(r.cutStart); }
      if (typeof r.cutEnd === 'number') { out.push(r.cutEnd); }
    });
    return out;
  }

  function pending() { return doc ? doc.ranges.filter(function (r) { return r.review === 'pending'; }) : []; }

  function statePill(r) {
    var p = STATE_PILL[stateOf(r)];
    return BO.el('span', { 'class': 'bo-pill bo-pill--' + p[0] }, [BO.icon(p[1]), BO.el('span', { text: BO.t(p[2]) })]);
  }

  function span(r) { return BO.fmt.time(r.start) + ' – ' + BO.fmt.time(r.end); }

  // The levels that apply to this title ("For this movie" or the usual ones).
  function settings() { return BO.effective.settingsFor(item, BO.store.get('settings') || {}); }

  function eff(r) { return BO.effective.of(r, settings()); }

  // Round 3, N-R5: a level that is Off is not a threshold; say "off" instead of "below".
  function belowText(r) {
    var st = settings();
    if ((st.levels || {})[r.category] === 'off') { return BO.t(st.perMovie ? 'review.offMovie' : 'review.off', { category: BO.t('cat.' + r.category) }); }
    return BO.t('review.below', { category: BO.t('cat.' + r.category) });
  }

  /* --------------------------------------------------------------- saving */

  function showSaved(canUndo) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (savedToast) { savedToast.dismiss(); }
      savedToast = BO.toast.show({
        kind: 'success', title: BO.t('review.saved.title'), text: BO.t('review.saved.text'),
        actions: canUndo ? [{ label: BO.t('common.undo'), onClick: undo }] : []
      });
    }, 450);
  }

  function apply(data) {
    if (!data || !data.doc) { return; }
    doc = data.doc;
    if (data.item) { item = data.item; }
    if (selected && !rangeById(selected)) { selected = null; }
  }

  function mutate(channel, payload, opts) {
    var o = opts || {};
    payload.id = id;
    BO.invoke(channel, payload, function (r) {
      if (!r.ok) { BO.toast.error(r.error); load(false); return; }
      apply(r.data);
      if (o.after) { o.after(); }
      render();
      if (o.toast !== false) { showSaved(r.data.canUndo); }
    });
  }

  function undo() {
    BO.invoke('skip:undo', { id: id }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      apply(r.data);
      render();
      BO.toast.show({ kind: 'info', title: BO.t('review.undone') });
    });
  }

  function nextPendingAfter(r) {
    var list = sorted();
    var i, start = 0;
    for (i = 0; i < list.length; i++) { if (list[i].id === r.id) { start = i + 1; break; } }
    for (i = 0; i < list.length; i++) {
      var x = list[(start + i) % list.length];
      if (x.review === 'pending' && x.id !== r.id) { return x.id; }
    }
    return r.id;
  }

  function verdict(r, kind) {
    var nextId = nextPendingAfter(r);
    mutate(kind === 'approve' ? 'skip:approve' : 'skip:reject', { rangeIds: [r.id] }, {
      after: function () {
        selected = nextId;
        focusPanel = true;
        markSeen(nextId);
      }
    });
  }

  function bounds(r) {
    var prevEnd = 0, nextStart = duration();
    doc.ranges.forEach(function (x) {
      if (x.id === r.id || x.review === 'rejected') { return; }
      if (x.end <= r.start + 1e-6 && x.end > prevEnd) { prevEnd = x.end; }
      if (x.start >= r.end - 1e-6 && x.start < nextStart) { nextStart = x.start; }
    });
    return { start: { min: prevEnd, max: r.end - BO.timeline.MIN_LEN }, end: { min: r.start + BO.timeline.MIN_LEN, max: nextStart } };
  }

  function setEdge(rid, which, t) {
    var r = rangeById(rid);
    if (!r) { return; }
    var b = bounds(r)[which];
    var v = Math.round(Math.max(b.min, Math.min(b.max, t)) * 1000) / 1000;
    if (Math.abs(v - r[which]) < 1e-6) { return; }
    r[which] = v; /* optimistic, so fast repeated nudges build on each other */
    var patch = {};
    patch[which] = v;
    mutate('skip:edit', { rangeId: rid, patch: patch });
  }

  /* --------------------------------------------------------------- peek (DESIGN 12.3, D18) */

  function endPeek() {
    peekState.holding = false;
    clearTimeout(peekState.timer);
    if (peekState.thumb) { peekState.thumb.peek(null); }
    var btn = BO.qs('.bo-peek', panel);
    if (btn) { btn.classList.remove('is-active'); }
  }

  function startPeek(r, thumb, btn) {
    if (peekState.holding) { return; }
    peekState.holding = true;
    peekState.thumb = thumb;
    btn.classList.add('is-active');
    BO.invoke('skip:peek', { id: id, rangeId: r.id }, function (res) {
      if (!res.ok) {
        endPeek();
        if (res.error === 'pinNeeded') {
          BO.pinPad.ask({ purpose: 'peek', heading: BO.t('peek.pinTitle'), text: BO.t('peek.pinText') }, function (ok) {
            if (ok) { BO.toast.show({ kind: 'info', title: BO.t('peek.ready') }); BO.focus(btn); }
          });
        } else {
          BO.toast.error(res.error);
        }
        return;
      }
      if (!peekState.holding || selected !== r.id) { return; }
      thumb.peek(res.data);
      peekState.timer = setTimeout(endPeek, 8000);
    });
  }

  function peekButton(r, thumb) {
    var btn = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-peek', type: 'button', attrs: { title: BO.t('panel.peekTip') }, data: { act: 'peek' } },
      [BO.icon('eye'), BO.t('panel.peek'), BO.el('span', { 'class': 'bo-peek__ring' })]);
    btn.addEventListener('pointerdown', function (e) { if (e.button === 0) { startPeek(r, thumb, btn); } });
    btn.addEventListener('pointerup', endPeek);
    btn.addEventListener('pointerleave', endPeek);
    btn.addEventListener('pointercancel', endPeek);
    btn.addEventListener('blur', endPeek);
    btn.addEventListener('keydown', function (e) {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startPeek(r, thumb, btn); }
      if (e.key === 'Escape') { endPeek(); }
    });
    btn.addEventListener('keyup', function (e) { if (e.key === ' ' || e.key === 'Enter') { endPeek(); } });
    btn.addEventListener('click', function (e) { e.preventDefault(); });
    return btn;
  }

  /* --------------------------------------------------------------- panel */

  function section(titleKey, children) {
    return BO.el('section', { 'class': 'bo-panel__section' }, [titleKey ? BO.el('h3', { 'class': 'bo-panel__section-title', text: BO.t(titleKey) }) : null].concat(children));
  }

  function signalRow(labelKey, v) {
    var pct = Math.round((v || 0) * 100);
    return BO.el('div', { 'class': 'bo-signal' }, [BO.el('span', { text: BO.t(labelKey) }), BO.el('progress', { 'class': 'bo-progress', attrs: { value: pct, max: 100, 'aria-hidden': 'true' } }), BO.el('span', { 'class': 'bo-signal__value', text: pct + '%' })]);
  }

  function noteSection(r) {
    var holder = BO.el('div', { 'class': 'bo-note' });
    function view() {
      BO.clear(holder);
      holder.appendChild(BO.el('p', { 'class': 'bo-panel__note', text: BO.notes.text(r, BO.i18n.lang()) || BO.t(r.source === 'auto' ? 'panel.noNote' : 'panel.manualNote') }));
      holder.appendChild(BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', data: { act: 'edit-note' }, on: { click: edit } }, [BO.icon('edit'), BO.t('panel.editNote')]));
    }
    function edit() {
      BO.clear(holder);
      var fieldId = BO.nextId('note');
      var ta = BO.el('textarea', { 'class': 'bo-input bo-note__input', id: fieldId, attrs: { maxlength: '300', rows: '3' } });
      ta.value = BO.notes.text(r, BO.i18n.lang()) || '';
      var save = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--sm', type: 'button', text: BO.t('common.save') });
      var cancel = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', text: BO.t('common.cancel') });
      save.addEventListener('click', function () { mutate('skip:edit', { rangeId: r.id, patch: { note: ta.value } }); });
      cancel.addEventListener('click', function () { view(); });
      ta.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); view(); } });
      holder.appendChild(BO.el('label', { 'class': 'bo-field__label', attrs: { 'for': fieldId }, text: BO.t('panel.noteLabel') }));
      holder.appendChild(ta);
      holder.appendChild(BO.el('p', { 'class': 'bo-field__help', text: BO.t('panel.noteHelp') }));
      holder.appendChild(BO.el('div', { 'class': 'bo-toolbar' }, [save, cancel]));
      BO.focus(ta);
    }
    view();
    return holder;
  }

  function edgeRow(r, which, b) {
    var v = r[which];
    var lim = b[which];
    function nudge(delta, label) {
      var target = v + delta;
      var dis = delta < 0 ? v - lim.min < 0.05 : lim.max - v < 0.05;
      var btn = BO.el('button', { 'class': 'bo-nudge', type: 'button', disabled: dis, attrs: { 'aria-label': BO.t(label, { edge: BO.t(which === 'start' ? 'panel.starts' : 'panel.ends') }) }, data: { nudge: which + (delta > 0 ? '+' : '') + delta } },
        [BO.icon(delta < 0 ? 'minus' : 'plus'), String(Math.abs(delta))]);
      btn.addEventListener('click', function () { setEdge(r.id, which, target); });
      return btn;
    }
    return BO.el('div', { 'class': 'bo-edge' }, [
      BO.el('span', { 'class': 'bo-edge__label', text: BO.t(which === 'start' ? 'panel.starts' : 'panel.ends') }),
      BO.el('div', { 'class': 'bo-edge__ctl' }, [
        nudge(-5, 'panel.nudge.back5'), nudge(-0.5, 'panel.nudge.back'),
        BO.el('output', { 'class': 'bo-edge__time', text: BO.fmt.time(v, true), data: { edge: which } }),
        nudge(0.5, 'panel.nudge.fwd'), nudge(5, 'panel.nudge.fwd5')
      ])
    ]);
  }

  function renderPanelRange(r) {
    var st = stateOf(r);
    var thumb = BO.thumb.create({ category: r.category, src: thumbs[r.id] || null, kind: 'blurred' });
    var catGroup = BO.el('div', { 'class': 'bo-chip-group', attrs: { role: 'radiogroup', 'aria-label': BO.t('panel.category') } });
    var name = BO.nextId('pcat');
    BO.CATEGORIES.forEach(function (cat) {
      var input = BO.el('input', { type: 'radio', attrs: { name: name, value: cat } });
      input.checked = r.category === cat;
      input.addEventListener('change', function () { if (input.checked) { mutate('skip:edit', { rangeId: r.id, patch: { category: cat } }); } });
      catGroup.appendChild(BO.el('label', { 'class': 'bo-chip-choice' }, [input, BO.el('span', { 'class': 'bo-chip bo-chip--' + cat }, [BO.icon('cat-' + cat), BO.t('cat.' + cat), BO.el('span', { 'class': 'bo-chip__check' }, BO.icon('check'))])]));
    });
    var seg = BO.el('div', { 'class': 'bo-segmented bo-segmented--inline bo-segmented--actions', attrs: { role: 'group', 'aria-label': BO.t('panel.whenPlays') } });
    ACTIONS.forEach(function (a) {
      var b = BO.el('button', { 'class': 'bo-segmented__opt', type: 'button', attrs: { 'aria-pressed': r.action === a ? 'true' : 'false' }, data: { action: a } },
        [BO.icon({ skip: 'skip', hide: 'eye-off', blur: 'eye-off', mute: 'volume-off' }[a]), BO.t('action.' + a)]);
      b.addEventListener('click', function () { if (r.action !== a) { mutate('skip:edit', { rangeId: r.id, patch: { action: a } }); } });
      seg.appendChild(b);
    });
    var found;
    if (r.source === 'auto') {
      var sig = r.signals || {};
      found = [
        BO.el('dl', { 'class': 'bo-kv' }, [
          BO.el('dt', { text: BO.t('panel.intensity') }), BO.el('dd', null, [BO.parentsCard.dots(r.category, r.intensity || 1), BO.t(BO.parentsCard.WORDS[r.intensity || 1])]),
          BO.el('dt', { text: BO.t('panel.certainty') }), BO.el('dd', { 'class': 'bo-num', text: Math.round((r.confidence || 0) * 100) + '%' })
        ]),
        signalRow('panel.signal.picture', sig.frames),
        signalRow('panel.signal.words', Math.max(sig.subtitles || 0, sig.speech || 0, sig.captions || 0)),
        signalRow('panel.signal.sound', sig.audio)
      ];
    } else {
      found = [BO.el('p', { 'class': 'bo-body-2', text: BO.t(r.source === 'panic' ? 'panel.fromPanic' : (r.source === 'imported' ? 'panel.fromImport' : 'panel.fromMark')) })];
    }
    var b = bounds(r);
    var approve = BO.el('button', { 'class': 'bo-button bo-button--primary', type: 'button', attrs: { 'aria-pressed': st === 'approved' ? 'true' : 'false' }, data: { act: 'approve' } },
      [BO.icon('check'), BO.t(st === 'approved' ? 'panel.approved' : 'panel.approve')]);
    var reject = BO.el('button', { 'class': 'bo-button bo-button--secondary', type: 'button', attrs: { 'aria-pressed': st === 'rejected' ? 'true' : 'false' }, data: { act: 'reject' } },
      [BO.icon('close'), BO.t(st === 'rejected' ? 'panel.rejected' : 'panel.reject')]);
    approve.addEventListener('click', function () { if (st !== 'approved') { verdict(r, 'approve'); } });
    reject.addEventListener('click', function () { if (st !== 'rejected') { verdict(r, 'reject'); } });

    BO.clear(panel);
    panel.className = 'bo-panel bo-cat--' + r.category;
    panel.appendChild(BO.el('div', { 'class': 'bo-panel__header' }, [
      BO.el('div', { 'class': 'bo-panel__header-row' }, [BO.el('span', { 'class': 'bo-chip bo-chip--' + r.category }, [BO.icon('cat-' + r.category), BO.t('cat.' + r.category)]), statePill(r)]),
      BO.el('h2', { 'class': 'bo-panel__title', text: span(r), attrs: { 'aria-label': BO.t('panel.spanLabel', { start: BO.fmt.time(r.start), end: BO.fmt.time(r.end) }) } })
    ]));
    panel.appendChild(BO.el('div', { 'class': 'bo-panel__footer' }, [approve, reject, peekButton(r, thumb),
      BO.el('p', { 'class': 'bo-review__keys', attrs: { 'aria-hidden': 'true' } }, [
        kbd('S'), BO.t('review.key.skip'), kbd('L'), BO.t('review.key.letPlay'), kbd('N'), BO.t('review.key.next'), kbd('P'), BO.t('review.key.prev')])]));
    panel.appendChild(BO.el('div', { 'class': 'bo-panel__scroll' }, [
      section(null, [thumb.el, noteSection(r)]),
      section('panel.found', found),
      section('panel.category', [catGroup]),
      section('panel.whenPlays', [seg].concat(eff(r) === 'below' ?
        [BO.el('div', { 'class': 'bo-notice bo-notice--warning', data: { below: '' } }, [BO.icon('alert'), BO.el('p', { text: belowText(r) })])] :
        [BO.el('p', { 'class': 'bo-caption', text: BO.t(st === 'rejected' ? 'action.none.desc' : 'action.' + (eff(r) === 'letPlay' ? 'none' : eff(r)) + '.desc') })])),
      section('panel.edges', [edgeRow(r, 'start', b), edgeRow(r, 'end', b), BO.el('p', { 'class': 'bo-caption', text: BO.t('panel.edgesHint') })])
    ]));
    approve.setAttribute('aria-keyshortcuts', 'S');
    reject.setAttribute('aria-keyshortcuts', 'L');
  }

  function kbd(k) { return BO.el('kbd', { 'class': 'bo-kbd', text: k }); }

  function renderPanelOverview() {
    BO.clear(panel);
    panel.className = 'bo-panel';
    var n = pending().length;
    var scanned = !!(doc.scan && doc.scan.status && doc.scan.status !== 'none');
    var top = BO.el('div', { 'class': 'bo-panel__section' }, [
      BO.parentsCard.create({ compact: true, title: item.title, meta: [item.year, item.duration ? BO.fmt.duration(item.duration) : null].filter(function (x) { return x; }).join(' · '), doc: doc, settings: settings(), item: item })
    ]);
    var msg;
    if (damaged) {
      msg = BO.el('div', { 'class': 'bo-notice bo-notice--error' }, [BO.icon('alert'), BO.el('p', { text: BO.t('review.damaged') })]);
    } else if (item.outside === 'changed' || item.outside === 'imported') {
      // Board review A4/A5: a list from outside the app reaches kids only after this click.
      var trust = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--block', type: 'button', data: { act: 'trust' } }, [BO.icon('shield-check'), BO.t('review.trust')]);
      trust.addEventListener('click', function () {
        BO.modal.confirm({ title: BO.t('review.trust.title'), body: BO.tn('review.trust.text', n), okLabel: BO.t('review.trust'), okIcon: 'shield-check', icon: 'shield-check' }, function (yes) {
          if (yes) { mutate('skip:trust', {}); }
        });
      });
      msg = BO.el('div', { 'class': 'bo-review__clean', data: { outside: item.outside } }, [
        BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('alert'), BO.el('p', { text: BO.t('review.outside.' + item.outside) })]), trust]);
    } else if (item.cleanPending) {
      var ok = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--block', type: 'button', data: { act: 'approve-clean' } }, [BO.icon('shield-check'), BO.t('review.approveClean')]);
      ok.addEventListener('click', function () { mutate('skip:approveClean', {}); });
      msg = BO.el('div', { 'class': 'bo-review__clean' }, [
        BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('eye'), BO.el('p', { text: BO.t('review.clean.text') })]), ok]);
    } else if (!doc.ranges.length) {
      msg = BO.el('div', { 'class': 'bo-empty' }, [BO.el('span', { 'class': 'bo-empty__icon' }, BO.icon('check')), BO.el('h3', { 'class': 'bo-empty__title', text: BO.t(scanned ? 'review.empty.title' : 'review.notScanned.title') }), BO.el('p', { 'class': 'bo-empty__text', text: BO.t(scanned ? 'review.empty.text' : 'review.notScanned.text') })]);
    } else if (n) {
      msg = BO.el('div', { 'class': 'bo-notice' }, [BO.icon('info'), BO.el('p', { text: BO.tn('review.pick', n) })]);
    } else {
      msg = BO.el('div', { 'class': 'bo-notice' }, [BO.icon('shield-check'), BO.el('p', { text: BO.t('review.allDecided') })]);
    }
    panel.appendChild(BO.el('div', { 'class': 'bo-panel__header' }, [BO.el('h2', { 'class': 'bo-panel__title bo-panel__title--text', text: BO.t('review.overview') })]));
    panel.appendChild(BO.el('div', { 'class': 'bo-panel__scroll' }, [top, BO.el('div', { 'class': 'bo-panel__section' }, msg)]));
  }

  /* --------------------------------------------------------------- left column */

  function renderBar() {
    BO.clear(bar);
    var n = pending().length;
    var back = BO.el('button', { 'class': 'bo-button bo-button--ghost', type: 'button', data: { act: 'back' } }, [BO.icon('chevron-left'), BO.t('review.back')]);
    back.addEventListener('click', function () { BO.router.go('library'); });
    var complete = !!(doc.scan && doc.scan.status === 'complete');
    var mark = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--sm', type: 'button', disabled: complete && !n, data: { act: 'mark-reviewed' } }, [BO.icon('shield-check'), BO.t('review.markReviewed')]);
    // Round 3, P2: say how the movie was checked; the parents card repeats it honestly.
    mark.addEventListener('click', function () {
      function done(mode) { return function (close) { close(); mutate('skip:markReviewed', { mode: mode }, { after: function () { selected = null; } }); }; }
      BO.modal.open({
        title: BO.t('review.markReviewed.title'), icon: 'shield-check',
        body: [BO.el('p', { text: BO.t('review.markReviewed.text') })],
        actions: [
          { label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' },
          { label: BO.t('review.markReviewed.trusted'), kind: 'secondary', id: 'trusted', icon: 'check', onClick: done('trusted') },
          { label: BO.t('review.markReviewed.looked'), kind: 'primary', id: 'looked', icon: 'eye', onClick: done('looked') }
        ]
      });
    });
    var all = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--sm', type: 'button', disabled: !n, data: { act: 'approve-all' } }, [BO.icon('check'), n ? BO.tn('review.approveAll', n) : BO.t('review.approveAllNone')]);
    all.addEventListener('click', function () {
      BO.modal.confirm({ title: BO.tn('review.approveAll.title', n), body: BO.t('review.approveAll.text'), okLabel: BO.tn('review.approveAll', n), okIcon: 'check' }, function (yes) {
        if (yes) { mutate('skip:approve', { rangeIds: 'all' }); }
      });
    });
    bar.appendChild(back);
    bar.appendChild(BO.el('h1', { 'class': 'bo-review__title', text: item.title, attrs: { tabindex: '-1', 'data-view-heading': '' } }));
    // Round 3, N2.6: an icon button with a tooltip keeps the toolbar on one row at 1024x640.
    var ownLabel = BO.t(item.levels ? 'movieLevels.buttonActive' : 'movieLevels.button');
    var own = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--sm bo-button--icon bo-review__own', type: 'button', data: { act: 'movie-levels' },
      attrs: { 'aria-pressed': item.levels ? 'true' : 'false', 'aria-label': ownLabel, title: ownLabel } }, BO.icon('settings'));
    own.addEventListener('click', function () {
      BO.movieLevels.open(item, function (it) { if (it) { item = it; render(); } });
    });
    bar.appendChild(BO.el('div', { 'class': 'bo-toolbar' }, [own, mark, all]));
  }

  function renderSummary() {
    BO.clear(summary);
    var counts = {};
    doc.ranges.forEach(function (r) { counts[r.category] = (counts[r.category] || 0) + 1; });
    if (item.status) { summary.appendChild(BO.statusPill.create(item, BO.store.get('scan'))); }
    if (doc.ranges.length) { summary.appendChild(intensityFilter()); }
    BO.CATEGORIES.forEach(function (cat) {
      if (!counts[cat]) { return; }
      summary.appendChild(BO.el('span', { 'class': 'bo-chip bo-chip--' + cat }, [BO.icon('cat-' + cat), BO.t('review.chip', { category: BO.t('cat.' + cat), count: counts[cat] })]));
    });
  }

  // Round 3, P3: show only the strong scenes (or moderate and strong) in the list. A filter of the
  // view only: nothing about what is skipped changes. Hand and panic marks have no measured strength.
  var intensity = 'all';
  function shown(r) {
    if (intensity === 'all') { return true; }
    var n = r.source === 'auto' ? r.intensity || 0 : 0;
    return intensity === 'strong' ? n >= 3 : n >= 2;
  }

  function intensityFilter() {
    var group = BO.el('div', { 'class': 'bo-filter', attrs: { role: 'group', 'aria-label': BO.t('review.filter.label') } });
    [['all', 'review.filter.all'], ['moderate', 'review.filter.moderate'], ['strong', 'review.filter.strong']].forEach(function (f) {
      var b = BO.el('button', { 'class': 'bo-filter__opt', type: 'button', data: { intensity: f[0] }, attrs: { 'aria-pressed': intensity === f[0] ? 'true' : 'false' }, text: BO.t(f[1]) });
      b.addEventListener('click', function () { intensity = f[0]; renderSummary(); renderList(); });
      group.appendChild(b);
    });
    return group;
  }

  function renderList() {
    BO.clear(listEl);
    var all = sorted();
    var list = all.filter(shown);
    if (all.length && !list.length) {
      listEl.appendChild(BO.el('p', { 'class': 'bo-body-2 bo-review__filtered', data: { filtered: '' }, text: BO.tn('review.filter.none', all.length) }));
      return;
    }
    if (!list.length) { return; }
    var ul = BO.el('ul', { 'class': 'bo-range-list', attrs: { 'aria-label': BO.t('review.listLabel') } });
    list.forEach(function (r) {
      var st = stateOf(r);
      var b = BO.el('button', { 'class': 'bo-range-row bo-cat--' + r.category + (r.id === selected ? ' is-selected' : ''), type: 'button', attrs: { 'aria-pressed': r.id === selected ? 'true' : 'false' }, data: { range: r.id } }, [
        BO.el('span', { 'class': 'bo-range-row__icon' }, BO.icon('cat-' + r.category)),
        BO.el('span', null, [BO.el('span', { 'class': 'bo-range-row__title', text: BO.t('cat.' + r.category) }), BO.el('span', { 'class': 'bo-range-row__time', text: span(r) + ' · ' + BO.fmt.duration(r.end - r.start) }),
          eff(r) === 'below' ? BO.el('span', { 'class': 'bo-range-row__below', data: { below: '' } }, [BO.icon('alert', 'bo-icon--sm'), belowText(r)]) : null,
          r.source === 'panic' ? BO.el('span', { 'class': 'bo-range-row__panic' + (unseen(r.id) ? ' is-unseen' : ''), data: { panic: unseen(r.id) ? 'unseen' : 'seen' } },
            [BO.icon('panic', 'bo-icon--sm'), BO.t(unseen(r.id) ? 'review.panicUnseen' : 'review.panicBadge')]) : null]),
        statePill(r)
      ]);
      b.addEventListener('click', function () { select(r.id); });
      ul.appendChild(BO.el('li', null, b));
    });
    listEl.appendChild(ul);
  }

  function unseen(rid) {
    var pu = item && item.panicUnseen;
    return !!(pu && Array.isArray(pu.rangeIds) && pu.rangeIds.indexOf(rid) >= 0);
  }

  // Round 2, X7: the "A moment was hidden" flag goes only when the parent opens that scene.
  function markSeen(rid) {
    if (!rid || !unseen(rid)) { return; }
    BO.invoke('skip:seen', { id: id, rangeId: rid }, function (r) { if (r.ok && r.data) { item = r.data; renderSummary(); } });
  }

  function select(rid, viaTimelineKeys) {
    endPeek();
    selected = rid;
    markSeen(rid);
    focusPanel = !viaTimelineKeys;
    render();
    if (timeline && rid) { timeline.reveal(rid); }
  }

  function step(dir) {
    var list = sorted();
    if (!list.length) { return; }
    var i = -1, j;
    for (j = 0; j < list.length; j++) { if (list[j].id === selected) { i = j; } }
    var k = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + dir));
    select(list[k].id, false);
  }

  function onKey(e) {
    if (BO.router.current() !== 'review' || BO.modal.isOpen() || e.ctrlKey || e.metaKey || e.altKey) { return; }
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return; }
    var k = (e.key || '').toLowerCase();
    var r = selected ? rangeById(selected) : null;
    if (k === 'n') { e.preventDefault(); step(1); } else if (k === 'p') { e.preventDefault(); step(-1); } else if (k === 's' && r) {
      e.preventDefault();
      if (stateOf(r) !== 'approved') { verdict(r, 'approve'); }
    } else if (k === 'l' && r) {
      e.preventDefault();
      if (stateOf(r) !== 'rejected') { verdict(r, 'reject'); }
    }
  }

  function render() {
    if (!doc || !item) { return; }
    endPeek();
    renderBar();
    renderSummary();
    timeline.update(doc.ranges, selected, sceneCuts());
    renderList();
    var r = selected ? rangeById(selected) : null;
    if (r) { renderPanelRange(r); } else { renderPanelOverview(); }
    if (focusPanel && r) {
      focusPanel = false;
      BO.focus(BO.qs('[data-act="approve"]', panel));
    }
  }

  function build() {
    BO.clear(root);
    bar = BO.el('div', { 'class': 'bo-review__bar' });
    summary = BO.el('div', { 'class': 'bo-review__summary' });
    listEl = BO.el('div', { 'class': 'bo-review__list' });
    timeline = BO.timeline.create({
      duration: duration(),
      onSelect: function (rid, viaKeys) { select(rid, viaKeys); },
      onEdge: function (rid, which, t) { setEdge(rid, which, t); }
    });
    mainCol = BO.el('div', { 'class': 'bo-review__main' }, [bar, summary, timeline.el, listEl]);
    panel = BO.el('aside', { 'class': 'bo-panel', attrs: { 'aria-label': BO.t('panel.label') } });
    root.appendChild(mainCol);
    root.appendChild(panel);
  }

  function load(rebuild) {
    BO.invoke('skip:get', { id: id }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); BO.router.go('library'); return; }
      doc = r.data.doc;
      item = r.data.item;
      damaged = !!r.data.damaged;
      if (rebuild !== false) {
        build();
        thumbs = {};
        var ids = doc.ranges.map(function (x) { return x.id; });
        if (ids.length) {
          BO.invoke('skip:thumbs', { id: id, rangeIds: ids }, function (t) {
            if (t.ok && t.data) { thumbs = t.data; if (selected) { render(); } }
          });
        }
        BO.invoke('skip:strip', { id: id, n: 24 }, function (s) { if (s.ok && timeline) { timeline.setStrip(s.data); } });
      }
      if (r.data.tampered) { BO.toast.show({ kind: 'warning', title: BO.t('review.tampered.title'), text: BO.t('review.tampered.text') }); }
      render();
      var h = BO.qs('[data-view-heading]', root);
      if (h && rebuild !== false) { BO.focus(h); }
    });
  }

  BO.views.review = {
    init: function (sec) {
      root = sec;
      root.classList.add('bo-review');
      BO.store.subscribe('library', function () {
        if (BO.router.current() !== 'review' || !id) { return; }
        var it = BO.store.item(id);
        if (it && item && it.status !== item.status) { item = it; renderSummary(); }
      });
      BO.i18n.onChange(function () { if (BO.router.current() === 'review' && id) { load(true); } });
      document.addEventListener('visibilitychange', function () { if (document.hidden) { endPeek(); } });
      document.addEventListener('keydown', onKey);
      BO.store.subscribe('settings', function () { if (BO.router.current() === 'review' && doc) { render(); } });
    },
    show: function (params) {
      id = params && params.id ? params.id : id;
      selected = params && params.rangeId ? params.rangeId : null;
      load(true);
    },
    hide: function () { endPeek(); if (savedToast) { savedToast.dismiss(); savedToast = null; } }
  };
}(window));
