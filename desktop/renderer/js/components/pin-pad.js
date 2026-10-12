/* PIN pad (DESIGN 7.5): title, 4 to 6 dots, one message line that always keeps its height, 3x4
   keys. Digits, Backspace and Enter also work from the keyboard while focus is inside the pad.
   BO.pinPad.create({title, onSubmit(pin, pad), submitLabel}) -> {el, reset, error, info, lock, focus}. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var MIN = 4;
  var MAX = 6;

  function create(opts) {
    var o = opts || {};
    var digits = '';
    var lockedTimer = null;
    var keys = [];
    var titleId = BO.nextId('pin-title');
    var title = BO.el('p', { 'class': 'bo-pin__title', id: titleId, text: o.title || BO.t('pin.enter') });
    var dots = BO.el('div', { 'class': 'bo-pin__dots', attrs: { role: 'img' } });
    var msg = BO.el('p', { 'class': 'bo-pin__msg', attrs: { role: 'status', 'aria-live': 'polite' } });
    var grid = BO.el('div', { 'class': 'bo-pin__keys' });
    var root = BO.el('div', { 'class': 'bo-pin', attrs: { role: 'group', 'aria-labelledby': titleId, tabindex: '-1' } }, [title, dots, msg, grid]);
    var confirmKey;
    var backKey;

    function renderDots() {
      BO.clear(dots);
      var n = Math.max(MIN, digits.length);
      var i;
      for (i = 0; i < n; i++) { dots.appendChild(BO.el('span', { 'class': 'bo-pin__dot' + (i < digits.length ? ' is-filled' : '') })); }
      dots.setAttribute('aria-label', BO.t('pin.digitsSoFar', { n: digits.length }));
      confirmKey.disabled = isLocked() || digits.length < MIN;
      backKey.disabled = isLocked() || !digits.length;
    }

    function isLocked() { return root.classList.contains('is-locked'); }

    function clearError() {
      if (root.classList.contains('has-error')) {
        root.classList.remove('has-error');
        msg.textContent = '';
      }
    }

    function press(d) {
      if (isLocked()) { return; }
      clearError();
      if (digits.length < MAX) { digits += d; }
      renderDots();
    }

    function back() {
      if (isLocked()) { return; }
      clearError();
      digits = digits.slice(0, -1);
      renderDots();
    }

    function submit() {
      if (isLocked() || digits.length < MIN) { return; }
      var pin = digits;
      if (o.onSubmit) { o.onSubmit(pin, api); }
    }

    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (d) {
      var k = BO.el('button', { 'class': 'bo-pin__key', type: 'button', text: d, on: { click: function () { press(d); } } });
      keys.push(k);
      grid.appendChild(k);
    });
    backKey = BO.el('button', { 'class': 'bo-pin__key bo-pin__key--action', type: 'button', attrs: { 'aria-label': BO.t('pin.delete') }, on: { click: back } }, BO.icon('undo'));
    var zero = BO.el('button', { 'class': 'bo-pin__key', type: 'button', text: '0', on: { click: function () { press('0'); } } });
    confirmKey = BO.el('button', { 'class': 'bo-pin__key bo-pin__key--confirm', type: 'button', attrs: { 'aria-label': o.submitLabel || BO.t('pin.confirm') }, on: { click: submit } }, BO.icon('check'));
    keys.push(zero);
    grid.appendChild(backKey);
    grid.appendChild(zero);
    grid.appendChild(confirmKey);

    root.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); back(); } else if (e.key === 'Enter' && (e.target === root || e.target === confirmKey || /^[0-9]$/.test(e.target.textContent || ''))) {
        if (digits.length >= MIN) { e.preventDefault(); submit(); }
      }
    });

    function reset() {
      digits = '';
      clearError();
      renderDots();
    }

    function error(text) {
      digits = '';
      root.classList.remove('has-error');
      void root.offsetWidth; /* restart the shake */
      root.classList.add('has-error');
      msg.textContent = text;
      renderDots();
    }

    function info(text) { root.classList.remove('has-error'); msg.textContent = text || ''; }

    function setKeysDisabled(dis) {
      keys.forEach(function (k) { k.disabled = dis; });
      renderDots();
    }

    // Cooldown: keys off, countdown in the message, unlocks itself.
    function lock(ms, onUnlock) {
      clearInterval(lockedTimer);
      digits = '';
      root.classList.remove('has-error');
      root.classList.add('is-locked');
      var until = Date.now() + ms;
      function tick() {
        var left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(lockedTimer);
          root.classList.remove('is-locked');
          msg.textContent = BO.t('pin.tryAgainNow');
          setKeysDisabled(false);
          if (onUnlock) { onUnlock(); }
          return;
        }
        msg.textContent = BO.t('pin.cooldown', { seconds: left });
      }
      setKeysDisabled(true);
      tick();
      lockedTimer = setInterval(tick, 1000);
    }

    function setTitle(text) { title.textContent = text; }

    function focus() { BO.focus(root); }

    function destroy() { clearInterval(lockedTimer); }

    var api = { el: root, reset: reset, error: error, info: info, lock: lock, focus: focus, setTitle: setTitle, destroy: destroy };
    renderDots();
    return api;
  }

  /* Shared answer handling for pin:verify / pin:recover results. Returns true when ok. */
  function handleResult(pad, r) {
    if (r && r.ok) { return true; }
    if (r && r.cooldownMs) {
      pad.lock(r.cooldownMs);
    } else if (r && typeof r.triesLeft === 'number' && r.triesLeft <= 2) {
      pad.error(BO.tn('pin.wrongTriesLeft', r.triesLeft));
    } else {
      pad.error(BO.t('pin.wrong'));
    }
    return false;
  }

  /* Modal that asks for the PIN. purpose: 'unlock' | 'peek'. cb(true) when verified. */
  function ask(opts, cb) {
    var o = opts || {};
    var done = false;
    var pad = create({
      title: o.title || BO.t('pin.enter'),
      onSubmit: function (pin, p) {
        BO.invoke('pin:verify', { pin: pin, purpose: o.purpose || 'unlock' }, function (res) {
          if (!res.ok) { p.error(BO.t('pin.wrong')); return; }
          if (handleResult(p, res.data)) {
            done = true;
            m.close('ok');
            cb(true);
          }
        });
      }
    });
    var forgot = o.allowRecover ? BO.el('button', { 'class': 'bo-button bo-button--ghost bo-button--sm', type: 'button', text: BO.t('pin.forgot'), on: { click: function () { m.close('recover'); if (o.onForgot) { o.onForgot(); } } } }) : null;
    var m = BO.modal.open({
      title: o.heading || BO.t('pin.modalTitle'), icon: 'lock', variant: 'pin', body: [o.text ? BO.el('p', { text: o.text }) : null, pad.el],
      footerStart: forgot,
      actions: [{ label: BO.t('common.cancel'), kind: 'secondary', id: 'cancel' }],
      initialFocus: function () { return pad.el; },
      onClose: function () { pad.destroy(); if (!done) { cb(false); } }
    });
    BO.invoke('pin:status', {}, function (res) {
      if (res.ok && res.data && res.data.cooldownMs) { pad.lock(res.data.cooldownMs); }
    });
    return m;
  }

  BO.pinPad = { create: create, ask: ask, handleResult: handleResult, MIN: MIN, MAX: MAX };
}(window));
