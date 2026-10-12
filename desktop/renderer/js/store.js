/* Renderer-side state with subscriptions. Keys: boot, settings, library, scan, player, locked. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var state = {};
  var subs = {};

  function get(key) { return state[key]; }

  function set(key, value) {
    state[key] = value;
    (subs[key] || []).slice().forEach(function (fn) {
      try { fn(value); } catch (e) { if (window.console) { console.error(e); } }
    });
  }

  function subscribe(key, fn) {
    (subs[key] = subs[key] || []).push(fn);
    return function () {
      var i = (subs[key] || []).indexOf(fn);
      if (i >= 0) { subs[key].splice(i, 1); }
    };
  }

  function item(id) {
    var list = state.library || [];
    var i;
    for (i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  BO.store = { get: get, set: set, subscribe: subscribe, item: item };
}(window));
