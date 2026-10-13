'use strict';
// The one place that decides what is enforced (board review A8): the player's playback file, the
// JSON sidecar, the Kodi list and the clean copy all come from playbackDoc(doc, settings), so the
// TV never protects less (or more) than the app. Pure.
//  - Parent-reviewed, locked and manual ranges keep their action.
//  - Automatic pending ranges follow the current level of their category: below the level's
//    confidence threshold (or level off) they play (action none); language mutes.
//  - skipScenes=false turns skip into the cover action (hide or blur).
// The renderer mirrors this in desktop/renderer/js/effective.js (a unit test keeps them equal).

var BO = require('../../shared/skipfile.js');

var THRESHOLDS = { light: 0.8, moderate: 0.6, strict: 0.4 };
var CATS = ['nudity', 'sex', 'implied', 'kissing', 'gore', 'language'];
var LEVELS = ['off', 'light', 'moderate', 'strict'];

function validLevels(v) {
  if (!v || typeof v !== 'object') { return false; }
  return CATS.every(function (c) { return LEVELS.indexOf(v[c]) >= 0; });
}

// The settings that apply to one title: its own "For this movie" levels (library index entry,
// board round 2 decision 6) or the parent's usual levels. Every enforcement path calls this.
function settingsFor(item, settings) {
  var s = settings || {};
  var own = item && validLevels(item.levels) ? item.levels : null;
  return { levels: own || s.levels, skipScenes: s.skipScenes, nonSkipAction: s.nonSkipAction, perMovie: !!own };
}

// settings: {levels, skipScenes, nonSkipAction}
function playbackDoc(doc, settings) {
  var o = settings || {};
  var levels = o.levels || {};
  var out = JSON.parse(JSON.stringify(doc));
  out.ranges.forEach(function (r) {
    if (r.source === 'auto' && r.locked !== true && r.review === 'pending' && Object.prototype.hasOwnProperty.call(levels, r.category)) {
      var lvl = levels[r.category];
      if (lvl === 'off' || (THRESHOLDS[lvl] && r.confidence < THRESHOLDS[lvl])) {
        r.action = 'none';
      } else if (r.category === 'language' && r.action !== 'none') {
        r.action = 'mute';
      } else if (r.action === 'none') {
        r.action = 'skip';
      }
    }
    if (o.skipScenes === false && r.action === 'skip') { r.action = o.nonSkipAction === 'blur' ? 'blur' : 'hide'; }
  });
  out.summary = BO.summarise(out);
  return out;
}

// The ranges that will really be acted on, as the player sees them.
function enforcedRanges(doc, settings) { return BO.enforced(playbackDoc(doc, settings)); }

module.exports = { playbackDoc: playbackDoc, enforcedRanges: enforcedRanges, settingsFor: settingsFor, validLevels: validLevels, THRESHOLDS: THRESHOLDS, CATS: CATS, LEVELS: LEVELS };
