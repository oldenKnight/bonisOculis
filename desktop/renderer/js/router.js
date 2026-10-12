/* Views are <section data-view="name"> toggled with the hidden attribute. Library, settings, export
   and help live inside the shell (sidebar + main); setup, kid, review and player fill the window.
   Each view module registers BO.views[name] = {init(section), show(params), hide()}. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var SHELL_VIEWS = ['library', 'settings', 'export', 'help'];
  var current = null;
  var currentParams = null;
  var inited = {};
  var listeners = [];

  function section(name) { return BO.qs('[data-view="' + name + '"]'); }

  function go(name, params) {
    var view = BO.views[name];
    var sec = section(name);
    if (!view || !sec) { return; }
    if (current && current !== name && BO.views[current] && BO.views[current].hide) {
      try { BO.views[current].hide(); } catch (e) { if (window.console) { console.error(e); } }
    }
    BO.qsa('[data-view]').forEach(function (s) { s.hidden = s !== sec; });
    var shell = BO.qs('#shell');
    var inShell = SHELL_VIEWS.indexOf(name) >= 0;
    shell.hidden = !inShell;
    if (!inited[name]) {
      inited[name] = true;
      view.init(sec);
    }
    current = name;
    currentParams = params || {};
    BO.qsa('.bo-nav__item[data-nav]').forEach(function (n) {
      if (n.getAttribute('data-nav') === name || (name === 'library' && currentParams.filter === 'review' && n.getAttribute('data-nav') === 'review')) {
        n.setAttribute('aria-current', 'page');
      } else {
        n.removeAttribute('aria-current');
      }
    });
    if (name === 'library' && currentParams.filter === 'review') {
      var libNav = BO.qs('.bo-nav__item[data-nav="library"]');
      if (libNav) { libNav.removeAttribute('aria-current'); }
    }
    view.show(currentParams);
    listeners.forEach(function (fn) { try { fn(name, currentParams); } catch (e) { /* listener */ } });
    var heading = BO.qs('[data-view-heading]', sec);
    if (heading && !(params && params.keepFocus)) { BO.focus(heading); }
  }

  function refresh() { if (current) { go(current, currentParams); } }

  BO.router = {
    go: go, refresh: refresh,
    current: function () { return current; },
    params: function () { return currentParams; },
    onChange: function (fn) { listeners.push(fn); }
  };
}(window));
