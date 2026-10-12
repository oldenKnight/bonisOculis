# bonis oculis: board review (product lead, kids-protection commission, non-technical parent)

Reviewed 2026-10-12, read-only. Method: read BRIEF, LEDGER, DESIGN (tone rules), both HELP files, both desktop
locales and the extension README; ran `npm run test:e2e` (passes, 104 shots); then drove the real Electron app
myself under xvfb with Playwright (fake analyzer with `--slow`, real mpv with `--vo=null --ao=null`), once as a
first-time English parent (`ud-en`) and once as a first-time Mexican parent (`ud-es`, OS locale es_MX, "Teens"
preset). mpv was driven over its own IPC socket to press keys inside the player window, as a child would. The
extension's popup and options pages were loaded as a real unpacked extension in Chromium 1194.

Screenshots referenced as `shots/...` are in
`/tmp/claude-0/-home-user-bonisOculis/c884b723-5904-58d7-b4c8-fd0bd22eb0c8/scratchpad/review-ux/shots/`.
Screenshots referenced as `e2e/...` are from my e2e run in `.../scratchpad/review-ux/e2e/shots/`, which matches the
implementer's set in `.../scratchpad/shots/`.

Severity: **blocker** means it must be fixed before this board can sign; **major** means a competitor or reviewer
would hold it against us in public; **minor** is polish.

---

## Summary of the worst problems

| # | Finding | Who it hurts | Severity |
|---|---|---|---|
| B1 | **Parent-mode play is fail-open.** A protected movie whose list is corrupt still shows "Protected · 4 scenes", plays with nothing skipped, and shows a green shield pill reading "0 scenes protected". | commission, parent | blocker |
| B2 | **mpv's built-in keys break the "never show the scene" promise.** `s` writes a sharp, full-size frame of the hidden or panicked scene to disk, in kid mode too. `` ` `` opens mpv's command console in kid mode. | commission, privacy | blocker |
| B3 | **The "Saved / Undo" toast covers the Approve and Reject buttons of the next scene** after every decision, at 1024x640 and at 1366x768. Clicks are blocked for about 10 s, and for as long as the mouse rests on the toast. | parent | blocker |
| B4 | **A child's panic press is silently auto-approved.** It is saved as an approved skip, so the parent is never told. There is no audit trail anywhere in the UI. | commission | blocker |
| B5 | **A scan that finds nothing makes the movie "Protected" for kids** without a parent ever looking. The help says kids see "only the movies you approved". | commission, product | blocker |
| M1 | The parents card says **"Kissing: None found ✓"** after the parent rejects (lets play) a kiss. It also says "None found" for kinds that were never checked. | product (CSM), commission | major |
| M2 | Unreviewed scenes are said to be "skipped anyway". Under the Teens preset a 66% kissing scene plays, while its own panel says "Skip: the movie jumps past this scene." | product, parent | major |
| M3 | **Check accuracy compares the list with itself.** The documented path (mark with I/O, save the skip file, choose it) gives a flawless 100% everywhere, with no warning. | product (honesty 6.5) | major |
| M4 | The Fire TV and macOS first-launch steps are not followable on current hardware and OS (details below). | parent | major |
| M5 | Levels measure detector certainty, not content severity. There is no per-movie filter choice and no pre-play summary (VidAngel/ClearPlay gap). | product | major |

---

## 1. Product lead (established family filtering service)

### P1. The parents card misreports content once the parent decides (major)
- **Screen:** Review › "What parents need to know". Shots: `shots/en-18-review-parentscard-bottom.png` (before),
  then the same card after I rejected the kissing scene (text captured in run `cmd-en/11.out`).
- **What is wrong:** Before review it reads "Kissing 1 scene · Mild". After I pressed Reject (meaning "let it play"),
  it reads **"Kissing: None found"** with a check mark. The kiss is still in the movie and will now play. The header
  chips drop "Kissing 1" too. The card counts what is filtered, not what the movie contains.
- **Why it matters:** Common Sense Media's card describes the *movie*. A second parent who opens this card is told
  there is no kissing in a movie that has an unfiltered kiss. That is the exact opposite of the card's purpose.
- **Fix:** Count every detected range, whatever the parent decided. Add a state per row: "1 scene · skipped" or
  "1 scene · plays (you allowed it)".

### P2. "None found ✓" for things we never looked for (major)
- **Screen:** parents card, every row (`shots/en-18-review-parentscard-bottom.png`; `parents-card.js` has no
  "not checked" state).
- **What is wrong:** If a movie has no subtitles and "Listen to speech" is off, Language still shows "None found ✓".
  The same happens to Implied when the caption budget ran out. A check mark next to "Sex — None found" reads like a
  certification from an automatic tool.
- **Why it matters:** A competitor's screenshot of "Sex: None found ✓" on a film with an implied scene is an easy
  attack. It also breaks DESIGN 14.1 rule 5 ("never safe, guaranteed").
- **Fix:** Use three states: "None found", "Not checked (no subtitles)" and "Checked lightly". Drop the check mark.
  Put "Found automatically; we can miss things" in the card footer.

### P3. Levels are certainty thresholds, not content levels (major)
- **Screen:** Setup step 4 "I'll choose" (`shots/en-08-preset-custom-scrolled.png`); Settings › Protection
  (`shots/en-32-settings-protection.png`).
- **What is wrong:** Every category has the same four explanations ("Skips only the scenes we are very sure
  about…"). Nothing says what Implied, Kissing or Gore cover, for example "any kiss, or only long ones?" or "blood
  and injury, or all fighting?". The intensity data (Mild / Moderate / Strong) exists but cannot be used as a
  filter, so a parent cannot ask to "skip strong gore and keep mild".
- **Why it matters:** ClearPlay and VidAngel sell severity-graded filters with a sentence each. Ours asks parents to
  reason about our classifier's confidence, which is the jargon DESIGN 14.1 rule 3 forbids in other words.
- **Fix:** Add a one-line definition per category ("Kissing: kisses on the mouth longer than a peck"). Make the
  level a severity-plus-certainty mix explained in parent terms, for example "Strict: skips even mild or uncertain
  kissing". Show intensity as a filter dimension in "I'll choose".

### P4. No pre-play summary and no per-movie filter choice (major)
- **Screen:** Library card › Play goes straight to Now playing (`shots/en-28-nowplaying-parent.png`, "2 scenes
  protected").
- **What is wrong:** VidAngel shows per-category toggles with counts before play, and ClearPlay shows a "filter
  settings" summary. Here the count only appears after mpv has started, as "2 scenes protected". That wording
  protects scenes rather than viewers. There is no way to say "tonight, allow kissing for this movie" without
  editing global settings or the review. The kid tile shows nothing at all.
- **Fix:** Before Play, show a sheet: "With your settings: Nudity 1 skipped · Gore 1 skipped · Kissing 1 plays.
  [Change for this movie] [Play]". Rename the pill to "2 scenes will be skipped".

### P5. "Approve" and "Reject" invert a parent's intuition (major, copy)
- **Screen:** Review side panel (`shots/en-19-panel.png`, `e2e/es-light-review-panel.png`).
- **What is wrong:** "Approve" on a Nudity scene sounds like approving the nudity. In Spanish, "Aprobar" /
  "Aprobada" next to "Desnudez" is worse. The list then says "Plays normally" for a rejected scene, so the two
  vocabularies disagree.
- **Fix:** Use the result as the verb: "Skip it" / "Let it play" (ES: "Omitirla" / "Dejar que se vea"). Use
  "Skip all 3 scenes" for the bulk button.

### P6. The flagged-scene list does not match what happens at playback (major)
- **Screen:** "Play before it is ready?" modal (`shots/es-06-play-anyway.png`) and the review panel
  (`shots/es-05-review-toast-over-buttons.png`).
- **What is wrong:** The modal says "Scenes not reviewed yet are skipped anyway". Under the Teens preset, the
  pending 66% kissing range is set to `none` by `buildPlaybackDoc`. Now playing then showed "2 escenas protegidas"
  out of 3, while the panel for that very scene says "Omitir — La película salta esta escena". Approving that scene
  silently overrides the parent's own Teens choice.
- **Fix:** In the panel and the list, show the effective action with the current levels ("With your Teens setting
  this plays"). Fix the modal sentence. Say on Approve that it overrides the level.

### P7. Honesty: the "Check accuracy" workflow compares a list with itself (major)
- **Screen:** More › Check accuracy (`shots/en-39-accuracy-empty.png`, `shots/en-40-accuracy-self.png`).
- **What is wrong:** Help and the screen say to mark scenes with I/O while watching, then use the saved skip file.
  But I/O marks are merged into this movie's own list, and "Save skip file" exports that same merged list. Choosing
  it produced "We caught 100%… missed 0 s… flagged 0 s" for every category, with no warning (`sameCopy: true` is
  even stored). The overall column is also labelled "(F1)", which is jargon.
- **Why it matters:** Brief 6.5 asks for honest per-category numbers. A competitor would screenshot "100%
  accurate" in five minutes.
- **Fix:** Add a separate "hand-marking session" whose marks never enter the movie's list, or refuse and warn when
  the truth file shares range ids or history with the current list. Drop "(F1)".

### P8. The human-curated vs automatic honesty note is missing (major)
- **Where:** in-app help, review screen, parents card.
- **What is wrong:** LEDGER's own quality board asks for "honest note that their catalogs are human-curated and
  ours is automatic + parent review" and "age-style guidance without pretending to be an official rating". Neither
  exists. The help's "How accurate is it?" never compares us with human-tagged services and gives no age guidance.
- **Fix:** Add a two-sentence note to the parents card footer and help#limits. Add an optional, clearly-labelled
  "Our scan suggests: fine for most ages 13+ with these skips" line, or say explicitly why there is none.

### P9. Scan notes are frozen in the scan's language (minor)
- **Screen:** `e2e/en-dark-review-panel.png`: English UI, note "Se detectó desnudez en la imagen."
- **Fix:** Store a note key plus parameters and render it at display time.

### P10. Copy, Spanish (MX)
| Where | Text | Problem | Severity | Fix |
|---|---|---|---|---|
| Queue drawer, while cards say "3 por revisar" (`shots/es-04-library-done.png`, `e2e/es-light-library-toasts.png`) | "Todas las películas están revisadas" | **revisar** means both "scan" and "parent review". The app claims everything is reviewed next to "3 por revisar". The same collision appears in "La estamos revisando", "Aún sin revisar" (= not scanned), "Revisar la precisión" and setup "las películas que tú revisaste". | major | Reserve *revisar/revisión* for the parent and *analizar/análisis* for the scan everywhere: "Todas las películas están analizadas", "Aún sin analizar", "Comprobar la precisión". |
| error.nothingLeft.text | "Revisa la revisión primero." | Tautology; reads as a bug. | minor | "Abre la revisión y deja pasar alguna escena." |
| review.markReviewed.text, help | "revisaste la película tú mismo" | Gendered, which breaks DESIGN 14.1 rule 10. | minor | "la revisaste por tu cuenta". |
| common.on / off | "Sí" / "No" next to switches | Odd for a switch state. | minor | "Activado" / "Desactivado". |
| preset.little-kids.desc (both languages) | "The safest choice" / "La opción más segura" | DESIGN 14.1 rule 5 forbids "safe". | minor | "The strictest choice" / "La opción más estricta". |
| player Lua `load_fail` | "Reproduciendo SIN protección." / "Playing WITHOUT protection." | Uppercase shouting; also a fail-open path (see K1). | minor | Remove it together with K1. |
| kid.title (EN) | "What shall we watch?" | British register; the US target is "What do you want to watch?". | minor | Change the string. |
| add.scanning | "3 movies added. We are checking **it** now." | Singular for a plural. | minor | Add plural keys. |
| acc.meta | "10/12/2026, 10:27:53 PM" | DESIGN 13.7 says "Oct 12, 2026". | minor | Use the design's date format. |

Tú is used consistently and I found no usted. Mexican vocabulary is right throughout (computadora, video, laptop,
memoria USB, groserías).

### What a competitor would mock
1. "Sex: None found ✓" on a card the app itself calls "What parents need to know".
2. "100% accurate on my own movie" from Check accuracy.
3. "0 scenes protected" in a green shield pill on an unfiltered movie (K1).
4. A child pressing `s` in "kid mode" and getting a sharp still of a skipped scene saved to disk (K2).

---

## 2. Kids-protection commission

### K1. Parent mode fails open on a corrupt list, and the library lies about it (blocker)
- **Shots:** `shots/en-52-library-corrupt.png` (still "Protected · 4 scenes"), `shots/en-53-play-corrupt.png`.
- **Reproduce:** Corrupt `library/<id>.bonis.json` (and its `.bak`, which simulates a disk error that hits both),
  then press Play in parent mode.
- **What happens:** The movie plays immediately with **"0 scenes protected" in a green shield pill**. The only
  feedback is a toast: "A file could not be read. We started that part fresh. Check your settings and the
  library." The scan and the review are gone (the file is renamed `.corrupt` and replaced with a blank list), and
  the library card keeps saying Protected afterwards (`shots/en-54-library-after-corrupt-play.png`). Families
  routinely watch together in parent mode. Brief 4.5 asks for *autorecovery*, not silent unprotected playback.
- **Kid mode is correct here:** the tile is refused (`shots/en-55-kid-after-corrupt.png`). It still shows "Ask a
  parent to scan and review it first", which is the wrong advice for a tampered list.
- **Fix:** Never auto-start an unprotected play in parent mode. Flip the status to "Needs attention" at once. Ask
  "This movie's scene list is damaged. Nothing would be skipped. [Scan again] [Play without skipping]". Restore
  from the last good copy kept in the HMAC'd index.

### K2. Screenshot and console keys in the player, including kid mode (blocker)
- **Evidence:** `shots/en-29-mpv-screenshot-during-panic.jpg` is a sharp 640x360 frame saved by mpv while the
  panic cover was on (`user-data/bonis.black=true`). `shots/kidshots/mpv-shot0002.jpg` is the same in kid mode,
  during a kid panic. mpv writes these files to its working directory, which it inherits from the app.
- **What is wrong:** Hide and panic are an OSD overlay. mpv's default `s` (screenshot), `S` and `Ctrl+s` bypass
  the OSD, so the "hidden" scene is written to disk at full size. Only seek keys are intercepted in kid mode.
  `` ` `` opens mpv's console in kid mode: I typed `set speed 4` and it ran. A console seek into a skip range was
  pushed back out by the safety net, which is good. Still, a "locked" player with a command line is not
  defensible, and DESIGN/D8's "no clear flagged frame ever touches disk" is false.
- **Fix:** Launch mpv with `--input-default-bindings=no` (and `--load-scripts=no` plus the explicit bonis script),
  rebind only the keys the app documents, and set `--screenshot-directory` to an unwritable path or turn the
  screenshot command off.

### K3. A kid's panic press is never shown to a parent; no audit trail (blocker)
- **Evidence:** After a kid-mode panic (run `cmd-en/` around 22:28), the skip doc has
  `{source: 'panic', review: 'approved'}`. History says only `"event":"panic","detail":"panic"`, with no kid or
  parent marker. The library still says "Protected · 4 scenes" (`shots/en-49-library-after-kid-session.png`). No
  screen shows `history` at all (`grep history desktop/renderer` finds nothing). PIN failures, unlocks, level
  changes such as Nudity → Off, and "Play anyway" are not recorded anywhere a parent can see.
- **Why it matters:** A child pressing panic is the strongest signal that the scan missed something. LEDGER lists
  "audit trail of what was changed and when" as a commission requirement.
- **Fix:** Save kid panics as `pending` with a "Your child hid this" badge, put a banner on the library after
  unlock ("During kids' time: 1 moment hidden in The Lighthouse Keeper. Review it."), and add an Activity page
  (unlocks, wrong PINs, setting changes, plays without protection).

### K4. Zero detections means auto-approved for kids (blocker)
- **Shot:** `shots/en-15-library-done.png` ("Sunny Garden — Protected · 0 scenes", Play). It appears in the kid
  grid (`shots/en-41-kid-home.png`) and a toast says "Kids can play it now".
- **What is wrong:** An automatic scan that finds nothing is the most likely silent miss: no subtitles, a dark
  film, gore. The kids' screen is fed without a single parent action. The help and setup copy say kids only see
  "movies you approved". That is not true here.
- **Fix:** Put zero-detection titles in "To review" with "We found nothing. Look over the card and confirm before
  kids can watch." Approval is one click, but it is an explicit one.

### K5. Parent mode never re-locks (major)
- **What is wrong:** There is no idle auto-lock and no lock after a movie ends (searched main and renderer for any
  idle logic; none). A parent who unlocks and walks away leaves Settings, "Play anyway" on unscanned titles and
  Remove open to a child.
- **Fix:** Auto-lock after 10 minutes idle (configurable), and when the window loses focus while "Open in kid
  mode" is on.

### K6. Peek is sharper than the design and help promise (major)
- **Shot:** `e2e/es-light-review-peek.png`. The colour bars and the diagonal line become crisp.
- **What is wrong:** `thumbs.js` renders a **live 640 px frame** for peek, shown with a 5 px CSS blur. DESIGN 12.3
  justifies peek because "the stored file is already boxblurred", so faces and bodies stay unrecognisable. That is
  no longer true with a live 640 px source, and help says "The picture is still soft". With real nudity, 5 px on
  640 px is recognisable.
- **Fix:** Peek from a 160 px, boxblurred live frame, then apply the 5 px blur. Or change the help and design
  claims to match the real behaviour.

### K7. Kid-facing copy (minor)
- After two player crashes in kid mode, the child sees "The player closed again. **Your marks are safe.** Try once
  more, or restart the computer…" (`shots/en-46-kid-after-kill-2.png`). The child has no marks.
- A tampered or refused title still shows its tile, and pressing it gives "Ask a parent to scan and review it
  first" (`shots/en-42-kid-tampered-click.png`).
- **Fix:** Use kid-mode strings ("The movie stopped. Ask a grown-up for help.") and hide tiles that are not
  playable.

### K8. Weak PINs accepted silently (minor)
- **Evidence:** `1234` was accepted at setup without a word (`shots/en-04-pin-typed.png`).
- **Fix:** Refuse or warn on 0000, 1234, 1111 and repeated or sequential PINs ("Kids guess this one first").

### Fail-closed checks that PASSED (credit where due)
- Kid mode refuses unscanned, unreviewed, tampered (valid JSON with one range removed) and corrupt titles. The
  untampered file restores playability.
- While locked, `skip:get`, `library:add`, `library:remove` and `export:json` all answer `locked`, and
  `player:play {kidMode:false}` is forced to kid mode.
- Killing mpv during a kid session relaunches it with `kidmode=1`, the same list and the last position
  (`shots/en-45-kid-after-kill-1.png`). A second kill ends the session and returns to the kid grid.
- A kid-mode console seek into a skip range was pushed to the range end. The OSC seek bar is hidden in kid mode.
- No peek control, ranges or timeline exist in kid mode. The poster re-blurs once a new range touches it (the Lighthouse tile blurred after
  the kid panic).
- The bypass note ("A person with an administrator account… can get around it") is honest and plain in both
  languages. The extension README is honest about having no PIN.

### Extension (seen statically; commission view)
- There is no PIN, and "Olvidar todo / Forget everything" sits one click away on the options page
  (`shots/ext-options-es.png`), so a child can wipe every saved moment and setting. The README admits this. The
  board still expects at least a confirmation that names the consequence.
- In a fresh Chromium profile the options page said "No shortcut yet" for the panic key, while the README says it
  shows Alt+Shift+P. This may be an automation artifact. Even so, the popup should warn when no panic shortcut is
  assigned (`shots/ext-popup-en.png` says nothing).
- The extension's level picker has no per-level explanations, unlike the desktop app.

---

## 3. Non-technical parent with low tolerance for frustration

### N1. Toast blocks the review buttons (blocker)
- **Shots:** `shots/en-20-toast-covers-panel.png`, `shots/es-05-review-toast-over-buttons.png`.
- **What happens:** After Approve, the panel jumps to the next scene and the "Saved / Undo" toast lands exactly on
  top of its Approve and Reject buttons. Measured: toast at y 399–525, buttons at y 472–516. It also overlaps at
  1366x768. Playwright's click on Reject failed for 30 s: "toast subtree intercepts pointer events". The toast
  stays while hovered, and the parent's mouse is right there.
- **Fix:** Put review toasts top-centre (or inside the panel), or make the toast region `pointer-events: none`
  except for its own buttons and avoid the panel footer. Better still, show the "Saved · Undo" inline in the
  scene row.

### N2. Time to first protected movie: about 2 minutes in my run, but the path has traps
From launch to the first title showing "Protected" took about 2 minutes, with the fake analyzer and a 3-scene
review. Real scans add 30–60+ minutes; the wizard says so only in Help. Confusion points, in order:
1. Setup step 4 at 1024x640: **Continue is below the fold**, with only a teal sliver visible
   (`e2e/es-light-setup-4-preset.png`). The PIN step also scrolls. (minor)
2. Recovery code: there is no Print or Copy button. Paper only, and "we show it only this once". (minor)
3. The wizard never mentions that a scan takes up to an hour, or that kids cannot use the movie until the parent
   reviews it. (major: the first-run expectation is wrong)
4. Library at 1024 wide: the sidebar is **icons only**, with native `title` tooltips after a hover delay
   (`shots/en-13-hover-lock.png`). "To review" is an eye, the same as the logo. "Lock for kids" is a bare padlock
   at the bottom. Help tells parents to use "**Lock for kids** at the bottom of the side bar", but at 1024 that
   label is not visible. (major for lock discoverability)
5. The error toast "We could not open that file" does not say which file (`shots/en-11-library-scanning.png`).
   (minor)
6. The review list at 1024x640 is a 120 px scroll strip under the timeline (`shots/en-17-review-overview.png`).
   With 30 scenes that is painful. (minor)
7. Send to TV at 1024x640: the action buttons are below the fold, behind the queue drawer
   (`shots/en-34-export.png`, `e2e/es-light-export.png`). The card order is Skip file, then Kodi, then Clean copy,
   the reverse of help, which calls the clean copy "Easiest". It also lets you make a clean copy of an unreviewed
   movie with only an inline warning (`shots/en-37-export-clean-unreviewed.png`). (major)

### N3. Keyboard-only use (major)
- Setup works by keyboard (digits, Enter, Space on the switch).
- Review: pressing Enter on a scene row **drops focus to `<body>`**. Reaching Approve then takes 17 Tab presses
  through note, segmented control and eight nudge buttons (log in `cmd-en/` probe). There are no A/R or
  skip/let-play shortcuts. DESIGN 7.13's "`?` cheat sheet in the review screen" does not exist (no `'?'` handler).
- **Fix:** Move focus to the panel's Approve on selection, add single-key shortcuts with a `?` sheet, and put the
  Approve/Reject footer before the edge controls in tab order.

### N4. Panic key discoverability (major)
- The panic key lives in Help, in Settings › Playback and on the Now playing page *below the fold*
  (`shots/en-28-nowplaying-parent.png`). The movie opens in its own (usually full-screen) mpv window, which shows
  no reminder: `bonis.lua` has no start-up OSD.
- **Fix:** Show a 4-second OSD on every start ("Press P to hide the screen at once"). Put the panic keycap in the
  Now playing header and in the kid-mode Now playing card.

### N5. Help's Fire TV steps are not followable on a Hisense Fire TV (major)
Each step was checked against a 2023–2026 Fire TV Edition set (Fire OS 7/8):
1. "**Settings > My Fire TV > Developer options**": on Fire TV smart TVs the menu is **Settings › Device &
   Software**, and Developer Options is **hidden** until you open About and click the device name 7 times. Neither
   is mentioned.
2. "Allow apps from unknown sources, then install Downloader": the order is backwards on current Fire OS. Unknown
   sources is **per app**, so Downloader must be installed first, then allowed under Developer Options › Install
   unknown apps › Downloader.
3. "Use it to install Kodi from kodi.tv": a parent then meets the Kodi download page and must choose **Android ›
   ARMV7A (32BIT)**. Nothing says so, and the 64-bit build will not install on most Fire TVs.
4. USB path: when a stick is plugged in, Fire TV offers to **format it as internal storage**, which would erase the
   movie. Help must say "choose **View** / do not format".
5. "Open VLC, go to **Browse**": in VLC for Fire TV the USB drive is under "Browsing" › the drive name. That is
   close enough, but there is no screenshot.
6. "a shared folder Kodi can reach" is left unexplained.

**Fix:** Rewrite the TV page as numbered steps with exact menu names for Fire OS 7/8, the 7-click unlock, the
per-app permission, the exact Kodi build, and the "don't format" warning. Add a picture per step if possible.

### N6. Unsigned-build first-launch guidance is unreachable and partly outdated (major)
- The first-launch instructions live **inside the app's Help** (`e2e/en-light-help.png`), which a parent cannot
  open until they are already past Gatekeeper or SmartScreen. `packaging/README.md` relies on it ("the help covers
  it").
- On macOS 15 Sequoia and later, Control-click › Open **no longer bypasses Gatekeeper**. The path is: open once,
  get "Not Opened", go to **System Settings › Privacy & Security › Open Anyway**, then enter the Mac password. The
  current Mac steps will fail on every Mac sold since 2024.
- **Fix:** Ship the steps outside the app (DMG background or README in the DMG, the installer page, the download
  page), and update them for Sequoia.

### N7. Dark theme and fit
Both dark themes are readable and consistent (`e2e/en-dark-review-panel.png`, `e2e/es-dark-kid.png`). No
horizontal scroll at 1024x640. The Help table of contents highlights "Watching on your TV" while the page sits at
the top (`e2e/en-light-help.png`), which is a minor scroll-spy bug.

### Error messages: "what do I do now?" audit
Most errors end with an action, which is good. The exceptions:
- "A file could not be read. We started that part fresh. Check your settings and the library." Check *what*? This
  appears right before an unprotected play (K1).
- The kid-mode crash toast suggests "restart the computer" to a child.
- "That did not work. Try once more" (`error.failed`, `error.badPayload`) is generic, but acceptable.

---

## Verdicts

**Product lead: FAIL.**
Blockers: B5 (auto-protect on zero findings, which contradicts our own copy) and P1 (the parents card hides
content the parent allowed).
Majors that keep us below VidAngel, ClearPlay and CSM: P2, P3, P4, P5, P6, P7, P8. Also the *revisar* /
*analizar* collision in Spanish. The look and the tone are better than all three benchmarks. The substance of the
parents card, the levels and the pre-play summary is not there yet.

**Kids-protection commission: FAIL.**
Blockers: K1 (parent-mode fail-open with a green "0 scenes protected"), K2 (mpv screenshot and console keys,
including in kid mode), K3 (silent kid panic, no audit trail), K4 (zero findings auto-approved for kids).
Majors: K5 (no auto-lock), K6 (peek sharper than promised).
Kid-mode gating itself (refusal of unscanned, unreviewed, tampered and corrupt titles, locked IPC, crash relaunch)
passes and is well built.

**Non-technical parent: FAIL.**
Blocker: N1 (the toast blocks Approve/Reject after every decision).
Majors: N5 (Fire TV steps not followable), N6 (unsigned-launch guidance unreachable and wrong on current macOS), N4
(panic key invisible in the player), N3 (review not keyboard-friendly), N2.3 and N2.4 (scan time unannounced,
icon-only sidebar at 1024).
Spanish and English copy is otherwise warm, plain and consistent.
