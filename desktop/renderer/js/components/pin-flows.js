/* PIN flows built on the PIN pad: choose a new PIN (enter twice), change it (old, new, again),
   recover it with the recovery code, and show a recovery code once. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  /* Same rule as desktop/main/pin.js isWeak: PINs kids guess first. */
  var COMMON = ['1212', '1122', '2580', '0852', '6969', '4545', '1004', '2000'];
  function isWeak(pin) {
    if (/^(\d)\1+$/.test(pin)) { return true; }
    var up = true, down = true, i;
    for (i = 1; i < pin.length; i++) {
      var d = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
      if (d !== 1) { up = false; }
      if (d !== -1) { down = false; }
    }
    if (up || down || COMMON.indexOf(pin) >= 0) { return true; }
    return pin.length % 2 === 0 && new Array(pin.length / 2 + 1).join(pin.slice(0, 2)) === pin;
  }

  /* Inline "choose, then confirm" inside a container. cb(pin) once both entries match. */
  function choose(container, opts, cb) {
    var o = opts || {};
    var first = null;
    var pad = BO.pinPad.create({
      title: o.title || BO.t('pin.choose'),
      onSubmit: function (pin, p) {
        if (first === null) {
          if (isWeak(pin)) { p.error(BO.t('pin.weak')); return; }
          first = pin;
          p.reset();
          p.setTitle(o.againTitle || BO.t('pin.again'));
          p.info(BO.t('pin.againHint'));
          return;
        }
        if (pin !== first) {
          first = null;
          p.setTitle(o.title || BO.t('pin.choose'));
          p.error(BO.t('pin.mismatch'));
          return;
        }
        cb(pin, p);
      }
    });
    pad.info(o.hint || BO.t('pin.chooseHint'));
    BO.clear(container).appendChild(pad.el);
    setTimeout(function () { pad.focus(); }, 0);
    return pad;
  }

  /* The code is shown once; Continue stays disabled until "I wrote it down" is ticked. */
  function codeBlock(code, onConfirm, confirmLabel) {
    var check = BO.el('input', { 'class': 'bo-switch__input', type: 'checkbox', id: BO.nextId('wrote') });
    var cont = BO.el('button', { 'class': 'bo-button bo-button--primary bo-button--lg', type: 'button', disabled: true, data: { action: 'code-continue' } }, [confirmLabel || BO.t('common.continue'), BO.icon('chevron-right')]);
    check.addEventListener('change', function () { cont.disabled = !check.checked; });
    var copy = BO.el('button', { 'class': 'bo-button bo-button--ghost', type: 'button', data: { action: 'copy-code' } }, [BO.icon('download'), BO.t('code.copy')]);
    copy.addEventListener('click', function () {
      BO.invoke('app:copyText', { text: 'bonis oculis: ' + code }, function (r) { if (r.ok) { BO.toast.show({ kind: 'success', title: BO.t('code.copied') }); } });
    });
    cont.addEventListener('click', function () { if (check.checked) { onConfirm(); } });
    return BO.el('div', { 'class': 'bo-code' }, [
      BO.el('p', { 'class': 'bo-code__value bo-num', attrs: { 'aria-label': code.split('').join(' ') }, text: code }),
      BO.el('div', { 'class': 'bo-notice bo-notice--warning' }, [BO.icon('alert'), BO.el('p', { text: BO.t('code.warning') })]),
      BO.el('label', { 'class': 'bo-switch', attrs: { 'for': check.id } }, [check, BO.el('span', { 'class': 'bo-switch__track' }), BO.el('span', { 'class': 'bo-switch__label', text: BO.t('code.wrote') })]),
      BO.el('div', { 'class': 'bo-code__actions' }, [copy, cont])
    ]);
  }

  function showCodeModal(code, cb) {
    var m = BO.modal.open({ title: BO.t('code.newTitle'), icon: 'lock', body: [BO.el('p', { text: BO.t('code.newText') }), codeBlock(code, function () { m.close('ok'); if (cb) { cb(); } }, BO.t('code.done'))] });
    return m;
  }

  /* Settings > PIN: current PIN, then the new one twice. */
  function change(cb) {
    var host = BO.el('div', { 'class': 'bo-pin-host' });
    var oldPin = null;
    var m = BO.modal.open({
      title: BO.t('pin.changeTitle'), icon: 'lock', variant: 'pin', body: host,
      actions: [{ label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' }],
      initialFocus: function () { return BO.qs('.bo-pin', host); }
    });
    var pad = BO.pinPad.create({
      title: BO.t('pin.current'),
      onSubmit: function (pin, p) {
        BO.invoke('pin:verify', { pin: pin, purpose: 'peek' }, function (res) {
          if (!res.ok || !BO.pinPad.handleResult(p, res.data)) { return; }
          oldPin = pin;
          choose(host, { title: BO.t('pin.newTitle') }, function (newPin, p2) {
            BO.invoke('pin:change', { oldPin: oldPin, newPin: newPin }, function (r2) {
              if (!r2.ok || !r2.data || !r2.data.ok) { p2.error(BO.t('pin.changeFailed')); return; }
              m.close('ok');
              BO.toast.show({ kind: 'success', title: BO.t('pin.changed') });
              if (cb) { cb(true); }
            });
          });
        });
      }
    });
    host.appendChild(pad.el);
    BO.invoke('pin:status', {}, function (res) { if (res.ok && res.data && res.data.cooldownMs) { pad.lock(res.data.cooldownMs); } });
    return m;
  }

  /* Forgotten PIN: recovery code, then a new PIN twice; a new recovery code is shown once. */
  /* opts.lost: the PIN file is gone; this is the only way in (no Cancel into a PIN-less app). */
  function recover(cb, opts) {
    var lost = !!(opts && opts.lost);
    var host = BO.el('div', { 'class': 'bo-pin-host' });
    var field = BO.el('input', { 'class': 'bo-input bo-num', id: BO.nextId('code'), attrs: { autocomplete: 'off', spellcheck: 'false', maxlength: '20', placeholder: 'XXXX-XXXX-XXXX' } });
    var err = BO.el('span', { 'class': 'bo-field__error' }, [BO.icon('alert'), BO.el('span', { text: BO.t('recover.bad') })]);
    var wrap = BO.el('div', { 'class': 'bo-field' }, [BO.el('label', { 'class': 'bo-field__label', attrs: { 'for': field.id }, text: BO.t('recover.label') }), field,
      BO.el('span', { 'class': 'bo-field__help', text: BO.t('recover.help') }), err]);
    host.appendChild(wrap);
    var m = BO.modal.open({
      title: BO.t(lost ? 'recover.lostTitle' : 'recover.title'), icon: 'unlock', variant: 'pin',
      body: [BO.el('p', { text: BO.t(lost ? 'recover.lostText' : 'recover.text') }), host],
      actions: [
        { label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' },
        { label: BO.t('common.continue'), kind: 'primary', id: 'next', onClick: function (close, btn) {
          var code = field.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
          if (code.length !== 12) { wrap.classList.add('has-error'); BO.focus(field); return; }
          btn.hidden = true;
          choose(host, { title: BO.t('pin.newTitle') }, function (newPin, p) {
            BO.invoke('pin:recover', { code: code, newPin: newPin }, function (res) {
              var d = res.data || {};
              if (!res.ok || !d.ok) {
                if (d.cooldownMs) { p.lock(d.cooldownMs); } else { p.error(BO.t('recover.wrong')); }
                return;
              }
              close('ok');
              showCodeModal(d.recoveryCode, function () { if (cb) { cb(true); } });
            });
          });
        } }
      ],
      initialFocus: function () { return field; }
    });
    field.addEventListener('input', function () { wrap.classList.remove('has-error'); });
    return m;
  }

  BO.pinFlows = { isWeak: isWeak, choose: choose, codeBlock: codeBlock, change: change, recover: recover, showCodeModal: showCodeModal };
}(window));
