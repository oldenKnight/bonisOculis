/* Now playing (PLAN 5.7): the movie plays in its own mpv window; this panel shows the title, how
   many scenes are protected, marks arriving live, the keys, and Stop. In kid mode it shows only
   the title, the count, the panic keys and Stop. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var session = null;
  var from = 'library';
  var fromParams = {};

  function stop() {
    var b = BO.qs('[data-act="stop"]', root);
    if (b) { b.disabled = true; }
    // Round 3, N-R1: if the idle time ran out during the movie, lock first (the movie goes on in
    // kid mode or stops), so Stop never hands over an unlocked library.
    if (session && !session.kidMode && BO.idle.expired()) {
      BO.invoke('pin:lock', { reason: 'idle' }, function () { BO.invoke('player:stop', {}, function () {}); });
      return;
    }
    BO.invoke('player:stop', {}, function () {});
  }

  function stateLine() {
    if (!session) { return ''; }
    if (session.state === 'starting') { return BO.t('nowPlaying.starting'); }
    if (session.state === 'eof') { return BO.t('player.ended'); }
    return BO.t('nowPlaying.playing');
  }

  function markText(m) {
    if (m.type === 'mark') { return BO.t('player.markAdded', { start: BO.fmt.time(m.range.start), end: BO.fmt.time(m.range.end) }); }
    if (m.type === 'undo') { return BO.t('player.markUndone'); }
    return BO.t('player.panicSaved');
  }

  function categoryPicker(m) {
    var sel = BO.el('select', { 'class': 'bo-input bo-select bo-select--sm', data: { markCategory: m.range.id }, attrs: { 'aria-label': BO.t('hand.kind') } });
    BO.CATEGORIES.forEach(function (c) {
      var o = BO.el('option', { text: BO.t('cat.' + c), attrs: { value: c } });
      if ((m.range.category || 'other') === c) { o.selected = true; }
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var v = sel.value;
      BO.invoke('truth:setCategory', { id: session.id, rangeId: m.range.id, category: v }, function (r) {
        if (!r.ok) { BO.toast.error(r.error); return; }
        m.range.category = v;
      });
    });
    return sel;
  }

  function render() {
    if (!root) { return; }
    BO.clear(root);
    if (!session) { return; }
    var kid = !!session.kidMode;
    var stopBtn = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--lg', type: 'button', data: { act: 'stop' } }, [BO.icon('close'), BO.t('player.stop')]);
    stopBtn.addEventListener('click', stop);
    var marks = BO.el('ul', { 'class': 'bo-marks', attrs: { 'aria-live': 'polite' } });
    session.marks.forEach(function (m) {
      var li = BO.el('li', { 'class': 'bo-marks__item' }, [BO.icon(m.type === 'panic' ? 'panic' : (m.type === 'undo' ? 'undo' : 'flag')), BO.el('span', { text: markText(m) })]);
      // Hand-marking (X13): say what kind of scene it was, right after the I / O pair.
      if (m.handMark && m.type === 'mark') { li.appendChild(categoryPicker(m)); }
      marks.appendChild(li);
    });
    root.appendChild(BO.el('div', { 'class': 'bo-nowplaying' }, [
      BO.el('div', { 'class': 'bo-nowplaying__top' }, [BO.logo(true)]),
      BO.el('div', { 'class': 'bo-card bo-nowplaying__card' }, [
        BO.el('p', { 'class': 'bo-overline', text: BO.t('player.nowPlaying') }),
        BO.el('h1', { 'class': 'bo-nowplaying__title', text: session.title || '', attrs: { tabindex: '-1', 'data-view-heading': '' } }),
        BO.el('div', { 'class': 'bo-nowplaying__meta' }, [
          session.unprotected || !session.enforced ?
            BO.el('span', { 'class': 'bo-pill bo-pill--attention bo-pill--lg', data: { pill: 'nothing' } }, [BO.icon('alert'), BO.el('span', { text: BO.t(session.unprotected ? 'nowPlaying.unprotected' : 'nowPlaying.nothingSkipped') })]) :
            BO.el('span', { 'class': 'bo-pill bo-pill--protected bo-pill--lg', data: { pill: 'skips' } }, [BO.icon('shield-check'), BO.el('span', { text: BO.tn('nowPlaying.willSkip', session.enforced) })]),
          BO.el('span', { 'class': 'bo-nowplaying__state', attrs: { role: 'status' }, data: { state: session.state } }, [BO.icon(session.state === 'starting' ? 'clock' : 'play'), stateLine()])
        ]),
        BO.el('p', { 'class': 'bo-nowplaying__panic' }, [BO.el('kbd', { 'class': 'bo-kbd', text: String(session.panicKey || 'p').toUpperCase() }), BO.t('nowPlaying.panicHint')]),
        session.handMark ? BO.el('div', { 'class': 'bo-notice bo-notice--warning', data: { handmark: '' } }, [BO.icon('flag'), BO.el('p', { text: BO.t('hand.banner') })]) : null,
        BO.el('p', { 'class': 'bo-body-2', text: BO.t(kid ? 'nowPlaying.kidText' : (session.handMark ? 'hand.text' : 'nowPlaying.text')) }),
        BO.el('div', { 'class': 'bo-nowplaying__actions' }, stopBtn)
      ]),
      kid ? null : BO.el('section', { 'class': 'bo-card bo-nowplaying__marks', attrs: { 'aria-labelledby': 'np-marks' } }, [
        BO.el('h2', { 'class': 'bo-nowplaying__h', id: 'np-marks', text: BO.t('nowPlaying.marks') }),
        session.marks.length ? marks : BO.el('p', { 'class': 'bo-body-2', text: BO.t('nowPlaying.noMarks') })
      ]),
      BO.el('section', { 'class': 'bo-card bo-nowplaying__keys', attrs: { 'aria-labelledby': 'np-keys' } }, [
        BO.el('h2', { 'class': 'bo-nowplaying__h', id: 'np-keys', text: BO.t('player.hotkeys') }),
        BO.hotkeys.create({ panicKey: session.panicKey, kid: kid })
      ])
    ]));
  }

  function onEvent(ev) {
    if (!ev) { return; }
    if (ev.type === 'starting') {
      if (BO.router.current() !== 'player') {
        from = BO.router.current() || 'library';
        fromParams = BO.router.params() || {};
      }
      session = { id: ev.id, title: ev.title, enforced: ev.enforced, kidMode: ev.kidMode, panicKey: ev.panicKey, unprotected: !!ev.unprotected, handMark: !!ev.handMark, state: 'starting', marks: [] };
      BO.router.go('player');
      return;
    }
    if (!session) { return; }
    if (ev.type === 'ready') {
      session.state = 'playing';
      if (typeof ev.enforced === 'number') { session.enforced = ev.enforced; }
      render();
    } else if (ev.type === 'timepos') {
      if (session.state !== 'playing') { session.state = 'playing'; render(); }
    } else if (ev.type === 'kidMode') {
      // Locked while playing: the same movie goes on in kid mode, without the parent's marks.
      session.kidMode = true;
      session.marks = [];
      render();
    } else if (ev.type === 'eof') {
      session.state = 'eof';
      render();
    } else if (ev.handMark && ev.type === 'undo') {
      session.marks = session.marks.filter(function (m) { return !(m.range && m.range.id === ev.rangeId); });
      render();
    } else if (ev.type === 'mark' || ev.type === 'undo' || (ev.type === 'panic' && ev.phase === 'end')) {
      session.marks.unshift(ev);
      if (ev.type === 'panic') { BO.toast.show({ kind: 'success', title: BO.t('player.panicSaved') }); }
      render();
    } else if (ev.type === 'ended') {
      session = null;
      var back = BO.store.get('locked') ? 'kid' : (from === 'player' || from === 'setup' ? 'library' : from);
      BO.router.go(back, back === from ? fromParams : {});
    }
  }

  BO.views.player = {
    init: function (section) {
      root = section;
      root.classList.add('bo-player-view');
      BO.i18n.onChange(function () { if (BO.router.current() === 'player') { render(); } });
    },
    show: function () { render(); },
    hide: function () {},
    onEvent: onEvent,
    active: function () { return !!session; },
    // A movie is playing (not stopped, not resting on its last frame).
    playing: function () { return !!session && session.state !== 'eof'; }
  };
}(window));
