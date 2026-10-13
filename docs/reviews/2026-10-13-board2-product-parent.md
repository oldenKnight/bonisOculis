# bonis oculis: board review round 2 (product lead, kids-protection commission, non-technical parent)

Reviewed 2026-10-13, read-only, against HEAD `5354e4a` (fix commits `cec42c1`, `f0507bb`). No repository file was
changed (`git status` is clean).

## Method

- Read round 1 (`docs/reviews/2026-10-12-board-product-parent.md`) and `docs/LEDGER.md` (D25, polish backlog).
- Ran the implementer's e2e myself: `xvfb-run -a node desktop/test/e2e/app.e2e.js` with output in
  `review2-ux/e2e-work`. It **passed** with 126 screenshots in `review2-ux/e2e-shots/` (every screen, both languages,
  both themes, 1024x640). I looked at all of them through contact sheets in `review2-ux/sheets/`.
- Drove the real Electron app three times with my own Playwright driver (`review2-ux/driver.js`): real mpv
  (`/usr/bin/mpv`, `BONIS_PLAYER_VO=null BONIS_PLAYER_AO=null`), `BONIS_USER_DATA` under `review2-ux/ud-*`.
  - **en** run: a first-time US parent, OS locale en_US, "Little kids" preset, fake analyzer `--slow`.
  - **es** run: a first-time Mexican parent, OS locale es_MX, "Teens" preset, fake analyzer `--slow`.
  - **real** run: `BONIS_ANALYZER='{"cmd":"python3","args":["-m","bonis_analyzer.cli"],"cwd":"/home/user/bonisOculis/analyzer"}'`,
    `BONIS_MODELS_DIR=.../scratchpad/models`, one 30 s testsrc2 + sine clip.
- Sent keys into mpv over its own IPC socket (`keypress`), as a child at the keyboard would, plus seeks to check
  which ranges the player really skips.
- Screenshots: `shots/...` = `/tmp/claude-0/-home-user-bonisOculis/c884b723-5904-58d7-b4c8-fd0bd22eb0c8/scratchpad/review2-ux/shots/`;
  `e2e/...` = `.../scratchpad/review2-ux/e2e-shots/`.

Real-analyzer result: the scan ran every stage (subtitles skipped, then speech, frames, audio and captions all
`done`) and finished in 33 s. The card reached **"Nothing found — check it"** (needs review), not Protected, and the
title was not on the kids' screen (`shots/real-02-library-done.png`, `shots/real-03-review.png`). **Pass.**

---

## 1. Round-1 findings: status

| # (alias) | Round-1 finding | Status | Evidence |
|---|---|---|---|
| B1 / K1 | Parent mode fails open on a damaged list; the library says Protected; green "0 scenes protected" | **fixed** (small residual) | I damaged `library/<id>.bonis.json` and `.bak`, then pressed Play: a modal asks "Play it without protection?" with Cancel / Scan again / Play without protection, and mpv stays idle (`shots/en-38-play-corrupt.png`). After Cancel the card reads "Needs attention — scene list damaged" (`shots/en-39-library-corrupt-after.png`). Residual: until something reads the file, the card still says "Protected · 3 scenes" (`shots/en-37-library-corrupt-before-click.png`). See new finding X8. |
| B2 / K2 | mpv `s` / `S` / `Ctrl+s` save sharp frames; `` ` `` opens a console, in kid mode too | **fixed** | mpv now starts with `--input-default-bindings=no --load-scripts=no --load-osd-console=no` and an impossible `--screenshot-directory`. In parent and in kid mode, IPC `keypress` of `s`, `S`, `ctrl+s`, `alt+s` and `` ` `` did nothing. `find /` found no new image files, and `user-data/mpv/console` does not exist. In kid mode `q`, `ESC` and `CLOSE_WIN` are ignored. A seek into a range was pushed out (19 → 22.5). The IPC command `screenshot-to-file` still writes a frame, but a child cannot reach the socket (0700 directory). |
| B3 / N1 | "Saved / Undo" toast covers Approve/Reject after every decision | **fixed** for the panel | Measured after Skip and after Let it play: **0 overlaps** with panel buttons at 1024x640 and at 1366x768 (toast x 24–408, panel x ≥ 640). A real Playwright click on "Let it play" right after "Skip" went through at once (`shots/en-12…en-16`). The toast now covers the scene list, the timeline and other screens' buttons instead (new finding X6). |
| B4 / K3 | A child's panic press is silently auto-approved; no audit trail | **fixed** | A kid-mode panic (IPC `p` … `p`) gives a library banner, a red card state "A moment was hidden during playback in kid mode — take a look", and the Activity entry "A child hid a moment in 'The Lighthouse Keeper' at 0:21" (`shots/en-33-library-after-kid.png`, `shots/en-34-activity.png`). The range stays enforced, as D25 decided. Wrong PINs, locks, unlocks, settings changes and plays are all logged (`shots/es-20-activity.png`). Residual: see X7. |
| B5 / K4 | Zero detections make the movie Protected for kids | **fixed** | "Sunny Garden [clean]" and the real-scan clip both show "Nothing found — check it … Kids can watch it once you approve it", and they are absent from the kid grid (`shots/en-09-library-done.png`, `shots/en-30-kid-home.png`, `shots/real-02-library-done.png`). |
| M1 / P1 | Parents card says "None found ✓" after the parent lets a scene play | **fixed** | After Let it play on Kissing and Gore: "Kissing 1 found · you let it play", "Gore 1 found · you let it play" (`shots/en-19-card-after-decisions.png`). The header chips still count all three. |
| P2 | "None found ✓" for things never checked | **partly** | The check mark is gone. "Not checked" appears when a level is Off or no stage ran (`shots/real-05-card-off.png`: Kissing and Language Off → "Not checked"). Still missing: the "checked lightly" state. Implied counts as checked as soon as the captions stage says `done`, even when the 300-shot budget covered a fraction of a two-hour film, which is the case round 1 named. The new footer claims "checked by you" on unreviewed titles (X2). |
| P3 / M5a | Levels are certainty thresholds, no category definitions, intensity not a filter | **partly** | Each category now has a one-line definition ("Kissing: Long or passionate kisses on the mouth. A quick peck is usually not flagged.") in setup and Settings (`shots/en-05-preset-custom.png`). The level texts now say "mild or strong". Intensity is still not a filter dimension, so "skip strong gore, keep mild" is impossible. |
| P4 / M5b | No pre-play summary, no per-movie choice, pill wording | **partly** | A summary sheet appears before parent-mode Play, and it **matches what mpv does** (see section 3). The pill reads "1 scene will be skipped". There is still no "Change for this movie" control. Kid tiles show no summary (acceptable). |
| P5 | Approve / Reject invert intuition | **fixed** | "Skip this scene" / "Let it play"; "Omitir esta escena" / "Dejar que se vea"; list states "Will be skipped" / "Will play" (`shots/en-11-panel.png`, `e2e/es-light-review-below.png`). |
| M2 / P6 | Unreviewed scenes are said to be "skipped anyway"; panel says Skip for a scene that plays | **fixed** | The panel and the list say "Por debajo de tu nivel de Besos: se verá a menos que la omitas" (`shots/es-12-panel-below.png`, `e2e/es-light-review-below.png`). The pre-play sheet says "1 se verá (debajo de tu nivel)" plus a warning (`shots/es-09-preplay-unreviewed.png`). The bulk confirm warns that it overrides the level (`shots/es-14-bulk-confirm.png`). |
| M3 / P7 | Check accuracy compares the list with itself; "(F1)" jargon | **fixed** (residual) | The exported sidecar of the same movie is refused: "That file is this movie's own list … the comparison would always look perfect" (`shots/en-29-accuracy-ownlist.png`). The result says "We compare the automatic scan from Oct 13, 2026, before your review, with hand-marked.bonis.json" (`e2e/en-light-accuracy.png`). "(F1)" is now "Overall" with a plain explanation. Residual: X13. |
| P8 | No human-curated vs automatic note; no age guidance stance | **fixed** | Card footer and Help › limits: "Services such as ClearPlay or Common Sense Media have people watch every movie … gives no age rating, because only you know your child." |
| P9 | Scan notes frozen in the scan's language | **not fixed** | English UI, Spanish note "Se detectó desnudez en la imagen." (`e2e/en-dark-review-panel.png`). No note key exists anywhere (`grep noteKey` finds nothing). |
| P10a | Spanish *revisar* used for both scan and parent review | **fixed** | "Todas las películas están analizadas", "Aún sin analizar", "Fila de análisis", "Comprobar la precisión" (`shots/es-06-scanning.png`, `shots/es-07-library-done.png`). |
| P10b | "Revisa la revisión primero." | **fixed** | "Abre la revisión y deja que se vea alguna escena." |
| P10c | Gendered "tú mismo" | **fixed** | "la revisaste por tu cuenta" |
| P10d | Sí / No next to switches | **fixed** | "Activado" / "Desactivado" |
| P10e | "The safest choice" | **fixed** | "The strictest choice" / "La opción más estricta" |
| P10f | Lua "Playing WITHOUT protection." (shouting) | **not fixed** | The string is still in `player/bonis.lua:61` and `:84` (ES "SIN protección"). It is now only reachable after an explicit confirmation. |
| P10g | "What shall we watch?" | **fixed** | "What do you want to watch?" |
| P10h | "3 movies added. We are checking it now." | **fixed** | "We are scanning them now, one at a time." |
| P10i | Date format | **fixed** | "Oct 13, 2026" in Accuracy. Activity uses "Oct 13, 2026 01:39 AM" / "13 oct 2026 01:45 a.m." |
| K5 | Parent mode never relocks | **partly** | **Verified in real time:** Settings › PIN › 5 minutes; unlocked at 01:40:58; the "Locking for kids in 30 seconds" toast appeared by 01:45:32 (`shots/en-44-real-idle-warning.png`); locked at 01:46:00 (`shots/en-45-real-idle-locked.png`). The stubbed path (`BO.idle._setLast`) also works (`shots/en-41`, `en-42`). Not done: lock when the window loses focus, and lock when a parent-mode movie ends. The timer is paused while Now playing is shown (`idle.js active()`), so a child gets the full idle window, unlocked, after the movie ends. The timer lives only in the renderer. |
| K6 | Peek sharper than design/help promise | **fixed** (by copy) | Help now says "you see the real frame from the movie, only a little blurred". Peek needs a PIN typed for peeking. Behaviour unchanged (live 640 px). D25 accepted this route. |
| K7 | Kid-facing crash and refusal copy | **fixed** | After two mpv kills in kid mode: "La película se detuvo. Pídele ayuda a un adulto." (`shots/es-18-kid-after-kill2.png`). After the first kill it relaunched (`shots/es-17`). A damaged tile leaves the kid grid (`e2e/es-light-kid-refused.png`). |
| K8 | Weak PINs accepted | **fixed** | 1234 and 0000 are refused: "Kids guess this one first. Choose another PIN." (`shots/en-02-pin-1234.png`, `shots/es-02-pin-weak.png`). |
| Ext-1 | Extension: no PIN; "Forget everything" one click from a child | **not fixed** | No commit touches `extension/` since round 1. The confirm button exists but does not name the consequence. |
| Ext-2 | Extension popup does not warn when no panic shortcut is assigned | **not fixed** | Same: `extension/` unchanged. |
| Ext-3 | Extension level picker has no per-level explanations | **not fixed** | Same. |
| N2.1 | Setup step 4: Continue below the fold at 1024x640 | **not fixed** | Continue top at y 584, viewport 613 (`shots/en-04-preset.png`: half a button). The PIN step also scrolls (`shots/en-02`). |
| N2.2 | Recovery code: no Print or Copy | **partly** | "Copy the code" added (with a download icon, oddly). No Print. |
| N2.3 | Wizard never mentions scan time or that kids wait for review | **fixed** | "Scanning a two-hour movie takes about half an hour to an hour. Kids can watch it once you have looked over what we found." (`shots/en-07-addmovie.png`). |
| N2.4 | Icon-only sidebar at 1024; "Lock for kids" unlabeled | **fixed** | Labels under every icon at 1024 (`shots/en-09-library-done.png`). |
| N2.5 | "We could not open that file" does not say which file | **not fixed** | `shots/es-21-add-bad-file.png`: "No pudimos abrir ese archivo" with no name. |
| N2.6 | Review list is a ~120 px strip at 1024x640 | **not fixed** | `shots/en-10-review.png`: 1.5 rows visible. |
| N2.7 | Send to TV: buttons below fold, wrong order, unreviewed clean copy unguarded | **fixed** | Clean copy first, all three buttons above the fold (`shots/en-25-export.png`). An unreviewed title asks "¿Hacer la copia antes de revisar?" (`shots/es-23-clean-unreviewed-modal.png`). |
| N3 | Keyboard: focus lost on Enter; no shortcuts; no `?` sheet | **fixed** (minus `?`) | Enter on a row puts focus on "Skip this scene"; S/L/N/P work and focus follows to the next scene. An inline key legend is in the panel. `?` does nothing (`shots/en-24-question-key.png`). |
| N4 | Panic key invisible in the player | **fixed** | `bonis.lua:969` shows "Press P to hide the picture at once" for 4 s at every file start. I checked this in the code; with `--vo=null` the OSD cannot be seen. The Now playing header shows the key (`shots/en-21-nowplaying.png`, `shots/es-16-kid-nowplaying.png`). |
| N5 / M4 | Fire TV steps not followable | **partly** | Rewritten and mostly right for Fire OS 7/8: Device & Software › About, 7 presses on the device name, Downloader first and then the per-app "Install unknown apps", ARMV7A (32BIT), the "do not format, choose View" warning, and VLC › Browsing. Gaps in the Kodi path: step 13 "Kodi › Videos › Files, choose the stick" skips **Add videos… › Browse › (the USB drive) › OK**, because Kodi on Android does not list a USB stick there by itself. It also skips Kodi's first-run storage-permission prompt. No pictures. |
| N6 | First-launch guidance unreachable before launch; wrong for Sequoia | **partly** | Content is fixed: Sequoia steps (Not Opened › Done › Privacy & Security › Open Anyway › password) in both languages. `docs/INSTALL/en-US.md` and `es-MX.md` exist, and their numbered steps are **identical** to Help › Before you install (diffed, 12 steps each). **They do not ship.** `electron-builder.yml` has no `extraFiles` and no DMG contents entry for them. The CI uploads only `*.exe`, `*.dmg` and checksums. `packaging/README.md:213` says "Not wired into electron-builder.yml". The INSTALL text itself says it is "next to the installer as FIRST-LAUNCH.txt", which is false today, and LEDGER D25 records "INSTALL docs ship next to the installer" as done. |
| N7 | Help scroll-spy highlights the wrong section | **fixed** | At the top of Help no item is active (`e2e/en-light-help.png`). The beige item is the mouse hover. |
| Err-1 | "A file could not be read … Check your settings and the library." | **not fixed** | `toast.lostFile.text` unchanged in both languages. |
| Err-2 | Kid-mode crash toast tells a child to restart the computer | **fixed** | See K7. |

## 2. Specific checks the board asked for

1. **The pre-play summary matches what the player actually skips: PASS.**
   - en, after review: the sheet said "1 scene will be skipped · 2 you let play" (`shots/en-20-preplay.png`). Seeks
     in mpv: 18.5 → 22.9 (Nudity skipped), 41.5 → 42.9 (Kissing played), 63.5 → 64.8 (Gore played).
   - es, Teens, unreviewed: the sheet said "Se omitirán 2 escenas · 1 se verá (debajo de tu nivel)". mpv: 18.5 → 22.7
     (skipped), 41 → 42.2 (Kissing played, below level), 63.5 → 67.7 (Gore skipped).
   - The kid Now playing count ("2/3 scenes will be skipped") matched the enforced set after marks.
2. **The parents card states per category one of not checked / none found / N skipped / N you let play:
   PASS on states, FAIL on presentation.** All four states render ("Not checked", "None found", "1 found · skipped",
   "1 found · you let it play", plus "plays (below your level)"). However, the footer claims "then checked by you" on
   unreviewed titles (X2), and the category names break mid-word (X1).
3. **Check accuracy refuses the movie's own list and says what it compares: PASS.** See M3 / P7.
4. **Toasts never overlap panel buttons at 1024x640 and 1366x768: PASS** (0 hits in both sizes, after Skip and
   after Let it play, one and two stacked toasts). Toasts still cover other primary content (X6).
5. **Relock after inactivity: PASS for the idle path, verified in real time** (5 min setting: warning at about
   4 min 34 s, locked at 5 min 02 s). Not done: lock on focus loss and lock after a parent-mode movie (K5 partly).
6. **Fire TV steps are followable: PARTLY.** The USB + VLC path can be followed. The Kodi path stops at its last
   step (N5).
7. **INSTALL docs exist in both languages and match the help: PASS as text, FAIL as delivery.** They are not shipped
   next to the installer (N6).

## 3. New findings (concrete only; numbered X1 to X14 so they do not collide with round-1 N numbers)

| # | Screen | What | Why it matters | Severity | Fix |
|---|---|---|---|---|---|
| X1 | Review › "What parents need to know" | Category names break mid-word: **"Des / nud / ez"** and **"Bes / os"** at 1024x640 in Spanish, and **"Kissi / ng"** in English at 1024x640 and 1366x768. | This is the flagship Common Sense Media-style card. In Spanish every card with a finding looks broken at the minimum window. A product lead would screenshot it. Evidence: `shots/es-crop-parentscard.png` (from `e2e/es-light-review-overview.png`), `shots/en-19-card-after-decisions.png`, `shots/en-35-review-kidpanic.png`. | major | Give the name column `min-width: max-content` (or `word-break: keep-all; hyphens: none`). Let the status wrap under the name on narrow cards instead of squeezing the name. Add a no-mid-word-break assertion to the e2e. |
| X2 | Parents card footer | "Found automatically, then **checked by you**." / "…y luego **las revisaste tú**." It also shows on titles with "3 to review" and on "Nothing found — check it" titles (`shots/en-10-review.png`, `shots/real-03-review.png`). | It is a false claim on the card meant to inform a second parent. It is the same class of honesty bug as round-1 P1/P2. | major (product blocker) | Choose the footer by state: "Found automatically; not checked by a parent yet" until every scene is decided or the clean title is approved. |
| X3 | Help, INSTALL, download | **No system requirements anywhere.** `electron-builder.yml` sets `minimumSystemVersion: "12.0"`, but the arm64 mpv needs macOS 14 (LEDGER). The speech and dialogue stages are skipped on pre-AVX2 CPUs. | A parent with an M1 Mac on macOS 13 installs, sets up, scans for an hour, and then cannot play. A low-tolerance parent gives up for good. | major | Add "Works on: macOS 14+ (Apple Silicon) / 12+ (Intel), Windows 10/11 64-bit, 8 GB RAM recommended" to INSTALL and Help, and make the app refuse to start the player with a plain message on unsupported macOS. |
| X4 | Now playing › Keys; Help › panic | "**Back or forward 10 seconds**" / "Atrás o adelante 10 segundos", but the player's arrows seek **5 s** (Up/Down 60 s). Measured over IPC: 30.0 → RIGHT → 35.0 → LEFT → 30.0. | The keys card is the documentation parents rely on. | minor | Change `keys.seek` to 5 s (and mention Up/Down 1 minute), or bind 10 s. |
| X5 | Kid screen | Parent-only error toasts survive the switch to kid mode. After the idle lock, the kid screen showed "The scene list of 'The Lighthouse Keeper' is damaged … the movie is not protected" over "Nothing to watch yet" (`shots/en-42-after-idle-lock.png`). | It is jargon for a child and covers the kids' empty state. | minor | Clear the toast region (or keep only kid-mode toasts) on `locked` changes. |
| X6 | Library, Check accuracy, kid Now playing, modals | The bottom-left toast stack visually covers primary content: the Play button of the first library card (`shots/es-24-toast-over-library.png`), the scene list and timeline in review (`shots/en-13`, `en-14`), the movie picker and "Choose a hand-marked file" (`shots/en-29`), the kid **Stop** button (`shots/es-17-kid-after-kill1.png`, text overprinted), and it draws **above an open modal** (`shots/en-38-play-corrupt.png`). Clicks pass through (`pointer-events: none`; checked with `elementFromPoint`), but the parent cannot see what they are clicking. Toasts also persist across navigation ("Skip file saved" followed me from Send to TV into Check accuracy). | Visual clutter on the kid screen, and a toast over a destructive-choice modal. | minor | Put toasts under the modal layer, dismiss them on route change, and use a top-right or inline position on screens with bottom-left primary actions. |
| X7 | Library → review | Opening the review of a title flagged "A moment was hidden" clears the flag at once, even if the parent never selects that scene. In the list the child's panic range looks like any other "Other · Will be skipped" row; only the panel note says "Hidden with the panic key in kid mode". | A parent who clicks "Take a look", gets interrupted and presses Back loses the alert. Only the Activity log keeps it. | minor (commission) | Clear the flag when that range is selected or decided. Give it a "Your child hid this" badge in the list and on the timeline. |
| X8 | Library | A title whose list was damaged on disk shows "Protected · 3 scenes" until something reads the file (Play, lock). | Play asks and kid mode refuses, so it stays safe, but the status is wrong. | minor | Verify list integrity (it is already HMAC'd in the index) when the library is listed. |
| X9 | Activity | Raw values: "Settings changed: Language: en-US", "Empezar con: teens", "Setup finished: On" / "Configuración terminada: Activado". Player crashes are not logged. | Jargon in the one screen meant to reassure a parent. | minor | Render locale and preset names through i18n. Log "the movie stopped unexpectedly (kid mode)". |
| X10 | Parents card | Hand and panic marks get an invented intensity: "Other 2 found · skipped · ●○○ Mild" (`shots/en-35-review-kidpanic.png`). | The card claims a severity nobody measured. | minor | Show no intensity for manual and panic ranges. |
| X11 | Review list | A 0.3 s hand mark is listed as "1:13 – 1:14 · **0 s**" (`shots/en-23-review-mark.png`). | It looks like a bug. | minor | Round up to "1 s", or show "under 1 s". |
| X12 | Damaged-list modal | Title "This movie has no scene list. Play it without protection?" over the body "The scene list … is damaged" (`shots/en-38-play-corrupt.png`). | Contradictory. | minor | Title: "This movie's scene list is damaged. Play it without protection?" |
| X13 | Check accuracy | "Own list" is detected only by the document id. There is no in-app way to make an independent hand-marked list, because I/O marks go into the movie's list. A lone parent cannot use the feature at all. | Honesty is now safe, but the feature is a dead end for most families. | minor | Add a "Mark scenes for a comparison" session whose marks are saved to a separate file. Also refuse files whose range ids or history match the current list. |
| X14 | INSTALL / Help (es-MX), Windows | "Windows protegió **tu** PC". The real Windows es-MX dialog says "Windows protegió **su** PC". | A parent matching text on screen looks for the exact words. | minor | Quote the dialog's own wording. |

Things I tried that held up: no page errors in any run. Kid mode refuses seeks into ranges, quit, Escape and
window close. Lock works while a parent-mode movie plays (e2e). Every activity type is recorded. The wrong-PIN
cooldown works (`e2e/es-light-kid-pin-cooldown.png`). Dark themes are readable. There is no horizontal scroll at
1024x640 (e2e asserts it).

## 4. Verdicts

**Product lead (family-filtering service benchmark): FAIL.**
Both round-1 blockers are fixed: B5, the zero-finding auto-protect, and P1, the parents card hiding allowed
content. The new blocker is **X2**: the parents card tells a reader "checked by you" on titles no parent has looked
at, the same honesty failure this board blocked in round 1. Majors still open:
- **X1**: the card's category names break mid-word, worst in Spanish at the minimum window.
- **P3**: no severity filter.
- **P4**: no per-movie filter choice.
- **P2**: no "checked lightly" state for captions under budget.
- **P9**: notes stay in the scan's language.

The pre-play sheet now tells the truth (verified against mpv). Check accuracy is honest. The Spanish vocabulary is
clean.

**Kids-protection commission: PASS (conditional).**
All four round-1 blockers are verified fixed in the running app:
- K1: parent mode fails closed on a damaged list.
- K2: mpv screenshot and console keys are inert in both modes, and no file is written.
- K3: a child's panic stays enforced, is flagged and is logged.
- K4: zero findings need a parent click.

Idle relock was verified in real time. The conditions before the next release:
- **K5** (partly): lock on window focus loss in "Open in kid mode" setups, and lock after a parent-mode movie ends.
- **X7**: do not clear the panic flag until that scene is opened.
- **X5**: no parent toasts on the kid screen.
- **Ext-1 to Ext-3**: the extension has had no change since round 1. It still has no PIN, an unguarded
  "Forget everything" and no warning when the panic shortcut is missing. The commission would fail the extension
  on its own.

**Non-technical parent: FAIL.**
Round-1 N1, the toast blocking review, is fixed, and review is now fast and keyboard-friendly. The blocker is round-1 **N6**: the
first-launch steps are now correct for Sequoia and exist as INSTALL files in both languages, but they are **not
shipped** with the DMG or the installer, so a parent still meets "Not Opened" with nowhere to read the way past
it. The INSTALL file itself and LEDGER D25 claim otherwise. Majors still open:
- **X3**: no system requirements, so an M1 Mac on macOS 13 installs and then cannot play.
- **N5 / M4** (round 1): the Kodi path stops at "Videos › Files" without the Add videos › Browse step.
- **X1**: broken Spanish parents card.

Minor items still open: N2.1 (Continue below the fold in setup), N2.5 (the error does not name the file), N2.6
(cramped review list), X4 (keys card says 10 s, the player seeks 5 s), and Err-1 (the vague "Check your settings
and the library").
