/* Toasts (DESIGN 7.6 as amended by planner decision 5): bottom-left of the content, never over
   the review panel; the toast itself lets clicks through, only its own buttons take them. At most
   two at once, extra ones wait. 4 s, 6 s with an action (Undo), errors stay until dismissed; never
   dismissed while a button in it has focus.
   BO.toast.show({kind, title, text, actions: [{label, onClick}], timeout}). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var MAX = 2;
  var waiting = [];
  var ICON = { info: 'info', success: 'check', warning: 'alert', error: 'alert' };

  function region() { return BO.qs('#toasts'); }

  function live() { return BO.qsa('.bo-toast:not(.is-leaving)', region()).length; }

  function show(opts) {
    if (live() >= MAX) { waiting.push(opts); return null; }
    var o = opts || {};
    var kind = ICON[o.kind] ? o.kind : 'info';
    var actions = o.actions || [];
    var node;
    var timer = null;
    var hovering = false;
    var gone = false;

    function dismiss() {
      if (gone) { return; }
      gone = true;
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(function () {
        if (node.parentNode) { node.parentNode.removeChild(node); }
        if (waiting.length && live() < MAX) { show(waiting.shift()); }
      }, 220);
    }

    function arm() {
      clearTimeout(timer);
      if (kind === 'error' && !o.timeout) { return; }
      var ms = o.timeout || (actions.length ? 6000 : 4000);
      timer = setTimeout(function () { if (!hovering) { dismiss(); } else { arm(); } }, ms);
    }

    var actionRow = actions.length ? BO.el('div', { 'class': 'bo-toast__actions' }, actions.map(function (a) {
      return BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', text: a.label, on: { click: function () { dismiss(); if (a.onClick) { a.onClick(); } } } });
    })) : null;
    node = BO.el('div', { 'class': 'bo-toast bo-toast--' + kind, attrs: { role: kind === 'error' ? 'alert' : 'status' } }, [
      BO.icon(ICON[kind], 'bo-toast__icon'),
      BO.el('div', null, [
        BO.el('p', { 'class': 'bo-toast__title', text: o.title || '' }),
        o.text ? BO.el('p', { 'class': 'bo-toast__text', text: o.text }) : null,
        actionRow
      ]),
      BO.el('button', { 'class': 'bo-toast__close', type: 'button', attrs: { 'aria-label': BO.t('common.dismiss') }, on: { click: dismiss } }, BO.icon('close', 'bo-icon--md'))
    ]);
    node.addEventListener('focusin', function () { hovering = true; });
    node.addEventListener('focusout', function () { hovering = false; });
    region().appendChild(node);
    arm();
    return { dismiss: dismiss, el: node };
  }

  /* A toast sent by main: {kind, key, params, textKey}. */
  function fromMain(ev) {
    if (!ev || !ev.key) { return; }
    if (BO.i18n.has(ev.key)) {
      show({ kind: ev.kind || 'info', title: BO.t(ev.key, ev.params) });
      return;
    }
    show({ kind: ev.kind || 'info', title: BO.t(ev.key + '.title', ev.params), text: BO.i18n.has(ev.key + '.text') ? BO.t(ev.key + '.text', ev.params) : null });
  }

  /* An {ok:false, error} answer: the sentence for the code, with what to do next. */
  function error(code) {
    var key = 'error.' + (code || 'failed');
    if (!BO.i18n.has(key + '.title')) { key = 'error.failed'; }
    show({ kind: 'error', title: BO.t(key + '.title'), text: BO.t(key + '.text') });
  }

  // Removes every toast at once (lock: a parent's messages never reach the kids' screen; X5).
  function clearAll() { var r = region(); waiting.length = 0; if (r) { BO.clear(r); } }

  BO.toast = { show: show, fromMain: fromMain, error: error, clearAll: clearAll };
}(window));
