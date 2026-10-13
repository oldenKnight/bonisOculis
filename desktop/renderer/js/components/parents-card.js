/* Parents card (DESIGN 7.12; Common Sense Media benchmark; planner decision 4). One row per kind of
   scene describing the MOVIE, whatever the parent decided:
     "Not checked"            the level is Off, or no stage that finds it ran
     "None found"             checked, nothing found (no check mark: an automatic tool certifies nothing)
     "N found · skipped"      everything found is skipped / covered / muted
     "N found · you let them play" / "N found · play (below your level)" / "N found · M skipped, K play"
   Intensity dots show the strongest scene found. Never a description, a timestamp or an image. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO;
  var WORDS = { 1: 'intensity.mild', 2: 'intensity.moderate', 3: 'intensity.strong' };
  // Stages that can find each kind of scene (analyzer README).
  var SOURCES = {
    nudity: ['frames'], sex: ['frames', 'subtitles', 'speech', 'audio', 'captions'], implied: ['captions', 'subtitles', 'speech', 'audio'],
    kissing: ['frames', 'captions', 'subtitles'], gore: ['frames', 'audio', 'captions'], language: ['subtitles', 'speech']
  };

  function dots(cat, n) {
    var word = BO.t(WORDS[n] || WORDS[1]);
    return BO.el('span', { 'class': 'bo-dots bo-dots--' + (n || 1) + ' bo-dots--' + cat, attrs: { role: 'img', 'aria-label': word } }, [BO.el('i'), BO.el('i'), BO.el('i')]);
  }

  function checked(cat, doc, settings) {
    if (cat === 'other') { return true; }
    var lv = settings && settings.levels ? settings.levels[cat] : null;
    if (lv === 'off') { return false; }
    var stages = doc && doc.scan && doc.scan.stages;
    if (!stages || !SOURCES[cat]) { return true; }
    return SOURCES[cat].some(function (st) { return stages[st] && stages[st].status === 'done'; });
  }

  // -> {kind, text, count, max}
  function rowState(cat, doc, settings) {
    var found = (doc && doc.ranges ? doc.ranges : []).filter(function (r) { return r.category === cat; });
    var isChecked = checked(cat, doc, settings);
    if (!found.length) {
      return isChecked ? { kind: 'none', text: BO.t('parents.none'), count: 0 } : { kind: 'unchecked', text: BO.t('parents.notChecked'), count: 0 };
    }
    var filtered = 0, letPlay = 0, below = 0, max = 1;
    found.forEach(function (r) {
      var e = BO.effective.of(r, settings);
      if (e === 'letPlay') { letPlay++; } else if (e === 'below') { below++; } else { filtered++; }
      if (r.intensity > max) { max = r.intensity; }
    });
    var n = found.length;
    var key;
    if (filtered === n) { key = cat === 'language' ? 'parents.foundMuted' : 'parents.foundSkipped'; } else if (letPlay === n) { key = 'parents.foundLetPlay'; } else if (below === n) { key = 'parents.foundBelow'; } else { key = 'parents.foundMixed'; }
    return { kind: filtered === n ? 'filtered' : 'plays', text: BO.tn(key, n, { filtered: filtered, plays: letPlay + below }), count: n, max: max };
  }

  // opts: {title, meta, pill, doc, settings, headingLevel, compact}
  function create(opts) {
    var o = opts || {};
    var list = BO.el('ul', { 'class': 'bo-parents-card__list' });
    BO.CATEGORIES.forEach(function (cat) {
      var st = rowState(cat, o.doc, o.settings);
      if (cat === 'other' && !st.count) { return; }
      var quiet = st.kind === 'none' || st.kind === 'unchecked';
      var meter = quiet ? [] : [dots(cat, st.max), BO.el('span', { 'class': 'bo-parents-row__word', text: BO.t(WORDS[st.max]) })];
      var row = BO.el('li', { 'class': 'bo-parents-row bo-parents-row--' + cat + (quiet ? ' is-none' : '') + ' is-' + st.kind, data: { category: cat, state: st.kind } }, [
        BO.el('span', { 'class': 'bo-parents-row__icon' }, BO.icon('cat-' + cat)),
        BO.el('span', { 'class': 'bo-parents-row__name', text: BO.t('cat.' + cat) }),
        BO.el('span', { 'class': 'bo-parents-row__count', text: st.text })
      ].concat(o.compact ? (meter.length ? [BO.el('span', { 'class': 'bo-parents-row__meter' }, meter)] : []) : (meter.length ? meter : [BO.el('span'), BO.el('span')])));
      list.appendChild(row);
    });
    var h = BO.el(o.headingLevel || 'h3', { 'class': 'bo-parents-card__title', text: o.title || '' });
    return BO.el('article', { 'class': 'bo-parents-card' + (o.compact ? ' bo-parents-card--compact' : ''), attrs: { 'aria-label': BO.t('parents.label') } }, [
      BO.el('header', { 'class': 'bo-parents-card__header' }, [
        BO.el('div', null, [h, o.meta ? BO.el('p', { 'class': 'bo-parents-card__meta', text: o.meta }) : null]),
        o.pill || null
      ]),
      list,
      BO.el('footer', { 'class': 'bo-parents-card__footer' }, [BO.el('p', { text: BO.t('parents.footer') }), BO.el('p', { text: BO.t('parents.human') })])
    ]);
  }

  BO.parentsCard = { create: create, dots: dots, rowState: rowState, WORDS: WORDS };
}(window));
