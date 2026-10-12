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

  function render() {
    if (!root) { return; }
    BO.clear(root);
    if (!session) { return; }
    var kid = !!session.kidMode;
    var stopBtn = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--lg', type: 'button', data: { act: 'stop' } }, [BO.icon('close'), BO.t('player.stop')]);
    stopBtn.addEventListener('click', stop);
    var marks = BO.el('ul', { 'class': 'bo-marks', attrs: { 'aria-live': 'polite' } });
    session.marks.forEach(function (m) {
      marks.appendChild(BO.el('li', { 'class': 'bo-marks__item' }, [BO.icon(m.type === 'panic' ? 'panic' : (m.type === 'undo' ? 'undo' : 'flag')), BO.el('span', { text: markText(m) })]));
    });
    root.appendChild(BO.el('div', { 'class': 'bo-nowplaying' }, [
      BO.el('div', { 'class': 'bo-nowplaying__top' }, [BO.logo(true)]),
      BO.el('div', { 'class': 'bo-card bo-nowplaying__card' }, [
        BO.el('p', { 'class': 'bo-overline', text: BO.t('player.nowPlaying') }),
        BO.el('h1', { 'class': 'bo-nowplaying__title', text: session.title || '', attrs: { tabindex: '-1', 'data-view-heading': '' } }),
        BO.el('div', { 'class': 'bo-nowplaying__meta' }, [
          BO.el('span', { 'class': 'bo-pill bo-pill--protected bo-pill--lg' }, [BO.icon('shield-check'), BO.el('span', { text: BO.t('player.protectedScenes', { count: session.enforced || 0 }) })]),
          BO.el('span', { 'class': 'bo-nowplaying__state', attrs: { role: 'status' }, data: { state: session.state } }, [BO.icon(session.state === 'starting' ? 'clock' : 'play'), stateLine()])
        ]),
        BO.el('p', { 'class': 'bo-body-2', text: BO.t(kid ? 'nowPlaying.kidText' : 'nowPlaying.text') }),
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
      session = { id: ev.id, title: ev.title, enforced: ev.enforced, kidMode: ev.kidMode, panicKey: ev.panicKey, state: 'starting', marks: [] };
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
    } else if (ev.type === 'eof') {
      session.state = 'eof';
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
    active: function () { return !!session; }
  };
}(window));
