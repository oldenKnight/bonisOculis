/* Scene notes in the UI language (board P9, round 2 decision 5). The analyzer writes a template
   sentence in the scan's language (analyzer/bonis_analyzer/notes.py); this is the same template in
   both languages, chosen by category and by which signals reached SIGNAL_PRESENT (0.30). An
   automatic note that is one of the two template sentences is shown in the UI language; any other
   note (written or edited by a parent, a manual or panic mark) is shown as stored.
   Renderer: BO.notes.text(range, lang). Node (fake analyzer, tests): require(...).note(...). ES5. */
(function (root) {
  'use strict';
  var PRESENT = 0.30;
  var ORDER = ['frames', 'subtitles', 'speech', 'audio', 'captions'];
  var CATEGORY = {
    en: { nudity: 'Possible nudity', sex: 'Possible sexual activity', implied: 'Possible implied intimacy', kissing: 'Possible heavy kissing',
      gore: 'Possible graphic violence or blood', language: 'Strong language', other: 'Marked scene' },
    es: { nudity: 'Posible desnudez', sex: 'Posible actividad sexual', implied: 'Posible intimidad sugerida', kissing: 'Posibles besos intensos',
      gore: 'Posible violencia gráfica o sangre', language: 'Lenguaje fuerte', other: 'Escena marcada' }
  };
  var SOURCE = {
    en: { frames: 'picture', subtitles: 'dialogue', speech: 'dialogue', audio: 'sounds', captions: 'scene description' },
    es: { frames: 'imagen', subtitles: 'diálogo', speech: 'diálogo', audio: 'sonidos', captions: 'descripción de la escena' }
  };
  var ONE = {
    en: { frames: 'Seen in the picture.', subtitles: 'Suggested by the dialogue.', speech: 'Suggested by the dialogue.', audio: 'Suggested by sounds.',
      captions: 'Suggested by the scene description.' },
    es: { frames: 'Se ve en la imagen.', subtitles: 'Lo sugiere el diálogo.', speech: 'Lo sugiere el diálogo.', audio: 'Lo sugieren los sonidos.',
      captions: 'Lo sugiere la descripción de la escena.' }
  };
  var PICTURE_AND_DIALOGUE = { en: 'Seen in the picture; the dialogue agrees.', es: 'Se ve en la imagen y el diálogo lo confirma.' };
  var SEVERAL = { en: 'Several signals agree ({list}).', es: 'Varias señales coinciden ({list}).' };
  var WEAK = { en: 'Weak signals; worth a check.', es: 'Señales débiles; conviene revisar.' };
  var IN_DIALOGUE = { en: 'In the dialogue.', es: 'En el diálogo.' };

  function langKey(lang) { return /^es/i.test(String(lang || '')) ? 'es' : 'en'; }

  // present: signal names, as notes.py note(category, present, lang).
  function note(category, present, lang) {
    var k = langKey(lang);
    var head = CATEGORY[k][category] || CATEGORY[k].other;
    var sig = ORDER.filter(function (s) { return (present || []).indexOf(s) >= 0; });
    if (category === 'language') { return head + '. ' + IN_DIALOGUE[k]; }
    if (sig.indexOf('subtitles') >= 0 && sig.indexOf('speech') >= 0) { sig.splice(sig.indexOf('speech'), 1); }
    var tail;
    var set = sig.slice().sort().join(',');
    if (!sig.length) { tail = WEAK[k]; } else if (sig.length === 1) { tail = ONE[k][sig[0]]; } else if (set === 'frames,subtitles' || set === 'frames,speech') {
      tail = PICTURE_AND_DIALOGUE[k];
    } else {
      tail = SEVERAL[k].replace('{list}', sig.map(function (s) { return SOURCE[k][s]; }).join(', '));
    }
    return head + '. ' + tail;
  }

  function presentOf(r) {
    var s = r && r.signals && typeof r.signals === 'object' ? r.signals : {};
    return ORDER.filter(function (k) { return typeof s[k] === 'number' && s[k] >= PRESENT; });
  }

  // The note to show for a range in the UI language.
  function text(r, lang) {
    if (!r) { return ''; }
    var stored = typeof r.note === 'string' ? r.note : '';
    if (r.source !== 'auto') { return stored; }
    var p = presentOf(r);
    if (!stored || stored === note(r.category, p, 'en') || stored === note(r.category, p, 'es')) { return note(r.category, p, lang); }
    return stored;
  }

  var api = { note: note, text: text, presentOf: presentOf, PRESENT: PRESENT, ORDER: ORDER };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root && root.BO) { root.BO.notes = api; }
}(typeof window !== 'undefined' ? window : this));
