/* Help (PLAN 5.8): docs/HELP/<lang>.md rendered by main (help.js, escaped Markdown subset), with a
   table of contents. Also shows the licence inventory (Settings > About). ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var root = null;
  var toc = null;
  var article = null;
  var current = { doc: 'help', anchor: null };

  function scrollTo(anchor) {
    var target = anchor ? article.querySelector('[id="' + anchor.replace(/"/g, '') + '"]') : null;
    if (target) { target.scrollIntoView({ block: 'start' }); BO.focus(target); }
  }

  function render(data) {
    BO.clear(toc);
    BO.clear(article);
    var heading = BO.el('h1', { 'class': 'bo-page__title', text: data.title || BO.t(current.doc === 'licenses' ? 'help.licences' : 'help.title'), attrs: { tabindex: '-1', 'data-view-heading': '' } });
    var body = BO.el('div', { 'class': 'bo-help__body' });
    // Trusted: produced in main from bundled Markdown, every text node HTML-escaped there.
    body.innerHTML = data.html || '';
    article.appendChild(heading);
    if (current.doc === 'licenses') {
      var back = BO.el('button', { 'class': 'bo-button bo-button--ghost', type: 'button' }, [BO.icon('chevron-left'), BO.t('help.backToHelp')]);
      back.addEventListener('click', function () { current = { doc: 'help', anchor: null }; load(); });
      article.insertBefore(back, heading);
    }
    article.appendChild(body);
    (data.toc || []).filter(function (e) { return e.level === 2; }).forEach(function (e) {
      var b = BO.el('button', { 'class': 'bo-nav__item', type: 'button', data: { anchor: e.id } }, BO.el('span', { 'class': 'bo-nav__label', text: e.text }));
      b.addEventListener('click', function () {
        BO.qsa('.bo-nav__item', toc).forEach(function (x) { x.removeAttribute('aria-current'); });
        b.setAttribute('aria-current', 'true');
        scrollTo(e.id);
      });
      toc.appendChild(b);
    });
    BO.qsa('a[data-help-anchor]', body).forEach(function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); scrollTo(a.getAttribute('data-help-anchor')); });
    });
  }

  function load() {
    BO.invoke('help:open', { doc: current.doc }, function (r) {
      if (!r.ok) { BO.toast.error(r.error); return; }
      render(r.data);
      if (current.anchor) { scrollTo(current.anchor); } else { BO.focus(BO.qs('[data-view-heading]', root)); }
    });
  }

  BO.views.help = {
    init: function (section) {
      root = section;
      toc = BO.el('nav', { 'class': 'bo-nav bo-settings__nav', attrs: { 'aria-label': BO.t('help.contents') } });
      article = BO.el('article', { 'class': 'bo-help' });
      root.appendChild(BO.el('div', { 'class': 'bo-settings bo-help-layout' }, [toc, article]));
      BO.i18n.onChange(function () { toc.setAttribute('aria-label', BO.t('help.contents')); if (BO.router.current() === 'help') { load(); } });
    },
    show: function (params) {
      current = { doc: params && params.doc === 'licenses' ? 'licenses' : 'help', anchor: params && params.anchor ? params.anchor : null };
      load();
    },
    hide: function () {}
  };
}(window));
