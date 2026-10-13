/* Bootstrap: loads the app state and strings from main, builds the shell (sidebar, drawer),
   wires main events, and picks the first screen: setup, kid mode or the library. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var document = window.document;
  var drawer = null;

  function setKidMode(locked) {
    BO.store.set('locked', !!locked);
    if (locked) { document.documentElement.setAttribute('data-mode', 'kid'); } else { document.documentElement.removeAttribute('data-mode'); }
  }

  function applyMotion(settings) {
    if (settings && settings.reduceMotion) { document.documentElement.setAttribute('data-motion', 'reduce'); } else { document.documentElement.removeAttribute('data-motion'); }
  }

  function refreshLibrary(cb) {
    BO.invoke('library:list', {}, function (r) {
      if (r.ok) { BO.store.set('library', r.data || []); }
      if (cb) { cb(); }
    });
  }

  function updateBadge() {
    var n = (BO.store.get('library') || []).filter(function (it) { return it.status === 'needsReview'; }).length;
    var badge = BO.qs('#nav-review-badge');
    if (badge) { badge.textContent = String(n); badge.hidden = !n; }
  }

  function addResult(res) {
    if (!res) { return; }
    var added = (res.added || []).length;
    var dup = (res.duplicates || []).length;
    var failed = res.failed || [];
    if (added) { BO.toast.show({ kind: 'success', title: BO.tn('add.added', added), text: BO.tn('add.scanning', added) }); }
    if (dup) { BO.toast.show({ kind: 'info', title: BO.tn('add.duplicate', dup) }); }
    if (failed.length) {
      var reason = failed[0].reason === 'notFound' ? 'notFound' : 'notVideo';
      BO.toast.show({ kind: 'error', title: BO.t('add.failed.' + reason + '.title'), text: BO.t('add.failed.' + reason + '.text') });
    }
    refreshLibrary();
  }

  function pickMovies(cb) {
    BO.invoke('library:pick', {}, function (r) {
      if (!r.ok) { BO.toast.error(r.error); if (cb) { cb(null); } return; }
      if (!r.data.canceled) { addResult(r.data); }
      if (cb) { cb(r.data); }
    });
  }

  function addPaths(paths) {
    if (BO.store.get('locked')) { return; }
    var view = BO.router.current();
    if (view === 'setup' && !BO.views.setup.acceptsFiles()) { return; }
    BO.invoke('library:add', { paths: paths }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      addResult(r.data);
      if (view === 'setup' && r.data.added && r.data.added.length) { BO.views.setup.onFilesAdded(); }
    });
  }

  function lock() {
    BO.invoke('pin:lock', {}, function (r) { if (!r.ok) { BO.toast.error(r.error); } });
  }

  function buildShell() {
    var shell = BO.qs('#shell');
    var nav = BO.qs('#nav');
    var items = [
      { nav: 'library', icon: 'library', key: 'nav.library', go: function () { BO.router.go('library'); } },
      { nav: 'review', icon: 'eye', key: 'nav.review', badge: true, go: function () { BO.router.go('library', { filter: 'review' }); } },
      { nav: 'export', icon: 'tv', key: 'nav.export', go: function () { BO.router.go('export'); } },
      { nav: 'settings', icon: 'settings', key: 'nav.settings', go: function () { BO.router.go('settings'); } },
      { nav: 'help', icon: 'help', key: 'nav.help', go: function () { BO.router.go('help'); } }
    ];
    BO.clear(nav);
    items.forEach(function (it) {
      var b = BO.el('button', { 'class': 'bo-nav__item', type: 'button', data: { nav: it.nav }, attrs: { title: BO.t(it.key) } }, [
        BO.icon(it.icon), BO.el('span', { 'class': 'bo-nav__label', text: BO.t(it.key) }),
        it.badge ? BO.el('span', { 'class': 'bo-nav__badge', id: 'nav-review-badge', hidden: true }) : null
      ]);
      b.addEventListener('click', it.go);
      nav.appendChild(b);
    });
    var brand = BO.qs('#brand');
    BO.clear(brand);
    var full = BO.logo(true);
    full.classList.add('bo-sidebar__brand-full');
    var mark = BO.logo(false);
    mark.classList.add('bo-sidebar__brand-mark');
    brand.appendChild(full);
    brand.appendChild(mark);
    var foot = BO.qs('#sidebar-foot');
    BO.clear(foot);
    var lockBtn = BO.el('button', { 'class': 'bo-nav__item', type: 'button', data: { nav: 'lock' }, attrs: { title: BO.t('nav.lock') } }, [BO.icon('lock'), BO.el('span', { 'class': 'bo-nav__label', text: BO.t('nav.lock') })]);
    lockBtn.addEventListener('click', lock);
    foot.appendChild(lockBtn);
    if (!drawer) {
      drawer = BO.queueDrawer.create();
      shell.appendChild(drawer.el);
    }
    drawer.update(BO.store.get('scan'), BO.store.get('library'));
    updateBadge();
    var cur = BO.router.current();
    if (cur) {
      BO.qsa('.bo-nav__item[data-nav]', nav).forEach(function (n) {
        var on = n.getAttribute('data-nav') === cur && !(cur === 'library' && (BO.router.params() || {}).filter === 'review');
        if (cur === 'library' && (BO.router.params() || {}).filter === 'review' && n.getAttribute('data-nav') === 'review') { on = true; }
        if (on) { n.setAttribute('aria-current', 'page'); }
      });
    }
  }

  function firstView(state) {
    if (!state.setupDone) { BO.router.go('setup'); return; }
    if (state.player && state.player.state !== 'idle' && state.player.id) {
      BO.router.go(state.locked ? 'kid' : 'library');
      return;
    }
    BO.router.go(state.locked ? 'kid' : 'library');
  }

  function wireEvents() {
    BO.on('library:changed', function (items) {
      if (items) { BO.store.set('library', items); } else if (!BO.store.get('locked')) { refreshLibrary(); } else { BO.views.kid.refresh(); }
    });
    BO.on('scan:progress', function (s) { BO.store.set('scan', s); });
    BO.on('player:event', function (ev) { BO.views.player.onEvent(ev); });
    BO.on('toast', function (ev) {
      // Kid mode stays quiet about scans; player and data-safety messages still show.
      if (BO.store.get('locked') && ev && /^toast\.scan/.test(ev.key || '')) { return; }
      BO.toast.fromMain(ev);
    });
    BO.on('app:locked', function (ev) {
      setKidMode(ev && ev.locked);
      if (ev && ev.locked) {
        BO.router.go('kid');
      } else {
        refreshLibrary(function () {
          BO.invoke('settings:get', {}, function (r) { if (r.ok) { BO.store.set('settings', r.data); } });
          BO.invoke('scan:status', {}, function (r) { if (r.ok) { BO.store.set('scan', r.data); } });
          BO.router.go('library');
        });
      }
    });
    BO.on('app:navigate', function (ev) { if (ev && ev.view && !BO.store.get('locked') && BO.views[ev.view]) { BO.router.go(ev.view, ev.params || {}); } });
    BO.on('files:dropped', addPaths);
    BO.store.subscribe('library', function (items) { updateBadge(); if (drawer) { drawer.update(BO.store.get('scan'), items); } });
    BO.store.subscribe('scan', function (s) { if (drawer) { drawer.update(s, BO.store.get('library')); } });
    BO.store.subscribe('settings', applyMotion);
    BO.i18n.onChange(function () { BO.i18n.apply(document); buildShell(); });
  }

  function boot() {
    wireEvents();
    BO.dropZone.installOverlay(function () {
      var v = BO.router.current();
      return !BO.store.get('locked') && v !== 'kid' && v !== 'player' && (v !== 'setup' || BO.views.setup.acceptsFiles());
    });
    BO.idle.start();
    BO.invoke('app:state', {}, function (r) {
      if (!r.ok) { return; }
      var st = r.data;
      BO.store.set('boot', st);
      BO.i18n.set(st.strings, st.lang);
      BO.i18n.apply(document);
      setKidMode(st.locked);
      BO.store.set('settings', st.settings);
      if (st.scan) { BO.store.set('scan', st.scan); }
      buildShell();
      (st.toasts || []).forEach(function (t) { BO.toast.fromMain(t); });
      if (st.locked) {
        BO.store.set('library', []);
        firstView(st);
      } else {
        refreshLibrary(function () { firstView(st); });
      }
    });
  }

  BO.app = { pickMovies: pickMovies, addPaths: addPaths, lock: lock, refreshLibrary: refreshLibrary };

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
}(window));
