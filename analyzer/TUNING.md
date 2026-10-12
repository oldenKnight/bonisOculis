# Fusion tuning (analyzer v2)

Every number below lives in `bonis_analyzer/config.py`. None of them has been
fitted to real films yet: the brief forbids real explicit material in this
repository (8.1), so they are reasoned starting points. They must be tuned
on the owner's hand-marked films with `evaluate` and `tools/tune.py` (brief 6.5).
The rule when in doubt is the brief's: **catch too much rather than too
little** (3.2); a parent rejects a false alarm with one click on the review
screen, but a miss reaches the child.

## 1. How a second gets its score

For each category `c` and second `t`:

```
noisy-OR   p = 1 - prod_s (1 - w[s][c] * signal[s][c][t])
agreement  if >= 2 signal GROUPS have signal >= 0.30 at t:  p = 1 - (1 - p) * (1 - 0.25)
```

Signals (`SIGNALS`) and their groups (`SIGNAL_GROUPS`):

| signal | group | what it is |
|---|---|---|
| frames | picture | NudeNet (nudity) + CLIP zero-shot (sex, kissing, implied, gore), 1 fps |
| captions | description | Florence-2 caption of one keyframe per shot -> lexicon + caption LM |
| subtitles | dialogue | subtitle cues -> lexicon, max()ed with 0.85 x the dialogue LM |
| speech | dialogue | whisper transcript (only when there are no subtitles) -> the same scorer |
| audio | sound | YAMNet sound events -> class weights |

Then: seconds `>= threshold(level)` form runs; runs closer than `MERGE_GAP`
merge; runs snap outward to scene cuts (`MAX_SNAP`); lead-in / tail padding;
per-category minimum duration; confidence = peak score of the run.

## 2. Signal weights (`SIGNAL_WEIGHTS`)

| signal | nudity | sex | implied | kissing | gore | language | why |
|---|---|---|---|---|---|---|---|
| frames | **1.00** | 0.90 | 0.70 | 0.85 | **0.90** | 0 | Strongest for what is *seen*. NudeNet is a trained detector (1.0). CLIP zero-shot is weaker and over-fires on red test patterns (ledger), hence 0.9 for gore/sex. Implied scenes are by definition not explicit in the picture: 0.70. |
| subtitles | 0.70 | 0.85 | 0.85 | 0.75 | 0.75 | 1.00 | Moderate for all visual categories: dialogue talks *about* things that may be off screen, so it cannot be a strong nudity signal; SDH cues such as "[moaning]" are reliable for sex/implied. Language is dialogue by definition. |
| speech | 0.60 | 0.75 | 0.75 | 0.65 | 0.65 | 0.90 | The subtitle weights minus ~0.1: recognition errors, no SDH cues (whisper rarely writes "(moaning)"). |
| audio | 0 | 0.60 | 0.50 | 0 | **0.35** | 0 | Moderate for sex (moans, panting are distinctive); weak for gore (gunshots, screams and explosions are everyday action-film sounds). No AudioSet class indicates nudity or kissing. |
| captions | 0.60 | 0.70 | 0.75 | 0.70 | 0.60 | 0 | Moderate for implied/sex/kissing: a description such as "a couple lying in bed under the sheets" is exactly the implied scene that has no nudity for NudeNet to find. Lower for nudity/gore, where the detector and CLIP see the same pixels more directly. |

What a single signal can do on its own at the strict threshold (0.40):
frames nudity >= 0.40; subtitles "[moaning]" (0.85 -> 0.72); audio "Wail, moan"
at 0.9 confidence (0.81 x 0.60 = 0.49); a caption scored 0.6 for implied
(0.45). Moderate (0.60) and light (0.80) need a stronger single signal or
agreement.

## 3. Agreement bonus (`AGREE_MIN`, `AGREE_MIN_SIGNALS`, `AGREE_BONUS`)

Two **independent** signals that both see something (raw score >= 0.30 at the
same second) are much stronger evidence than either score suggests in a
noisy-OR, which treats them as if their errors were correlated with nothing.
The bonus `p' = 1 - (1 - p)(1 - 0.25)` moves 0.40 -> 0.55, 0.60 -> 0.70, never
above 1, and is monotonic. Rules:
- groups, not signals: subtitles and speech are both dialogue and cannot agree
  with each other; captions and frames are different models (detector /
  zero-shot vs. language description) of the same pixels and count as two
  groups. If the owner's films show they fail together, set
  `SIGNAL_GROUPS["captions"] = "picture"`.
- only signals with weight > 0 for the category count (audio cannot "agree"
  on nudity).
- `language` gets no bonus (single source).
- intensity: +1 when two signals have a peak >= 0.30 in the range (unchanged
  from v1).

## 4. Thresholds and levels (`LEVEL_THRESHOLDS`, spec/SKIPFILE.md)

strict 0.40, moderate 0.60, light 0.80, off = never. These are the skip-file
spec's numbers and the review screen's vocabulary; tune weights first, and
change thresholds only together with the spec.

## 5. Timing (`MERGE_GAP`, `MAX_SNAP`, `LEAD_IN`, `TAIL`, `CATEGORY_MIN_DURATION`)

| constant | value | why |
|---|---|---|
| MERGE_GAP | 3 s | two hits 2 s apart are the same scene; a gap shorter than the lead-in would otherwise make the player jump twice |
| MAX_SNAP | 20 s | a range grows to the enclosing shot (scene cuts) so it starts and ends on a cut, not mid-shot; capped so one long shot does not swallow a minute |
| LEAD_IN | 2 s | starts the skip before the first flagged second (1 fps sampling means the scene may start up to 1 s earlier; mpv seeks land on keyframes) |
| TAIL | 1 s | covers the last sampled second |
| min duration | nudity 1.5, sex 3, implied 3, kissing 2, gore 1.5, language 1 s | shorter ranges are **extended**, never dropped (catch too much). Sex/implied scenes are never a single beat; kissing at 2 s. Language keeps cue timing (muted, not skipped). |
| language timing | no snap, 0.5 s lead/tail, 1 s merge | muting a whole shot for one word would mute far too much dialogue |

## 6. Inside the signals

**Audio classes (`AUDIO_CLASS_MAP`).** Per 0.96 s YAMNet frame:
`category = max_k weight_k * score_k`; per second = max over overlapping frames.

| class | sex | implied | gore | reasoning |
|---|---|---|---|---|
| Wail, moan | 0.90 | 0.70 | | the most specific intimacy sound in AudioSet |
| Pant | 0.70 | 0.50 | | |
| Groan | 0.60 | 0.40 | | also pain, effort |
| Gasp | 0.55 | 0.40 | | also surprise |
| Whimper | 0.50 | 0.35 | | also fear, children |
| Breathing | 0.40 | 0.30 | | very common (sport, chase scenes) |
| Grunt | 0.40 | 0.25 | | very common (fights, effort) |
| Gunshot, gunfire / Machine gun | | | 0.80 | violence, rarely gore by itself |
| Fusillade | | | 0.70 | |
| Squish | | | 0.70 | the closest AudioSet class to "wet impact" |
| Explosion | | | 0.50 | |
| Screaming | | | 0.50 | see below |
| Slap, smack / Chop | | | 0.45 | |
| Crying, sobbing | | | 0.30 | aftermath of violence; also every sad scene |

*Screaming alone never flags gore.* Its class weight is capped at 0.50 and the
audio->gore fusion weight is 0.35, so a certain scream contributes at most
0.175, under every threshold (and even the strongest gore sound, a gunshot at
0.80, reaches only 0.28 < 0.40). Screams happen in horror films, at
fairgrounds, at surprise parties and in children's games; flagging them would
bury the review screen in false alarms and teach parents to "approve all".
A scream does count through the agreement bonus: picture gore at 0.35
(0.315, below strict) plus a scream (0.50 >= 0.30) agree and reach 0.58
(`tests/test_audio.py`, `ScreamingRuleTest`).

**Captions.** Shot score = `max(lexicon(caption), 0.85 * captionLM(caption))`;
the caption LM (Qwen3-0.6B, its own few-shot prompt) runs only for captions
that mention people. The lexicon is the shared English one; captions are
English whatever the film's language.

**Dialogue LM.** `LM_WEIGHT` 0.85: the LM is a second opinion on the keyword
score; its 0-10 answers are coarse, so it never fully overrides a lexicon hit.

## 7. Measuring and tuning on hand-marked films

1. For each hand-marked film, scan it normally and keep the work dir (the
   scan already keeps every stage's `.npz`).
2. Compare once with today's settings:
   `python -m bonis_analyzer evaluate --truth film.truth.bonis.json --pred film.bonis.json --out report.json`
   (per category: precision, recall, F1, range hit rate +-3 s, seconds missed /
   falsely flagged; this is the table brief 6.5 asks for).
3. Lay the films out for the tuner:
   ```
   cases/
     film-a/truth.bonis.json   (the hand-marked file)
     film-a/work/              (copy or symlink of that film's work dir)
     film-b/...
   ```
4. Grid-search:
   `python3 tools/tune.py cases --categories sex,implied --weights 0,0.35,0.6,0.85,1 --thresholds 0.3,0.4,0.5,0.6`
   It rebuilds the signals exactly as the scan does
   (`fusion.assemble_signals`) and re-runs `fusion.fuse` for every combination
   of weights of the signals present for that category, times every threshold,
   then prints one markdown table per category: the current config.py row
   first, then the best rows by F2 (recall weighted 4x over precision; change
   with `--beta`), with precision, recall, F1, seconds missed and seconds
   falsely flagged. No model runs; a full grid on a 2 h film takes seconds to
   minutes per category.
5. Adopt a row by editing `SIGNAL_WEIGHTS` (and, only together with the spec,
   `LEVEL_THRESHOLDS`). Re-run step 2 and paste the before/after tables into
   the ledger.

Cautions: with a handful of films, a grid will overfit. Prefer changes that
help on every film (run tune.py once per film and once on all), keep weights
on the coarse grid, never tune on the film you report numbers for
(leave-one-out), and never trade recall below today's for precision: a lower
false-alarm count is not worth one missed scene.
