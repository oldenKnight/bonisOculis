# bonis oculis: board review round 3 (product lead, kids-protection commission, non-technical parent)

Reviewed 2026-10-13, read-only, against HEAD `b4d564b`. The round-2 fix commits are `6a2f66b` (extension),
`c9d8755` / `72945b0` (wip checkpoints) and `7081f56` (app). I changed no repository file; `git status` is clean.

## Method

- Read round 2 (`docs/reviews/2026-10-13-board2-product-parent.md`) and `docs/LEDGER.md` (D25, findings, milestones).
- Ran `xvfb-run -a node desktop/test/e2e/app.e2e.js` (work and shots in `review3-ux/e2e-work`, `review3-ux/e2e-shots`).
  Result: **passed**, with 129 screenshots and 63 on-disk images, all blurred or proven clean.
- Drove the real Electron app twice with my own Playwright driver (`review3-ux/driver.js`). Both runs used real mpv
  (`/usr/bin/mpv`, `BONIS_PLAYER_VO=null BONIS_PLAYER_AO=null`), `tools/fake-analyzer.js --slow`, and
  `BONIS_USER_DATA=review3-ux/ud-{en,es}`.
  - **en** run: OS locale en_US, "Little kids" preset, 1024x640. Later switched to es-MX in Settings to test P9.
  - **es** run: OS locale es_MX, "Teens" preset, 1024x640 and 1366x768.
  - I sent keys and seeks to mpv over its own IPC socket (`keypress p`, `i`/`o`, `seek`, `quit`) to check what the
    player really skips and what happens at the end of a movie.
- Ran `node tools/make-first-launch.js review3-ux/first-launch` (to the scratchpad, not `build/`) and read both files.
  Read `electron-builder.yml` and `.github/workflows/build.yml`. `node --test packaging/test/packaging.test.js`
  passes 12/12, including "first-launch files … shipped by DMG and CI".
- Loaded the real unpacked extension in Chromium 1194 (`review3-ux/ext.js`). Popup and options were opened as
  extension pages. `chrome.tabs`/`chrome.commands` were stubbed in the popup only, to get a ready tab with saved
  moments and both shortcut states. Output: `review3-ux/ext-out.json`, screenshots in `review3-ux/extshots/`.
- Page errors: none in any run.

Paths: `shots/…` = `/tmp/claude-0/-home-user-bonisOculis/c884b723-5904-58d7-b4c8-fd0bd22eb0c8/scratchpad/review3-ux/shots/`,
`extshots/…` = `…/review3-ux/extshots/`.

---

## 1. Status of every round-2 item

### Round-2 new findings X1 to X14

| # | Round-2 finding | Status | Evidence |
|---|---|---|---|
| X1 | Category names break mid-word on the parents card ("Des/nud/ez", "Kissi/ng") | **fixed** | The name now sits on its own line above the status. My check found no single word wrapping or clipping on the card in es at 1024x640 or 1366x768, or in en at 1024x640 (`shots/es-06-review-1024.png`, `shots/es-07-review-1366.png`, `shots/en-05-review.png`). |
| X2 | Footer says "checked by you" on unreviewed titles (product blocker) | **fixed** (small residual N-R3) | Unreviewed: "Found automatically — not yet checked by a parent." / "Se encontraron automáticamente; ningún adulto las ha revisado todavía." After every scene was decided: "…then checked by you on Oct 13, 2026." See N-R3 for the child-panic case. |
| X3 | No system requirements; an M1 on macOS 13 installs and cannot play | **fixed** | Help › "What you need" / "Qué necesitas" is the first Help section in both languages (`shots/es-10-help.png`). The same text is in INSTALL and both first-launch .txt files. The arm64 CI job passes `-c.mac.minimumSystemVersion=14.0`, so macOS itself refuses to open the app on 12–13 instead of failing at Play. Intel stays at 12.0. Residual (polish): nothing tells an M1-on-13 parent what to do next (update macOS, which is free, or use the x64 build under Rosetta). |
| X4 | Keys card says 10 s, the player seeks 5 s | **fixed** | "Back or forward 5 seconds" / "Back or forward 1 minute" in Now playing and Settings (`shots/en-17-nowplaying.png`). |
| X5 | Parent toasts survive the switch to kid mode | **fixed** | I raised "No pudimos abrir “notas.mp4”" and then pressed Lock: the kid screen showed no toast (`shots/es-09-kid.png`). After the idle and blur locks the kid screen was also clean. |
| X6 | Toasts cover primary content and draw above modals; persist across navigation | **partly** | Fixed: toasts now sit under the modal scrim (`shots/en-31-corrupt-play.png`), and success toasts are dismissed on route change. Still open: at 1024x640 an error toast covers the library's "Revisar" and "Se ve bien: aprobar para niños" buttons (measured overlap; `shots/es-14-toast-library-1024.png`). Error toasts persist across routes **and across a language switch**: an English "The scene list … is damaged" toast stayed over the Spanish review timeline (`shots/es-x-review-mountain.png`). |
| X7 | Opening the review clears the child-panic flag at once | **fixed** | I opened the review from "Take a look", selected nothing and went back: the card still read "A moment was hidden — take a look". The list row reads "Hidden during playback — not looked at yet". Selecting that row cleared the flag ("Protected · 3 scenes"). Panel: "Hidden with the panic key in kid mode." (`shots/en-27-review-panic.png`, `en-28-panic-panel.png`). Polish: "Take a look" opens the review without selecting the hidden scene. |
| X8 | A damaged list shows "Protected · 3 scenes" until something reads it | **not fixed** | I damaged `library/<id>.bonis.json` and `.bak`, then navigated Settings → Library: the card still read "Protected · 3 scenes" (`shots/en-30-corrupt-library.png`). Play then asks correctly. It stays safe (kid mode refuses), but the status is wrong. |
| X9 | Activity shows raw values ("Language: en-US", "teens", "Setup finished: On"); crashes not logged | **fixed** | "Se cambiaron los ajustes: Idioma: Español (México)"; "Bloquear al cambiar a otra app: Activado"; "Locked for kids when you switched to another app". A `playerStopped` entry exists (code; not reproduced live). Nit: "Settings changed: First setup finished" reads oddly. |
| X10 | Invented intensity on hand and panic marks | **fixed** | "Other 1 found · skipped" with no intensity dots (en and es cards). |
| X11 | A 0.3 s hand mark listed as "0 s" | **fixed** | "Other 0:51 – 0:51 · <1 s". |
| X12 | Damaged-list modal title contradicts its body | **fixed** | "This movie's scene list is damaged. Play it without protection?" |
| X13 | Accuracy: own list detected only by id; no way to make an independent list | **partly** | A copy under a new id is now refused when its auto range ids match (`accuracy.js`). There is still no in-app way to mark a separate comparison list, so a lone parent cannot use the feature. The screen copy suggests "a list a friend made". |
| X14 | "Windows protegió **tu** PC" | **fixed** | "Windows protegió su PC" in Help, INSTALL and PRIMER-INICIO.txt. |

### Round-1 items that were open after round 2

| # | Item | Status | Evidence |
|---|---|---|---|
| P2 | No "checked lightly" state (caption budget covers part of a film) | **not fixed** | The card has only Not checked / None found / found states. A Little-kids setup shows "None found" for Sex and Implied after a 300-shot caption budget. Language Off shows "No se analizó", which is honest. |
| P3 | Intensity is not a filter ("skip strong gore, keep mild") | **not fixed** | No intensity setting anywhere. The levels say "mild or strong", which is honest about it. |
| P4 | No per-movie filter choice | **fixed** | "For this movie" / "Solo para esta película" in the review and in the pre-play sheet. I set Kissing and Gore Off for "Mountain Story". The sheet then said "1 scene will be skipped · 2 will play (below your level) · This movie uses its own levels". mpv agreed: 11.5 → 15.9 (Nudity skipped), 27.2 → 28.8 and 42.2 → 43.8 (played). Activity logs "Levels for “Mountain Story” only were changed". Nit: with a level set to **Off**, rows still say "Below your Kissing level" (see N-R5). |
| P9 | Scan notes frozen in the scan's language | **fixed** | Notes are now template sentences rendered in the UI language. I switched an en-scanned title to es-MX and got "Posibles besos intensos. Se ve en la imagen y el diálogo lo confirma." `desktop/test/notes.test.js` checks the JS port against `analyzer/bonis_analyzer/notes.py`. Notes a parent edits are kept as written. |
| P10f | Lua "Playing WITHOUT protection." (shouting) | **fixed** | `player/bonis.lua:61` / `:84`: "Playing without protection." / "Reproduciendo sin protección." |
| K5 | Never relocks after a parent-mode movie; no lock on focus loss | **partly** (commission condition, see N-R1) | Lock on app switch: Settings › PIN "Lock when I switch to another app". With it on, a real focus loss locked within 1 s, and Activity logged "Locked for kids when you switched to another app". It is **off by default**, even with "Open in kid mode". Closing the movie window after the idle time had run out locked at once (`shots/en-21-after-close-window.png`). **But** at the end of the movie (EOF, mpv `keep-open`) the app stays unlocked on Now playing for as long as nobody touches it. Pressing the app's **Stop** counts as activity, resets the timer and lands in the unlocked parent library (verified: idle set to 6 min ago with 5-min lock; EOF → still unlocked; Stop → unlocked library). Help claims "the app locks as soon as the movie ends", which is false for both of these routes. |
| Ext-1 | Extension: no PIN; one-click "Forget everything" | **fixed as far as possible without a PIN** | Options › "Forget everything" now replaces itself with a red box: "This removes all your choices, imported skip files, subtitle files and hidden moments from this browser. The scenes they covered will play. This cannot be undone." Focus lands on **Keep it**, and Enter there forgets nothing (settings still in storage). The popup's new "Forget my hidden moments" has the same two steps: "These moments will play again on this video." The first click forgot nothing, Enter on Keep forgot nothing, and Yes forgot. A no-PIN note with a Family Link help link appears in the popup's levels section and in options › limits, in both languages (`extshots/popup-es-nokey-confirm.png`, `extshots/options-*-confirm.png`). The extension still has no PIN; the note says so plainly. |
| Ext-2 | No warning when the panic shortcut is unassigned | **fixed** | With no shortcut, a red banner sits at the top of the popup: "The panic key has no shortcut right now … Choose a shortcut", and the button opens `chrome://extensions/shortcuts`. With Alt+Shift+P assigned there is no banner, and the hint names the keys (`extshots/popup-en-nokey.png`, `popup-en-key.png`). In this fresh Chromium the real `chrome.commands` state was indeed unassigned, so the banner is not hypothetical. |
| Ext-3 | Extension level picker has no explanations | **partly** (unchanged) | One-line level descriptions exist (`levelStrictDesc` …) but are `display:none` until a row is focused or changed (`extension/css/ui.css:118-119`). There are no category definitions, unlike the desktop app. New: "Moderado" is clipped to "Moderad" in the Spanish popup at 380 px (N-R4). |
| N2.1 | Setup Continue below the fold at 1024x640 | **fixed** | Step 4 Continue at y 525–581 in a 613-px viewport, en and es (`shots/en-02-preset.png`). The recovery-code Continue is at 530–586. |
| N2.2 | Recovery code: no Print | **not fixed** (polish) | Only "Copy the code", still with a download icon. |
| N2.5 | Error does not name the file | **fixed** | "We could not open “notas.mp4”" / "No pudimos abrir “notas.mp4”". |
| N2.6 | Review list is a strip at 1024x640 | **not fixed** | The list starts at y 525 of 613, so one row shows (`shots/en-05-review.png`, `es-06-review-1024.png`). At 1366x768 three rows show (`es-07`). The new "For this movie" button added a row of actions above it. |
| N2.7 | Send to TV buttons below the fold | **partly** | For a title with scenes still waiting, the yellow "3 escenas … esperando tu revisión" banner pushes all three action buttons below the fold at 1024x640 in Spanish. "Hacer una copia limpia" bottom is at 630 > 613 (`shots/es-11-export.png`). |
| N3 | `?` shortcut sheet | **not fixed** (polish) | No `?` handler. The inline key legend in the panel remains. |
| N5 / M4 | Kodi path stops at Videos › Files | **fixed** | Steps 13–15 add the storage **Allow** prompt and **Add videos… › Browse › (stick) › OK › OK**, "once per stick", then play from Videos › Files. Nit: Kodi on Android often lists the stick by a volume id ("/storage/1A2B-3C4D") rather than its name. |
| N6 | First-launch steps not shipped next to the installer | **fixed** | `tools/make-first-launch.js` writes FIRST-LAUNCH.txt and PRIMER-INICIO.txt: plain text, BOM, CRLF, 76-column wrap, with the same steps as Help, including requirements, the Sequoia "Open Anyway" path and SmartScreen. CI runs it before electron-builder. `dmg.contents` places both files in the DMG window next to the app and the Applications link. CI copies both into `dist/electron/` and uploads them with the installers. Residual: there is no release/publish step. On Windows the .txt files sit next to the .exe only in the CI artifact zip, so whoever publishes the download must carry them along. |
| Err-1 | "Check your settings and the library." | **fixed** | Per-file toasts: settings back to Little kids with where to change them; library starts empty; queue lost, press Scan. |

### Round-2 specific board checks, re-run

1. **The pre-play summary matches what the player skips: PASS**, including per-movie levels (P4 above).
2. **The parents card states per category: PASS.** The footer is now honest, and the residual is N-R3.
3. **Check accuracy refuses the own list: PASS.** The id-match refusal was extended to range ids.
4. **Toasts never overlap review-panel buttons: PASS.** Library overlap remains (X6).
5. **Relock: PARTLY.** Idle and lock-on-switch work. The end-of-movie route does not lock (N-R1).
6. **Fire TV steps are followable: PASS** (Kodi completed).
7. **INSTALL docs shipped: PASS** (DMG contents and CI artifacts).

---

## 2. New findings (round 3)

| # | Screen | What | Why it matters | Severity | Fix |
|---|---|---|---|---|---|
| N-R1 | Now playing (parent mode) → end of movie | mpv runs with `--keep-open=yes`. At EOF the session stays alive (`player-service.js` sends `eof`, not `ended`), and `idle.js playing()` is still true, so the app never locks after the movie ends. Pressing the app's **Stop** is a `pointerdown`, which `touch()`es the idle timer, so the next screen is the **unlocked** parent library with a fresh 5–10 minutes. Verified live: 5-min lock, idle set 6 min back, seek to 99 % → EOF → unlocked after 10 s; Stop → unlocked library. Help (`docs/HELP/en-US.md:100`) says "the app locks as soon as the movie ends". | This is the exact K5 scenario: a parent starts a movie for the kids in parent mode and walks away. Only closing the movie window locks. | **major (commission condition)** | Treat EOF as the end of play for the idle check (or end the session about 10 s after EOF). When the idle time already ran out during the movie, lock **before** handling the Stop click, and do not count that click as presence. Make "Lock when I switch to another app" default on when "Open in kid mode" is on. Fix the Help sentence. |
| N-R2 | Extension popup, levels (es) | "Moderado" is clipped to "Moderad" in every row at the popup's 380 px width; in English "Moderate" touches both edges (`extshots/popup-es-nokey-confirm.png`, `crop-es-levels.png`). | The Spanish popup looks broken on its most important control. | minor | Let the segment labels shrink (`font-size` step), show the bars only, or stack two by two under 400 px. Add a no-overflow assertion to the extension test. |
| N-R3 | Parents card after a child panic | After a kid-mode panic adds an unseen "Other" range, the card footer still says "…then checked by you on Oct 13, 2026" while the list says "Hidden during playback — not looked at yet". | A small honesty gap on the card that X2 fixed: one scene on that card was not checked by a parent. | minor | While `panicUnseen` has ids, show "1 moment your child hid is waiting for you" instead of the "checked by you" footer. |
| N-R4 | Library, toasts | Error toasts do not dismiss on navigation and are not re-rendered on a language change. An English damaged-list toast stayed over the Spanish review timeline. | Mixed languages on screen. | minor | Store toasts as keys plus params and re-render them on `i18n.onChange`. Dismiss error toasts on route change once their title is shown in place (the card already says "Needs attention"). |
| N-R5 | Review list / pre-play with a level set to **Off** | Rows say "Below your Kissing level — will play unless you skip it" when Kissing is Off for this movie; the pre-play sheet says "2 will play (below your level)". | "Below your level" implies a threshold; Off means "not filtered at all". A parent may think a gentle filter is still on. | minor | When the effective level is `off`: "Kissing is off for this movie — it will play unless you skip it". |
| N-R6 | Send to TV (es, unreviewed title) | All three action buttons are below the fold at 1024x640 when the "waiting for your review" banner shows (N2.7 above). | The parent sees three cards and no buttons. | minor | Shorten the banner to one line with a "Review" link, or put the buttons under each card's title. |

Things I tried that held up: no page errors. The e2e passes. The wrong-PIN guard and weak-PIN refusal work. The
damaged-list Play modal fails closed. Kid mode shows only approved titles. Child panic is enforced, flagged and
logged. Lock-on-switch works and is logged. Notes, Activity and the parents card are clean in both languages. There
is no horizontal scroll at 1024x640 or 1366x768. The first-launch .txt files are readable in plain-text editors
(BOM + CRLF).

---

## 3. Verdicts

The bar (brief section 5) is to beat VidAngel's extension, ClearPlay's app and Common Sense Media's card.

**Product lead: PASS (conditional; no blockers).**
- The round-2 blocker X2 is fixed and verified: the card says "not yet checked by a parent" until it is true.
- The flagship card no longer breaks words in either language.
- Notes follow the UI language.
- Per-movie levels exist, go through the one enforcement path, and mpv was verified against the sheet.
- On honesty and per-scene control this now beats ClearPlay's app, which offers per-movie filters but no
  per-scene review, and it matches the shape of Common Sense Media's card without pretending to be a rating.

Open majors to schedule (not release blockers for a beta):
- **P3**: no intensity filter. ClearPlay and VidAngel both offer finer granularity.
- **P2**: no "checked lightly" state for a capped caption budget.

Polish: N-R5, N-R3, X13 (accuracy is a dead end for a lone parent).

**Kids-protection commission: PASS (conditional).**
- Round-2 conditions X7 (panic flag) and X5 (parent toasts on the kid screen) are met and verified.
- The extension conditions are met as far as a no-PIN extension can meet them: a two-step forget that names the
  consequence, with focus on the safe choice; a red missing-shortcut banner with a fix; and an honest no-PIN note
  with Family Link guidance.
- K5 is **not fully met**. Lock on app switch exists but is opt-in. The end-of-movie route (EOF + Stop) still
  hands an unlocked parent library to whoever is at the keyboard, while Help says it locks (**N-R1**).

Condition before release: fix N-R1, make lock-on-switch the default for "Open in kid mode" setups, and correct the
Help sentence. X8 (wrong "Protected" label on a damaged list) is safe in behaviour but should be fixed together
with it.

**Non-technical parent: PASS (conditional; no blockers).**
- The round-2 blocker N6 is fixed: FIRST-LAUNCH.txt / PRIMER-INICIO.txt are generated from the INSTALL docs, sit
  in the DMG window and next to the installers in CI, and give the right Sequoia and SmartScreen steps in both
  languages.
- X3 is fixed: requirements are in Help, INSTALL and the .txt files, and the arm64 DMG declares macOS 14 so the
  Mac refuses up front.
- The Kodi path can now be followed to the end.
- Setup Continue is above the fold, errors name the file, and the keys card is right.

Remaining friction:
- **N2.6**: at 1024x640 the review list shows one row. This is the parent's main working screen; fix before 1.0.
- **N2.7 / N-R6**: Send to TV buttons are below the fold in Spanish when scenes are waiting.
- X6: toasts over library buttons.
- N-R2: the Spanish popup level labels are clipped.
- No Print for the recovery code.
- Publishing: whoever publishes downloads must put the two .txt files next to the .exe and .dmg links; CI only
  uploads them as artifacts.

### Blockers summary
- Product lead: none.
- Commission: one condition, **N-R1** (and make lock-on-switch the default with "Open in kid mode").
- Parent: none; N2.6 is the top major.
