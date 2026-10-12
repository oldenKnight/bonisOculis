/* Scan queue drawer (DESIGN 7.9): a native <details> docked at the bottom of the main column.
   Collapsed: what is scanning, stage, percent, time left, Pause/Resume. Open: the queue with a
   remove button per row. BO.queueDrawer.create() -> {el, update(scanStatus, items)}. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  function etaText(eta) {
    if (typeof eta !== 'number' || eta <= 0) { return null; }
    if (eta < 60) { return BO.t('drawer.etaUnderMinute'); }
    return BO.t('drawer.eta', { min: Math.round(eta / 60) });
  }

  function stageText(stage) { return stage ? BO.t('stage.' + stage) : BO.t('stage.starting'); }

  function create() {
    var details = BO.el('details', { 'class': 'bo-drawer bo-drawer--dock', id: 'drawer' });
    var summary = BO.el('summary', { 'class': 'bo-drawer__bar' });
    var list = BO.el('ul', { 'class': 'bo-drawer__list', attrs: { 'aria-label': '' } });
    details.appendChild(summary);
    details.appendChild(list);
    var last = { scan: null, items: [] };

    function pauseButton(scan) {
      var paused = scan.paused && scan.pauseReason === 'user';
      var b = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--sm', type: 'button', data: { drawer: paused ? 'resume' : 'pause' } },
        [BO.icon(paused ? 'play' : 'pause'), BO.t(paused ? 'drawer.resume' : 'drawer.pause')]);
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        BO.invoke(paused ? 'scan:resume' : 'scan:pause', {}, function (r) { if (!r.ok) { BO.toast.error(r.error); } });
      });
      return b;
    }

    function update(scan, items) {
      last.scan = scan; last.items = items || [];
      var byId = {};
      last.items.forEach(function (it) { byId[it.id] = it; });
      var s = scan || { queue: [], running: null };
      var queue = (s.queue || []).filter(function (id) { return byId[id]; });
      var running = s.running && byId[s.running] ? byId[s.running] : null;
      var pct = Math.round((s.p || 0) * 100);
      var title, sub, iconName, spin = false;
      if (running && s.paused) {
        iconName = 'pause';
        title = BO.t('drawer.pausedTitle', { title: running.title });
        sub = BO.t('drawer.reason.' + (s.pauseReason || 'user'));
      } else if (running) {
        iconName = 'rescan'; spin = true;
        title = BO.t('drawer.scanningTitle', { title: running.title });
        sub = [stageText(s.stage), pct + '%', etaText(s.eta)].filter(function (x) { return x; }).join(' · ');
      } else if (queue.length && s.paused) {
        iconName = 'pause';
        title = BO.t('drawer.title');
        sub = BO.t('drawer.reason.' + (s.pauseReason || 'user'));
      } else if (queue.length) {
        iconName = 'clock';
        title = BO.t('drawer.title');
        sub = BO.tn('drawer.waiting', queue.length);
      } else {
        iconName = 'check';
        title = BO.t('drawer.title');
        sub = last.items.length ? BO.t('drawer.allDone') : BO.t('drawer.nothing');
      }
      BO.clear(summary);
      summary.appendChild(BO.icon(iconName, spin ? 'bo-spin' : null));
      summary.appendChild(BO.el('span', null, [BO.el('span', { 'class': 'bo-drawer__title', text: title }), BO.el('span', { 'class': 'bo-drawer__sub', text: sub })]));
      if (running) { summary.appendChild(BO.el('progress', { 'class': 'bo-progress', attrs: { value: pct, max: 100, 'aria-label': pct + '%' } })); }
      if (queue.length) { summary.appendChild(pauseButton(s)); }
      summary.appendChild(BO.icon('chevron-down', 'bo-drawer__chevron'));

      BO.clear(list);
      list.setAttribute('aria-label', BO.t('drawer.listLabel'));
      if (!queue.length) {
        list.appendChild(BO.el('li', { 'class': 'bo-queue-item' }, [BO.el('span'), BO.el('span', { 'class': 'bo-queue-item__status', text: BO.t('drawer.emptyList') })]));
      }
      queue.forEach(function (id, i) {
        var it = byId[id];
        var active = running && running.id === id;
        var status = active ? (s.paused ? BO.t('drawer.reason.' + (s.pauseReason || 'user')) : stageText(s.stage) + ' · ' + pct + '%') : (i === (running ? 1 : 0) ? BO.t('drawer.upNext') : BO.t('drawer.waitingOne'));
        var rm = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--icon bo-button--sm', type: 'button', attrs: { 'aria-label': BO.t('drawer.remove', { title: it.title }) } }, BO.icon('close'));
        rm.addEventListener('click', function () { BO.invoke('scan:cancel', { id: id }, function (r) { if (!r.ok) { BO.toast.error(r.error); } }); });
        list.appendChild(BO.el('li', { 'class': 'bo-queue-item' + (active ? ' is-active' : '') + (active && s.paused ? ' is-paused' : '') }, [
          BO.el('span', { 'class': 'bo-queue-item__no', text: String(i + 1) }),
          BO.el('span', null, [BO.el('span', { 'class': 'bo-queue-item__title', text: it.title }), BO.el('span', { 'class': 'bo-queue-item__status', text: status })]),
          active ? BO.el('progress', { 'class': 'bo-progress', attrs: { value: pct, max: 100, 'aria-label': pct + '%' } }) : null,
          rm
        ]));
      });
    }

    BO.i18n.onChange(function () { update(last.scan, last.items); });
    return { el: details, update: update };
  }

  BO.queueDrawer = { create: create };
}(window));
