/* What will really happen to a scene with the current settings (planner decision 6). Mirrors
   desktop/main/player-service.js buildPlaybackDoc (a unit test keeps the two in step):
   automatic, unreviewed, unlocked scenes follow the level of their category; parent decisions
   stand. BO.effective.of(range, settings) -> 'skip'|'hide'|'blur'|'mute'|'letPlay'|'below'. ES5. */
(function (window) {
  'use strict';
  var BO = window.BO = window.BO || {};
  var THRESHOLDS = { light: 0.8, moderate: 0.6, strict: 0.4 };

  function action(r, s) {
    var st = s || {};
    var levels = st.levels || {};
    var a = r.action;
    if (r.source === 'auto' && r.locked !== true && r.review === 'pending' && Object.prototype.hasOwnProperty.call(levels, r.category)) {
      var lvl = levels[r.category];
      if (lvl === 'off' || (THRESHOLDS[lvl] && r.confidence < THRESHOLDS[lvl])) { a = 'none'; } else if (r.category === 'language' && a !== 'none') { a = 'mute'; } else if (a === 'none') { a = 'skip'; }
    }
    if (st.skipScenes === false && a === 'skip') { a = st.nonSkipAction === 'blur' ? 'blur' : 'hide'; }
    return a;
  }

  function of(r, s) {
    if (r.review === 'rejected') { return 'letPlay'; }
    var a = action(r, s);
    return a === 'none' ? 'below' : a;
  }

  var CATS = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
  function validLevels(v) { return !!v && CATS.every(function (c) { return ['off', 'light', 'moderate', 'strict'].indexOf(v[c]) >= 0; }); }

  // Mirrors desktop/main/enforce.js settingsFor: a title's own "For this movie" levels, else the usual ones.
  function settingsFor(item, s) {
    var st = s || {};
    var own = item && validLevels(item.levels) ? item.levels : null;
    return { levels: own || st.levels, skipScenes: st.skipScenes, nonSkipAction: st.nonSkipAction, perMovie: !!own };
  }

  BO.effective = { action: action, of: of, settingsFor: settingsFor, THRESHOLDS: THRESHOLDS };
}(typeof window !== 'undefined' ? window : this));
