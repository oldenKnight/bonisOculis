/* Overflow menu for title cards: role=menu under its button, arrow keys move, Escape or a click
   outside closes and returns focus. BO.popupMenu.open(button, [{label, icon, onClick, danger}]). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var document = window.document;
  var openMenu = null;

  function close() {
    if (!openMenu) { return; }
    var m = openMenu;
    openMenu = null;
    document.removeEventListener('mousedown', m.outside, true);
    if (m.el.parentNode) { m.el.parentNode.removeChild(m.el); }
    m.button.setAttribute('aria-expanded', 'false');
    if (m.restore) { BO.focus(m.button); }
  }

  function open(button, items) {
    if (openMenu && openMenu.button === button) { close(); return; }
    close();
    var list = BO.el('div', { 'class': 'bo-menu', attrs: { role: 'menu' } });
    var buttons = items.filter(function (it) { return it; }).map(function (it) {
      var b = BO.el('button', { 'class': 'bo-menu__item' + (it.danger ? ' bo-menu__item--danger' : ''), type: 'button', attrs: { role: 'menuitem', tabindex: '-1', 'data-menu': it.id || null }, disabled: !!it.disabled },
        [it.icon ? BO.icon(it.icon, 'bo-icon--md') : null, BO.el('span', { text: it.label })]);
      b.addEventListener('click', function () { openMenu.restore = !it.keepFocusAway; close(); if (it.onClick) { it.onClick(); } });
      list.appendChild(b);
      return b;
    });
    var enabled = buttons.filter(function (b) { return !b.disabled; });
    list.addEventListener('keydown', function (e) {
      var i = enabled.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); BO.focus(enabled[(i + 1) % enabled.length]); } else if (e.key === 'ArrowUp') { e.preventDefault(); BO.focus(enabled[(i - 1 + enabled.length) % enabled.length]); } else if (e.key === 'Home') { e.preventDefault(); BO.focus(enabled[0]); } else if (e.key === 'End') { e.preventDefault(); BO.focus(enabled[enabled.length - 1]); } else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } openMenu.restore = e.key === 'Escape'; close(); }
    });
    document.body.appendChild(list);
    var r = button.getBoundingClientRect();
    var w = list.offsetWidth;
    var h = list.offsetHeight;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) { top = Math.max(8, r.top - h - 6); }
    list.style.left = left + 'px';
    list.style.top = top + 'px';
    button.setAttribute('aria-expanded', 'true');
    var m = { el: list, button: button, restore: true, outside: function (e) { if (!list.contains(e.target) && e.target !== button && !button.contains(e.target)) { m.restore = false; close(); } } };
    openMenu = m;
    document.addEventListener('mousedown', m.outside, true);
    if (enabled.length) { BO.focus(enabled[0]); }
  }

  window.addEventListener('resize', function () { close(); });

  BO.popupMenu = { open: open, close: close };
}(window));
