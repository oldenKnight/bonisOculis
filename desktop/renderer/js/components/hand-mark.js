/* "Mark by hand" (brief 6.5, board X13): a parent watches the whole movie with nothing skipped
   and marks every scene with I and O. The marks go to a separate file (library/<id>.truth.bonis.json)
   that only "Check accuracy" uses; they never change what kids see. BO.handMark.start(item). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;

  function start(item) {
    if (!item) { return; }
    BO.modal.confirm({ title: BO.t('hand.confirm.title', { title: item.title }), body: BO.t('hand.confirm.text'), okLabel: BO.t('hand.confirm.ok'), okIcon: 'flag', icon: 'flag' }, function (yes) {
      if (!yes) { return; }
      BO.invoke('player:play', { id: item.id, handMark: true }, function (r) { if (!r.ok) { BO.toast.error(r.error); } });
    });
  }

  BO.handMark = { start: start };
}(window));
