# Subtitle lexicons (shared: analyzer + browser extension)

`en.json` and `es.json` hold the keyword, SDH-cue and profanity lexicons. The Python analyzer
(`analyzer/bonis_analyzer/signals/subtitles.py`) and the extension must score identically; the
expected per-second scores for `spec/fixtures/subtitles/*.srt` are in
`spec/fixtures/subtitles/expected/<name>.scores.json`.

## Matching rules (normative)
1. **fold(s)**: lowercase; Unicode NFD; delete U+0300..U+036F; every character outside `[a-z0-9]`
   becomes a space; collapse runs of spaces; trim. (`"¿Qué BESO?"` → `"que beso"`, `ñ` → `n`.)
2. Per cue, drop every line that contains any `ignore` string (raw text, before folding).
3. **SDH segments** are the contents of `[...]` and `(...)` in the remaining text. An `sdh` entry
   matches when `fold(pattern)` is a substring of `fold(segment)` for some segment.
4. **Dialogue** is the remaining text with every `[...]` and `(...)` removed; `D = " " + fold(dialogue) + " "`.
   A `keywords` entry with `stem: false` matches when `" " + term + " "` occurs in `D`; with
   `stem: true` when `" " + term` occurs in `D` (word-prefix match). A `profanity` entry matches
   when `" " + term + " "` occurs in `D` and scores the `language` category.
5. Each entry counts at most once per cue. Cue score per category = `1 - Π(1 - weight)` over the
   matched entries of that category, multiplied in file order: `sdh`, then `keywords`, then
   `profanity`.
6. Per-second arrays: `n = ceil(duration)` (duration = given media duration, else the latest cue
   end). A cue `[start, end)` covers seconds `floor(start)` .. `max(floor(start), ceil(end) - 1)`
   (clamped to `n - 1`); each second takes the max over covering cues.
7. Expected files round with `floor(x * 1000 + 0.5) / 1000`.

Which lexicon: the subtitle track language (`en*` → en, `es*`/`spa` → es); when unknown, the one
whose function words occur more often (ties → the `--lang` of the scan).
