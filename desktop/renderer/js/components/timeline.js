/* Review timeline (DESIGN 7.10): ruler, range track coloured by category (plus pattern and icon),
   blurred thumbnail strip, legend. Zoom 1x to 32x (buttons, Ctrl+wheel, + - 0 keys). The selected
   range gets edge handles (role=slider): drag, or Left/Right 0.5 s, Shift+arrow 5 s, Home/End to
   the neighbouring range or the movie edge.
   BO.timeline.create({duration, onSelect(id), onEdge(id, 'start'|'end', seconds)}). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var document = window.document;
  var MIN_LEN = 0.5;
  var STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

  function stateOf(r) { return r.review === 'approved' ? 'approved' : (r.review === 'rejected' ? 'rejected' : 'pending'); }

  function create(opts) {
    var o = opts || {};
    var duration = Math.max(1, o.duration || 1);
    var zoom = 1;
    var ranges = [];
    var selected = null;
    var stripUrls = [];
    var stripN = o.stripTiles || 24;
    var focusAfter = null;

    var zoomOut = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--sm bo-button--icon', type: 'button', attrs: { 'aria-label': BO.t('timeline.zoomOut') } }, BO.icon('minus'));
    var zoomIn = BO.el('button', { 'class': 'bo-button bo-button--secondary bo-button--sm bo-button--icon', type: 'button', attrs: { 'aria-label': BO.t('timeline.zoomIn') } }, BO.icon('plus'));
    var zoomFit = BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', text: BO.t('timeline.fit') });
    var zoomLabel = BO.el('span', { 'class': 'bo-caption bo-num bo-timeline__zoom', attrs: { 'aria-live': 'polite' } });
    var tools = BO.el('div', { 'class': 'bo-timeline__tools' }, [
      BO.el('span', { 'class': 'bo-overline', text: BO.t('timeline.title') }),
      BO.el('span', { 'class': 'bo-timeline__tools-right' }, [zoomLabel, zoomOut, zoomIn, zoomFit])
    ]);
    var ruler = BO.el('div', { 'class': 'bo-timeline__ruler', attrs: { 'aria-hidden': 'true' } });
    var track = BO.el('div', { 'class': 'bo-timeline__track' });
    var strip = BO.el('div', { 'class': 'bo-timeline__strip', attrs: { 'aria-hidden': 'true' } });
    var body = BO.el('div', { 'class': 'bo-timeline__body' }, [track, strip]);
    var canvas = BO.el('div', { 'class': 'bo-timeline__canvas' }, [ruler, body]);
    var scroll = BO.el('div', { 'class': 'bo-timeline__scroll' }, canvas);
    var legend = BO.el('div', { 'class': 'bo-legend' });
    var root = BO.el('div', { 'class': 'bo-timeline', attrs: { role: 'group', 'aria-label': BO.t('timeline.label') } }, [tools, scroll, legend]);

    function pct(t) { return (Math.max(0, Math.min(duration, t)) / duration * 100) + '%'; }

    function setZoom(z, anchorX) {
      var old = zoom;
      zoom = Math.max(1, Math.min(32, z));
      var w = scroll.clientWidth || 1;
      var ax = anchorX === undefined ? w / 2 : anchorX;
      var frac = (scroll.scrollLeft + ax) / (w * old);
      canvas.style.setProperty('--zoom', String(zoom));
      scroll.scrollLeft = frac * w * zoom - ax;
      zoomLabel.textContent = zoom === 1 ? '' : BO.t('timeline.zoomLevel', { z: Math.round(zoom * 10) / 10 });
      zoomOut.disabled = zoom <= 1;
      zoomIn.disabled = zoom >= 32;
      renderRuler();
    }

    zoomOut.addEventListener('click', function () { setZoom(zoom / 2); });
    zoomIn.addEventListener('click', function () { setZoom(zoom * 2); });
    zoomFit.addEventListener('click', function () { setZoom(1); });
    scroll.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) { return; }
      e.preventDefault();
      var rect = scroll.getBoundingClientRect();
      setZoom(e.deltaY < 0 ? zoom * 1.25 : zoom / 1.25, e.clientX - rect.left);
    }, { passive: false });
    root.addEventListener('keydown', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('bo-handle')) { return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * 2); } else if (e.key === '-') { e.preventDefault(); setZoom(zoom / 2); } else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    });

    function renderRuler() {
      BO.clear(ruler);
      var px = (scroll.clientWidth || 600) * zoom;
      var target = duration / Math.max(2, px / 110);
      var step = STEPS[STEPS.length - 1];
      var i;
      for (i = 0; i < STEPS.length; i++) { if (STEPS[i] >= target) { step = STEPS[i]; break; } }
      var useSeconds = duration < 3600 && step < 60;
      var t;
      for (t = 0; t <= duration + 0.001; t += step) {
        if (duration - t < step * 0.6 && t > 0) { break; }
        ruler.appendChild(BO.el('span', { 'class': 'bo-timeline__tick', vars: { '--x': pct(t) }, text: label(t, useSeconds) }));
      }
      ruler.appendChild(BO.el('span', { 'class': 'bo-timeline__tick', vars: { '--x': '100%' }, text: label(duration, useSeconds) }));
    }

    function label(t, secs) {
      if (secs || duration < 3600) { return BO.fmt.time(t); }
      var h = Math.floor(t / 3600);
      var m = Math.floor((t % 3600) / 60);
      return h + ':' + (m < 10 ? '0' : '') + m;
    }

    function neighbours(r) {
      var prevEnd = 0, nextStart = duration, i;
      for (i = 0; i < ranges.length; i++) {
        var x = ranges[i];
        if (x.id === r.id || x.review === 'rejected') { continue; }
        if (x.end <= r.start + 1e-6 && x.end > prevEnd) { prevEnd = x.end; }
        if (x.start >= r.end - 1e-6 && x.start < nextStart) { nextStart = x.start; }
      }
      return { min: prevEnd, max: nextStart };
    }

    function bounds(r, which) {
      var nb = neighbours(r);
      return which === 'start' ? { min: nb.min, max: r.end - MIN_LEN } : { min: r.start + MIN_LEN, max: nb.max };
    }

    function clamp(v, b) { return Math.max(b.min, Math.min(b.max, v)); }

    function handle(r, which, node) {
      var b = bounds(r, which);
      var v = which === 'start' ? r.start : r.end;
      var h = BO.el('span', {
        'class': 'bo-handle bo-handle--' + which,
        attrs: { role: 'slider', tabindex: '0', 'aria-label': BO.t(which === 'start' ? 'panel.starts' : 'panel.ends'),
          'aria-valuemin': b.min.toFixed(1), 'aria-valuemax': b.max.toFixed(1), 'aria-valuenow': v.toFixed(1), 'aria-valuetext': BO.fmt.time(v, true) },
        data: { edge: which }
      });
      h.addEventListener('keydown', function (e) {
        var step = e.shiftKey ? 5 : 0.5;
        var next = null;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { next = v - step; } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { next = v + step; } else if (e.key === 'Home') { next = b.min; } else if (e.key === 'End') { next = b.max; }
        if (next === null) { return; }
        e.preventDefault();
        next = clamp(next, b);
        if (Math.abs(next - v) < 1e-6) { return; }
        focusAfter = { id: r.id, edge: which };
        if (o.onEdge) { o.onEdge(r.id, which, Math.round(next * 1000) / 1000); }
      });
      h.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        h.classList.add('is-active');
        var rect = canvas.getBoundingClientRect();
        var cur = v;
        function move(ev) {
          cur = clamp((ev.clientX - rect.left) / rect.width * duration, b);
          var s = which === 'start' ? cur : r.start;
          var en = which === 'end' ? cur : r.end;
          node.style.setProperty('--s', pct(s));
          node.style.setProperty('--w', ((en - s) / duration * 100) + '%');
          h.setAttribute('aria-valuetext', BO.fmt.time(cur, true));
        }
        function up() {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
          h.removeEventListener('pointercancel', up);
          h.classList.remove('is-active');
          cur = Math.round(cur * 10) / 10;
          if (Math.abs(cur - v) >= 0.05 && o.onEdge) {
            focusAfter = { id: r.id, edge: which };
            o.onEdge(r.id, which, cur);
          }
        }
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      return h;
    }

    function renderTrack() {
      var active = document.activeElement;
      var hadFocus = active && root.contains(active) ? (active.getAttribute('data-edge') ? { id: selected, edge: active.getAttribute('data-edge') } : { id: active.getAttribute('data-range'), edge: null }) : null;
      if (focusAfter) { hadFocus = focusAfter; focusAfter = null; }
      BO.clear(track);
      ranges.forEach(function (r, idx) {
        var st = stateOf(r);
        var node = BO.el('div', {
          'class': 'bo-range bo-range--' + r.category + ' is-' + st + (r.id === selected ? ' is-selected' : ''),
          vars: { '--s': pct(r.start), '--w': ((r.end - r.start) / duration * 100) + '%' }
        });
        var bodyBtn = BO.el('button', {
          'class': 'bo-range__body', type: 'button',
          attrs: { 'aria-label': BO.t('timeline.rangeLabel', { category: BO.t('cat.' + r.category), state: BO.t('review.state.' + st), start: BO.fmt.time(r.start), end: BO.fmt.time(r.end) }),
            'aria-pressed': r.id === selected ? 'true' : 'false', 'data-range': r.id, tabindex: r.id === selected || (!selected && idx === 0) ? '0' : '-1' }
        }, [
          BO.el('span', { 'class': 'bo-range__icon' }, BO.icon('cat-' + r.category)),
          BO.el('span', { 'class': 'bo-range__state' }, st === 'approved' ? BO.icon('check') : (st === 'rejected' ? BO.icon('close') : null))
        ]);
        bodyBtn.addEventListener('click', function () { if (o.onSelect) { o.onSelect(r.id); } });
        bodyBtn.addEventListener('keydown', function (e) {
          var j = null;
          if (e.key === 'ArrowRight') { j = Math.min(ranges.length - 1, idx + 1); } else if (e.key === 'ArrowLeft') { j = Math.max(0, idx - 1); }
          if (j === null || j === idx) { return; }
          e.preventDefault();
          focusAfter = { id: ranges[j].id, edge: null };
          if (o.onSelect) { o.onSelect(ranges[j].id); }
        });
        node.appendChild(bodyBtn);
        if (r.id === selected) {
          node.appendChild(handle(r, 'start', node));
          node.appendChild(handle(r, 'end', node));
        }
        track.appendChild(node);
      });
      if (hadFocus && hadFocus.id) {
        var target = hadFocus.edge ? BO.qs('.bo-range.is-selected .bo-handle--' + hadFocus.edge, track) : BO.qs('[data-range="' + hadFocus.id + '"]', track);
        if (target) { BO.focus(target); }
      }
      renderStripFlags();
    }

    function renderLegend() {
      BO.clear(legend);
      var present = {};
      ranges.forEach(function (r) { present[r.category] = true; });
      BO.CATEGORIES.forEach(function (cat) {
        if (cat === 'other' && !present.other) { return; }
        legend.appendChild(BO.el('span', { 'class': 'bo-legend__item bo-cat--' + cat }, [BO.el('span', { 'class': 'bo-swatch bo-swatch--' + cat }), BO.icon('cat-' + cat), BO.t('cat.' + cat)]));
      });
    }

    function tileCategory(i) {
      var a = i * duration / stripN;
      var b = (i + 1) * duration / stripN;
      var j;
      for (j = 0; j < ranges.length; j++) {
        if (ranges[j].review !== 'rejected' && ranges[j].start < b && ranges[j].end > a) { return ranges[j].category; }
      }
      return null;
    }

    function renderStrip() {
      BO.clear(strip);
      strip.style.setProperty('--n', String(stripN));
      var i;
      for (i = 0; i < stripN; i++) {
        var tile = BO.el('span', { 'class': 'bo-strip-tile' });
        if (stripUrls[i]) { tile.appendChild(BO.el('img', { 'class': 'bo-strip-tile__img', attrs: { src: stripUrls[i], alt: '', draggable: 'false' } })); }
        strip.appendChild(tile);
      }
      renderStripFlags();
    }

    function renderStripFlags() {
      BO.qsa('.bo-strip-tile', strip).forEach(function (tile, i) {
        var cat = tileCategory(i);
        tile.className = 'bo-strip-tile' + (cat ? ' bo-strip-tile--' + cat + ' is-flagged' : '');
      });
    }

    function update(list, selectedId) {
      ranges = (list || []).slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      selected = selectedId || null;
      renderTrack();
      renderLegend();
    }

    function setStrip(urls) { stripUrls = urls || []; renderStrip(); }

    function reveal(id) {
      var node = BO.qs('[data-range="' + id + '"]', track);
      if (!node) { return; }
      var r = node.parentNode.getBoundingClientRect();
      var s = scroll.getBoundingClientRect();
      if (r.left < s.left || r.right > s.right) { scroll.scrollLeft += r.left - s.left - s.width / 3; }
    }

    if (window.ResizeObserver) {
      var ro = new window.ResizeObserver(BO.debounce(function () { renderRuler(); }, 80));
      ro.observe(scroll);
    }
    setZoom(1);
    renderStrip();
    return { el: root, update: update, setStrip: setStrip, reveal: reveal, setZoom: setZoom, focusRange: function (id) { focusAfter = { id: id, edge: null }; } };
  }

  BO.timeline = { create: create, MIN_LEN: MIN_LEN };
}(window));
