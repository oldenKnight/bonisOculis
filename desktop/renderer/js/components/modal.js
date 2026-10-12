/* Modal dialog (DESIGN 7.7): scrim, title as a question, safe action first, focus trapped, Escape
   cancels, focus returns to the opener. The rest of the app is inert while a modal is open.
   BO.modal.open({title, icon, danger, wide, body, actions: [{label, kind, icon, onClick(close), autofocus}], onClose})
   -> {close, el, body}. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var document = window.document;
  var stack = [];

  function setInert(on) {
    BO.qsa('.bo-app > [data-view], .bo-app > #shell').forEach(function (n) {
      if (on) { n.setAttribute('inert', ''); } else { n.removeAttribute('inert'); }
    });
  }

  function focusables(root) {
    return BO.qsa('button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter(function (n) { return !n.hidden && n.offsetParent !== null; });
  }

  function open(opts) {
    var o = opts || {};
    var opener = document.activeElement;
    var titleId = BO.nextId('modal-title');
    var bodyNode = BO.el('div', { 'class': 'bo-modal__body' });
    if (typeof o.body === 'string') {
      o.body.split('\n\n').forEach(function (para) { bodyNode.appendChild(BO.el('p', { text: para })); });
    } else if (o.body) {
      BO.append(bodyNode, o.body);
    }
    var footer = BO.el('div', { 'class': 'bo-modal__footer' });
    var dialog = BO.el('div', {
      'class': 'bo-modal' + (o.danger ? ' bo-modal--danger' : '') + (o.wide ? ' bo-modal--wide' : ''),
      attrs: { role: o.danger ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }
    }, [
      BO.el('div', { 'class': 'bo-modal__header' }, [
        o.icon ? BO.el('span', { 'class': 'bo-modal__icon' }, BO.icon(o.icon)) : null,
        BO.el('h2', { 'class': 'bo-modal__title', id: titleId, text: o.title || '' })
      ]),
      bodyNode,
      (o.actions && o.actions.length) ? footer : null
    ]);
    var backdrop = BO.el('div', { 'class': 'bo-modal-backdrop' }, dialog);
    var closed = false;
    var handle = { el: dialog, body: bodyNode, footer: footer, close: close };
    var autofocus = null;

    (o.actions || []).forEach(function (a, i) {
      var b = BO.el('button', {
        'class': 'bo-button bo-button--' + (a.kind || (i === 0 ? 'secondary' : 'primary')), type: 'button',
        attrs: { 'data-action': a.id || null }, disabled: !!a.disabled
      }, [a.icon ? BO.icon(a.icon) : null, a.label]);
      b.addEventListener('click', function () {
        if (a.onClick) { a.onClick(close, b); } else { close(); }
      });
      footer.appendChild(b);
      if (a.autofocus || (!autofocus && i === 0)) { autofocus = b; }
    });

    function close(reason) {
      if (closed) { return; }
      closed = true;
      var i = stack.indexOf(handle);
      if (i >= 0) { stack.splice(i, 1); }
      if (backdrop.parentNode) { backdrop.parentNode.removeChild(backdrop); }
      if (!stack.length) { setInert(false); }
      if (o.onClose) { try { o.onClose(reason); } catch (e) { /* caller */ } }
      if (opener && opener.focus && document.contains(opener)) { BO.focus(opener); }
    }

    backdrop.addEventListener('keydown', function (e) {
      if (stack[stack.length - 1] !== handle) { return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close('escape');
      } else if (e.key === 'Tab') {
        var f = focusables(dialog);
        if (!f.length) { e.preventDefault(); return; }
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); BO.focus(last); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); BO.focus(first); }
      }
    });
    backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop && o.closeOnBackdrop !== false) { close('backdrop'); } });

    BO.qs('#modal-root').appendChild(backdrop);
    stack.push(handle);
    setInert(true);
    var target = (o.initialFocus && o.initialFocus()) || autofocus || focusables(dialog)[0] || dialog;
    if (target === dialog) { dialog.setAttribute('tabindex', '-1'); }
    setTimeout(function () { BO.focus(target); }, 0);
    return handle;
  }

  /* Confirmation: safe choice first and named; resolves cb(true|false). */
  function confirm(opts, cb) {
    var answered = false;
    var m = open({
      title: opts.title, icon: opts.icon || (opts.danger ? 'alert' : 'check'), danger: !!opts.danger, body: opts.body,
      actions: [
        { label: opts.cancelLabel || BO.t('common.cancel'), kind: 'secondary', id: 'cancel', onClick: function (close) { answered = true; close(); cb(false); } },
        { label: opts.okLabel, kind: opts.danger ? 'danger' : 'primary', icon: opts.okIcon || null, id: 'ok', onClick: function (close) { answered = true; close(); cb(true); } }
      ],
      onClose: function () { if (!answered) { answered = true; cb(false); } }
    });
    return m;
  }

  BO.modal = { open: open, confirm: confirm, isOpen: function () { return stack.length > 0; } };
}(window));
