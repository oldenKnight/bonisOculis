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
  var lastChanged = {};   /* picker id prefix -> category changed last (survives a re-render) */

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

  /* Level pickers for the six categories, one line each (name + Off/Light/
     Moderate/Strict). One explanation slot of fixed height sits under the
     list and shows the row under the pointer, the focused row, or the row
     just changed, so the list stays short and never jumps; the "muted, not
     skipped" note always shows under Language. Each row's own description
     stays in the DOM (hidden) for aria-describedby.
     onChange(levels) on every change. */
  function buildLevels(container, levels, onChange, idPrefix) {
    var cats = BO.store.CATEGORIES, current = {}, i, pre = idPrefix || 'lv', slot = el('p', 'bo-levels__slot');
    clear(container);
    container.classList.add('bo-levels');
    slot.setAttribute('aria-hidden', 'true');
    function explain(cat) {
      slot.textContent = cat ? t(CAT_KEYS[cat]) + ': ' + t(LEVEL_KEYS[current[cat]] + 'Desc') : '';
    }
    function settle() { explain(lastChanged[pre] && current[lastChanged[pre]] ? lastChanged[pre] : null); }
    for (i = 0; i < cats.length; i++) { current[cats[i]] = levels[cats[i]]; }
    cats.forEach(function (cat) {
      var fs = el('div', 'bo-level bo-cat--' + cat), name = el('div', 'bo-level__name'), seg = el('div', 'bo-seg'), desc = el('p', 'bo-level__desc'), note;
      desc.id = pre + '-' + cat + '-desc';
      if (lastChanged[pre] === cat) { fs.classList.add('is-open'); }
      /* a div radiogroup, not a fieldset: a fieldset cannot share the parent's columns (subgrid) */
      fs.setAttribute('role', 'radiogroup');
      fs.setAttribute('aria-label', t(CAT_KEYS[cat]));
      name.setAttribute('aria-hidden', 'true');
      name.appendChild(icon('cat-' + cat));
      name.appendChild(el('span', null, t(CAT_KEYS[cat])));
      fs.appendChild(name);
      BO.store.LEVELS.forEach(function (lv, n) {
        var id = pre + '-' + cat + '-' + lv, input = el('input', 'bo-seg__input'), label = el('label', 'bo-seg__opt'), bars = el('span', 'bo-bars');
        input.type = 'radio';
        input.name = pre + '-' + cat;
        input.id = id;
        input.value = lv;
        input.checked = current[cat] === lv;
        input.setAttribute('aria-describedby', desc.id);
        label.htmlFor = id;
        bars.setAttribute('data-n', String(n));
        bars.setAttribute('aria-hidden', 'true');
        bars.appendChild(el('i'));
        bars.appendChild(el('i'));
        bars.appendChild(el('i'));
        label.appendChild(bars);
        label.appendChild(el('span', null, t(LEVEL_KEYS[lv])));
        input.addEventListener('change', function () {
          var open = container.querySelectorAll('.bo-level.is-open'), k;
          if (!input.checked) { return; }
          current[cat] = lv;
          desc.textContent = t(LEVEL_KEYS[lv] + 'Desc');
          for (k = 0; k < open.length; k++) { open[k].classList.remove('is-open'); }
          fs.classList.add('is-open');
          lastChanged[pre] = cat;
          explain(cat);
          onChange(JSON.parse(JSON.stringify(current)));
        });
        seg.appendChild(input);
        seg.appendChild(label);
      });
      desc.textContent = t(LEVEL_KEYS[current[cat]] + 'Desc');
      fs.appendChild(seg);
      fs.appendChild(desc);
      if (cat === 'language') {
        note = el('p', 'bo-level__note', t('languageMuteNote'));
        fs.appendChild(note);
      }
      fs.addEventListener('mouseenter', function () { explain(cat); });
      fs.addEventListener('focusin', function () { explain(cat); });
      container.appendChild(fs);
    });
    /* properties, not listeners: the container is rebuilt on every render */
    container.onmouseleave = settle;
    container.onfocusout = function (e) { if (!container.contains(e.relatedTarget)) { settle(); } };
    container.appendChild(slot);
    settle();
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
