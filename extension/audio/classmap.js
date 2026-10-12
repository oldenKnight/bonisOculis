/*
 * bonis oculis - YAMNet class -> category table for live listening
 * (BO.classmap). ES5, no DOM; loaded by the offscreen document and by the
 * node unit tests.
 *
 * SOURCE (copied, not invented): analyzer/bonis_analyzer/config.py,
 * AUDIO_CLASS_MAP, as of 2026-10-12. Same classes, same weights, same rule as
 * analyzer/bonis_analyzer/signals/audio.py (frame_categories):
 *     category score of one 0.96 s window = max over mapped classes of
 *     weight * class score
 * Class indices are the rows of analyzer/models/yamnet_class_map.csv (the
 * official YAMNet class map, sha256 cdf24d19...6df2). A unit test checks the
 * table against both files, so a change in the analyzer fails the build until
 * this copy is updated.
 *
 * The brief's "violence" for live mode is the "gore" category here, as in the
 * analyzer and the skip-file format. Note the analyzer's caps: Explosion and
 * Screaming weigh 0.50, so on their own they never reach the live violence
 * threshold (0.60); Gunshot, Machine gun, Fusillade and Squish can.
 */
(function (root) {
  'use strict';
  var BO = root.BO = root.BO || {};
  if (BO.classmap) { return; }

  var CLASSES = 521;
  /* [index in yamnet_class_map.csv, AudioSet display name, {category: weight}] */
  var TABLE = [
    [22, 'Wail, moan', { sex: 0.90, implied: 0.70 }],
    [40, 'Pant', { sex: 0.70, implied: 0.50 }],
    [33, 'Groan', { sex: 0.60, implied: 0.40 }],
    [39, 'Gasp', { sex: 0.55, implied: 0.40 }],
    [21, 'Whimper', { sex: 0.50, implied: 0.35 }],
    [36, 'Breathing', { sex: 0.40, implied: 0.30 }],
    [34, 'Grunt', { sex: 0.40, implied: 0.25 }],
    [421, 'Gunshot, gunfire', { gore: 0.80 }],
    [422, 'Machine gun', { gore: 0.80 }],
    [423, 'Fusillade', { gore: 0.70 }],
    [441, 'Squish', { gore: 0.70 }],
    [420, 'Explosion', { gore: 0.50 }],
    [11, 'Screaming', { gore: 0.50 }],
    [461, 'Slap, smack', { gore: 0.45 }],
    [432, 'Chop', { gore: 0.45 }],
    [19, 'Crying, sobbing', { gore: 0.30 }]
  ];
  var CATEGORIES = ['sex', 'implied', 'gore'];

  /* scores: 521 class scores of one window (array or Float32Array).
     -> {sex, implied, gore}, each in [0, 1]. */
  function map(scores) {
    var out = { sex: 0, implied: 0, gore: 0 }, i, row, s, cat, v;
    for (i = 0; i < TABLE.length; i++) {
      row = TABLE[i];
      s = scores ? Number(scores[row[0]]) : 0;
      if (!(s > 0)) { continue; }
      if (s > 1) { s = 1; }
      for (cat in row[2]) {
        if (Object.prototype.hasOwnProperty.call(row[2], cat)) {
          v = row[2][cat] * s;
          if (v > out[cat]) { out[cat] = v; }
        }
      }
    }
    return out;
  }

  /* The n highest classes of a window: [[index, score], ...] (diagnostics, tests). */
  function top(scores, n) {
    var best = [], i, j, s;
    for (i = 0; scores && i < scores.length; i++) {
      s = Number(scores[i]) || 0;
      for (j = best.length; j > 0 && best[j - 1][1] < s; j--) { /* find slot */ }
      if (j < n) {
        best.splice(j, 0, [i, Math.round(s * 1000) / 1000]);
        if (best.length > n) { best.pop(); }
      }
    }
    return best;
  }

  BO.classmap = {
    SOURCE: 'analyzer/bonis_analyzer/config.py AUDIO_CLASS_MAP',
    CLASSES: CLASSES,
    TABLE: TABLE,
    CATEGORIES: CATEGORIES,
    map: map,
    top: top
  };
}(typeof self !== 'undefined' ? self : this));
