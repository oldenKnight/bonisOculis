/* Status pill (DESIGN 7.3): icon + words (+ colour), never colour alone. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  function create(item, scan) {
    var st = item.status;
    var cls, iconName, words, progress = null, spin = false;
    if (item.panicUnseen && st !== 'scanning' && st !== 'queued') {
      // Planner decision 3: a moment hidden during playback stays visible until the parent looks.
      return BO.el('span', { 'class': 'bo-pill bo-pill--attention', data: { status: st, panic: '' } }, [BO.icon('panic'), BO.el('span', { text: BO.t('status.panicUnseen') })]);
    }
    if (st === 'scanning' || st === 'queued') {
      var running = scan && scan.running === item.id;
      var pct = Math.round(((running ? scan.p : item.progress) || 0) * 100);
      cls = 'scanning';
      if (st === 'queued' && !running) {
        iconName = 'clock';
        words = BO.t('status.queued');
      } else if (scan && scan.paused && running) {
        iconName = 'pause';
        words = BO.t('status.scanPaused', { pct: pct });
      } else {
        iconName = 'rescan';
        spin = true;
        words = BO.t('status.scanning', { pct: pct });
        progress = BO.el('progress', { 'class': 'bo-pill__progress', attrs: { value: pct, max: 100, 'aria-hidden': 'true' } });
      }
    } else if (st === 'needsReview') {
      cls = 'review'; iconName = 'eye';
      if (item.outside === 'changed' || item.outside === 'imported') {
        words = BO.t(item.outside === 'changed' ? 'status.outsideChanged' : 'status.outsideImported');
      } else {
        words = item.pending ? BO.tn('status.toReview', item.pending) : BO.t(item.cleanPending ? 'status.cleanPending' : 'status.needsReview');
      }
    } else if (st === 'protected') {
      cls = 'protected'; iconName = 'shield-check';
      words = BO.tn('status.protected', item.enforced || 0);
    } else if (st === 'needsAttention') {
      cls = 'attention'; iconName = 'alert';
      words = BO.t(item.error === 'skipCorrupt' ? 'status.damaged' : (item.error === 'bundleDamaged' ? 'status.bundleDamaged' : 'status.attention'));
    } else {
      cls = 'not-scanned'; iconName = 'scan';
      words = BO.t('status.notScanned');
    }
    return BO.el('span', { 'class': 'bo-pill bo-pill--' + cls, data: { status: st } }, [
      BO.icon(iconName, spin ? 'bo-spin' : null), BO.el('span', { text: words }), progress
    ]);
  }

  BO.statusPill = { create: create };
}(window));
