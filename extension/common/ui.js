/*
 * bonis oculis extension - small UI helpers for the popup and the options
 * page (BO.ui). ES5, DOM only, no innerHTML with data.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  var SVGNS = 'http://www.w3.org/2000/svg';
  var CAT_KEYS = { nudity: 'catNudity', sex: 'catSex', implied: 'catImplied', kissing: 'catKissing', gore: 'catGore', language: 'catLanguage', other: 'catOther' };
  var LEVEL_KEYS = { off: 'levelOff', light: 'levelLight', moderate: 'levelModerate', strict: 'levelStrict' };
  var toastTimer = null;

  function t(k, s) { return BO.i18n.t(k, s); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null) { e.textContent = text; }
    return e;
  }

  function icon(name) {
    var s = document.createElementNS(SVGNS, 'svg'), u = document.createElementNS(SVGNS, 'use');
    s.setAttribute('class', 'bo-icon');
    s.setAttribute('aria-hidden', 'true');
    u.setAttribute('href', '#bo-i-' + name);
    s.appendChild(u);
    return s;
  }

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  /* Level pickers for the six categories. onChange(levels) on every change. */
  function buildLevels(container, levels, onChange, idPrefix) {
    var cats = BO.store.CATEGORIES, current = {}, i;
    clear(container);
    container.classList.add('bo-levels');
    for (i = 0; i < cats.length; i++) { current[cats[i]] = levels[cats[i]]; }
    cats.forEach(function (cat) {
      var fs = el('fieldset', 'bo-level bo-cat--' + cat), legend = el('legend', 'bo-level__legend'), seg = el('div', 'bo-seg'), desc = el('p', 'bo-level__desc');
      legend.appendChild(icon('cat-' + cat));
      legend.appendChild(el('span', null, t(CAT_KEYS[cat])));
      fs.appendChild(legend);
      BO.store.LEVELS.forEach(function (lv, n) {
        var id = (idPrefix || 'lv') + '-' + cat + '-' + lv, input = el('input', 'bo-seg__input'), label = el('label', 'bo-seg__opt'), bars = el('span', 'bo-bars');
        input.type = 'radio';
        input.name = (idPrefix || 'lv') + '-' + cat;
        input.id = id;
        input.value = lv;
        input.checked = current[cat] === lv;
        label.htmlFor = id;
        bars.setAttribute('data-n', String(n));
        bars.setAttribute('aria-hidden', 'true');
        bars.appendChild(el('i'));
        bars.appendChild(el('i'));
        bars.appendChild(el('i'));
        label.appendChild(bars);
        label.appendChild(el('span', null, t(LEVEL_KEYS[lv])));
        input.addEventListener('change', function () {
          if (!input.checked) { return; }
          current[cat] = lv;
          desc.textContent = t(LEVEL_KEYS[lv] + 'Desc');
          onChange(JSON.parse(JSON.stringify(current)));
        });
        seg.appendChild(input);
        seg.appendChild(label);
      });
      desc.textContent = t(LEVEL_KEYS[current[cat]] + 'Desc');
      fs.appendChild(seg);
      fs.appendChild(desc);
      container.appendChild(fs);
    });
  }

  function chips(container, byCategory) {
    clear(container);
    Object.keys(byCategory || {}).forEach(function (cat) {
      var c = el('li', 'bo-chip bo-cat--' + cat);
      c.appendChild(icon('cat-' + (CAT_KEYS[cat] ? cat : 'other')));
      c.appendChild(el('span', null, t(CAT_KEYS[cat] || 'catOther') + ' ' + byCategory[cat]));
      container.appendChild(c);
    });
    container.hidden = !container.firstChild;
  }

  function toast(text, isError) {
    var box = document.getElementById('toast');
    if (!box) { return; }
    box.textContent = text;
    box.classList.toggle('is-error', !!isError);
    box.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { box.hidden = true; }, 5000);
  }

  /* "+1.5" / "-0.5" / "0", decimal point in both languages (DESIGN 13.7). */
  function fmtOffset(x) {
    var v = Math.round(x * 100) / 100;
    if (v === 0) { return '0'; }
    return (v > 0 ? '+' : '−') + String(Math.abs(v));
  }

  function langToggle(rootEl, current, onPick) {
    var btns = rootEl.querySelectorAll('[data-lang]'), i;
    var active = current === 'auto' ? BO.i18n.uiLanguage() : current;
    for (i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-lang') === active ? 'true' : 'false');
      btns[i].onclick = (function (b) { return function () { onPick(b.getAttribute('data-lang')); }; }(btns[i]));
    }
  }

  BO.ui = { el: el, icon: icon, clear: clear, buildLevels: buildLevels, chips: chips, toast: toast, fmtOffset: fmtOffset, langToggle: langToggle, CAT_KEYS: CAT_KEYS };
}(typeof self !== 'undefined' ? self : this));
