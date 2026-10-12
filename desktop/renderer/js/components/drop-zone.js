/* Drop zone (DESIGN 7.8) and the whole-window drop overlay. The page cannot read file paths; the
   preload sends them as the 'files:dropped' event. Activating the zone opens the movie picker in
   main (library:pick). BO.dropZone.create({title, hint, compact, onPick}). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  function create(opts) {
    var o = opts || {};
    var input = BO.el('input', { 'class': 'bo-dropzone__input', type: 'file', attrs: { multiple: true, accept: 'video/*,.mkv,.avi,.ts,.m2ts', 'aria-describedby': null } });
    var hintId = BO.nextId('dz-hint');
    input.setAttribute('aria-describedby', hintId);
    var titleEl = BO.el('span', { 'class': 'bo-dropzone__title', text: o.title || BO.t('drop.title') });
    var hintEl = BO.el('span', { 'class': 'bo-dropzone__hint', id: hintId, text: o.hint || BO.t('drop.hint') });
    var iconWrap = BO.el('span', { 'class': 'bo-dropzone__icon' }, BO.icon('folder-plus'));
    var body = BO.el('span', { 'class': 'bo-dropzone__body' }, [iconWrap, titleEl, hintEl,
      o.compact ? null : BO.el('span', { 'class': 'bo-button bo-button--secondary', attrs: { 'aria-hidden': 'true' }, text: BO.t('drop.choose') })]);
    var label = BO.el('label', { 'class': 'bo-dropzone' + (o.compact ? ' bo-dropzone--compact' : '') }, [input, body]);
    input.setAttribute('aria-label', (o.title || BO.t('drop.title')) + '. ' + BO.t('drop.choose'));
    input.addEventListener('click', function (e) {
      e.preventDefault();
      if (label.classList.contains('is-disabled')) { return; }
      if (o.onPick) { o.onPick(); }
    });
    label.addEventListener('dragenter', function () { label.classList.add('is-dragover'); titleEl.textContent = BO.t('drop.release'); BO.clear(iconWrap).appendChild(BO.icon('download')); });
    label.addEventListener('dragleave', function (e) { if (!label.contains(e.relatedTarget)) { normal(); } });
    label.addEventListener('drop', function () { normal(); });

    function normal() {
      label.classList.remove('is-dragover');
      titleEl.textContent = o.title || BO.t('drop.title');
      BO.clear(iconWrap).appendChild(BO.icon(label.classList.contains('has-error') ? 'alert' : 'folder-plus'));
    }

    return {
      el: label,
      error: function (text) {
        label.classList.add('has-error');
        hintEl.textContent = text;
        normal();
      },
      clearError: function () {
        label.classList.remove('has-error');
        hintEl.textContent = o.hint || BO.t('drop.hint');
        normal();
      }
    };
  }

  /* Whole-window overlay while files are dragged over the app (parent views only). */
  function installOverlay(isAllowed) {
    var overlay = BO.qs('#drop-overlay');
    var depth = 0;
    function hasFiles(e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return types && Array.prototype.indexOf.call(types, 'Files') >= 0;
    }
    window.addEventListener('dragenter', function (e) {
      if (!hasFiles(e) || !isAllowed()) { return; }
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (!depth) { overlay.hidden = true; }
    });
    window.addEventListener('drop', function () { depth = 0; overlay.hidden = true; });
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) { e.dataTransfer.dropEffect = isAllowed() ? 'copy' : 'none'; }
    });
  }

  BO.dropZone = { create: create, installOverlay: installOverlay };
}(window));
