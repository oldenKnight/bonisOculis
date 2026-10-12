# bonis oculis for Chrome and Brave (beta)

A small companion to the bonis oculis desktop app for videos you watch in the browser. It reads the
subtitles the video already has, finds the scenes you chose to avoid, and skips them. When a site
does not let it skip, it covers the picture and mutes the sound until the scene is over. It never
looks at the picture and nothing leaves your computer.

Beta scope (brief 3.9, milestones M6 and M8): subtitle pre-read, your own .srt/.vtt file, automatic
timing match, importing a skip file from the desktop app, panic key, DRM sites handled by skipping
only, and an experimental **live listening** mode that hears the tab's sound and covers a scene
shortly after it starts (see [Live listening](#live-listening-experimental)).

## Install it (about 3 minutes, done once by a parent)

1. **Get the folder.** Copy the `extension` folder of bonis oculis to your computer, for example to
   `Documents/bonis-oculis-extension`. Keep it there: Chrome loads it from that folder every time.
2. **Open the extensions page.** In Chrome, type `chrome://extensions` in the address bar and press
   Enter (in Brave: `brave://extensions`). *Screenshot: a page titled "Extensions" with a grid of
   cards and a "Developer mode" switch in the top right corner.*
3. **Turn on Developer mode.** Click the "Developer mode" switch at the top right so it turns blue.
   *Screenshot: three new buttons appear at the top left: "Load unpacked", "Pack extension",
   "Update".*
4. **Load it.** Click "Load unpacked", find the folder from step 1, select it (the folder itself, the
   one that contains `manifest.json`) and click "Select". *Screenshot: a new card "bonis oculis"
   with the teal eye icon.*
5. **Pin the button.** Click the puzzle-piece icon to the right of the address bar, then the pin
   next to "bonis oculis". *Screenshot: the teal eye now sits next to the address bar.*
6. **Choose what to skip.** Click the eye, then "Settings and privacy". Pick "Little kids" or
   "Teens", or set each category yourself. *Screenshot: the settings page with six rows of
   Off / Light / Moderate / Strict.*
7. **Check the panic key.** On the same page, "Keyboard shortcut" shows **Alt+Shift+P**. If another
   extension already uses it, press "Change the shortcut" and choose another one.
8. **Other websites (optional).** YouTube, Netflix, Prime Video and Disney+ work right away. For any
   other website with a video, press "Turn on for all websites" in the settings (Chrome asks once),
   or use "Protect this tab" in the eye's panel each time.

Chrome may show a note about developer-mode extensions when it starts. That is normal for
extensions installed from a folder; press "Keep" or close the note.

### Every day

Open the video and press play. The number on the eye button is how many scenes are planned for
this video. Click the eye to see them by category, change what is skipped for this one video, add a
subtitle file, import a skip file, or hide the video at once.

**Panic key:** press **Alt+Shift+P** to cover the video and mute it immediately. Press it again to
show it. That moment is saved and skipped the next time this video plays.

## Live listening (experimental)

Subtitles tell bonis oculis about a scene *before* it plays. Live listening is for videos without
useful subtitles: it listens to the sound of one tab while the video plays and reacts to what it
hears.

**What it can do.** When it hears sounds of a scene you chose to skip (intimate sounds such as
moaning or panting, or gunfire), it covers the picture and mutes the sound, and shows the video again
3 seconds after it gets quiet. A small "Listening" tag sits in the video's top-left corner and the
eye button shows a red dot while it is on. Each covered stretch is saved for that video (the times
only, never the sound) and is skipped from 3 seconds earlier the next time, like a panic moment; the
panel counts it under "Moments covered by live listening".

**What it cannot do.**
- **It can only react.** It needs about 1.5 to 2 seconds of a sound before it is sure (two 0.96 s
  listening windows in a row), so the first moment of a scene can get through. Subtitles and skip
  files act ahead of time and are more dependable; use them when you have them.
- **It needs the tab's sound.** A muted tab, a paused video or a site that sends silence (some
  protected sites may) gives it nothing to hear; the panel then says that no sound has reached it.
- **Sounds, not pictures.** A silent scene is missed. Explosions or screams on their own never make
  it cover (their weight is capped below the threshold, exactly as in the desktop analyzer, so action
  films and horror do not trigger it all the time). Gunfire, machine guns and wet impacts can.
- **One tab at a time.** Turning it on in another tab stops it in the first one.
- **Sound delay.** The tab's sound plays through bonis oculis while it listens, which adds a few
  hundredths of a second of delay.
- **No PIN, same as the rest of the extension.** Anyone at the computer can switch it off. In a
  supervised Chrome profile (Family Link) or a separate computer account a child cannot remove the
  extension, but the live switch is still a switch; for children, prefer subtitles and skip files,
  which need no switch.

**How to turn it on.** Open the video, click the bonis oculis eye next to the address bar and switch
on **Live listening (experimental)**. Chrome lets an extension hear a tab only after such a click, so
it has to be turned on from the eye's panel each time (it is off when the tab is closed or the
browser restarts). Switch it off the same way.

**Cost.** The sound model (YAMNet, 16 MB) runs inside the extension on the computer's processor,
one 0.96 s window every 0.48 s: measured at 17 to 29 ms of work per window on average (first windows
up to 140 ms while it warms up) on a 4-core test machine, so roughly 4 to 6 % of one processor core
while listening. Starting takes about 0.7 s. Windows of complete silence (paused video) are not
analysed. When the switch is off nothing of this is loaded.

## What works where

Honest status of each site. The site adapters for Netflix, Prime Video, YouTube and Disney+ follow
how those players behaved when this was written (October 2026). Automatic tests cannot sign in to
those services or play their protected video, so only the generic adapter has been run in a real
browser (see Tests). Sites change their players without notice; when something stops working the
safe behaviour is cover + mute, never "play unprotected", as long as subtitles were read.

| Site | Subtitles read automatically? | Jump over a scene? | When it cannot jump | Notes |
|---|---|---|---|---|
| Any website (generic) | Yes, from `<track>` subtitles and WebVTT/TTML files the page downloads | Yes (`currentTime`) | Cover + mute | Needs "Turn on for all websites" or "Protect this tab". DRM pages: cover + mute only |
| YouTube | Yes, when captions are on. The panel's "Read this video's captions" presses CC once and turns it off again | Yes | Cover + mute | Ads are ignored (ranges apply to the film only). Auto-generated captions rarely contain sound cues such as [moaning] |
| Netflix | Yes, once you turn on subtitles in the player (any language we read: English or Spanish) | Best effort through Netflix's own player; **setting the video time breaks Netflix playback, so it is never done** | Cover + mute (DRM site, this is the dependable path) | Netflix's player API is private and may break after an update |
| Prime Video | Yes, once subtitles are on | Best effort (`currentTime`, the player may ignore it) | Cover + mute (DRM) | Trailers and ads may play in another video element |
| Disney+ | Partly: subtitles arrive a few seconds at a time, so scenes are found shortly before they play, not for the whole film up front | Best effort | Cover + mute (DRM) | Each subtitle piece's `X-TIMESTAMP-MAP` is applied (counted from the earliest piece seen); if timing is still off, use the timing control |

On every site you can instead give it a subtitle file you have (.srt or .vtt, English or Spanish) or
a skip file made by the desktop app (.bonis.json). Each has its own timing control (0.5 s steps);
"Match timing automatically" compares your subtitle file with the site's own captions.

## Honest limits

- **Without live listening it only knows what the subtitles say.** Scenes with no dialogue and no
  sound cue in the subtitles are missed. Subtitles for the hearing impaired (SDH, "CC") work best because they
  describe sounds. The desktop app, which also checks the picture and the sound, catches much more.
- **It catches too much on purpose.** A line such as "they kissed" can trigger a skip. Use a lighter
  level for a category, or a lighter level just for one video, if this bothers you.
- **On Netflix, Prime Video and Disney+ it often cannot jump.** It covers the picture with a black
  panel and mutes until the scene ends. The film keeps running underneath.
- **No PIN.** Anyone at the computer can change it or remove it. For children, use a supervised
  Chrome profile (Family Link) or a separate Windows/macOS account where extensions cannot be
  changed.
- **Fullscreen:** when a site puts the bare video element in fullscreen, nothing can be drawn over
  it, so bonis oculis leaves fullscreen before covering a scene. Normal site fullscreen (the
  player's own button) is covered without leaving it.
- **Picture-only subtitles** (some languages on some sites are images, not text) cannot be read.
- **Embedded players in frames** (a video from another site inside a page) are not handled yet.

## Privacy statement

- bonis oculis makes **no network requests**. It has no account, no analytics, no remote settings,
  and no updates from anywhere but you. The extension pages forbid network access by their content
  security policy (`connect-src 'self'`).
- It **never reads the picture**: no canvas, no frame capture, on every site including DRM ones. It
  does not download, decrypt or record protected video.
- It **reads the sound only when you switch on live listening** for a tab, and only that tab. The
  sound is analysed in memory, half a second at a time, inside a hidden extension page (an "offscreen
  document"), and immediately dropped: it is never saved, recorded or sent. Only the start and end
  times of the stretches it covered are kept.
- The only thing it reads from a website is the **subtitle text that page downloads for itself**. A
  small script in the page notices those subtitle files as they arrive and passes a copy of the text
  to the extension; it does not change or delay anything the page receives. For `<track>` subtitles
  it reads the cues the browser already loaded.
- Your choices, imported files, subtitle files and saved panic moments are kept **in this browser
  profile only** (`chrome.storage.local`). "Forget everything" in the settings, or removing the
  extension, deletes them.
- Permissions and why: `storage` (your choices), `activeTab` + `scripting` ("Protect this tab" on a
  site you choose), `tabCapture` + `offscreen` (live listening: hear the one tab you switched it on
  for, in a hidden page; Chrome allows it only after your click), host access to YouTube, Netflix,
  Prime Video/Amazon and Disney+ (to read their subtitles), and optional access to all websites only
  if you turn it on. A keyboard command (the panic key) needs no permission. The pages' security
  policy allows WebAssembly (`'wasm-unsafe-eval'`, needed by the sound model's runtime) and nothing
  remote.

## How it works (for developers)

```
manifest.json            MV3; per-site content scripts: inject/hook.js in the MAIN world + the content set
background/background.js classic service worker: panic command, badge, init data, generic registration
inject/hook.js           page world: wraps fetch/XHR, posts subtitle text with a nonce (window.postMessage)
content/core.js          BO.util          content/bridge.js   BO.bridge (tracks, nonce handshake)
adapters/base.js         BO.adapters      adapters/{generic,youtube,netflix,primevideo,disneyplus}.js
content/enforcer.js      BO.enforcer (pure; 100 ms tick + timeupdate; skip/verify/cover/mute/restore)
content/overlay.js       BO.overlay (black-out in a closed shadow root; the "Listening" tag)
content/main.js          BO.content (planning, storage, messages, live covers -> saved moments)
offscreen/offscreen.*    live listening: tab sound -> AudioContext (back to the speakers through a
                         gain that goes to 0 while covered) + capture -> 16 kHz -> YAMNet -> decisions
audio/capture-worklet.js AudioWorklet: mono blocks of 2048 samples (ScriptProcessor fallback)
audio/live.js            BO.live (pure): downmix, windowed-sinc resampler, 0.96 s/0.48 s windower,
                         cover/release hysteresis
audio/classmap.js        BO.classmap: YAMNet class -> category weights, COPIED from the analyzer
vendor/                  onnxruntime-web 1.22.0, wasm build (third-party, MIT; see below)
models/yamnet.onnx       YAMNet (third-party, Apache-2.0; see below)
common/{i18n,store,ui}.js, popup/, options/, _locales/{en,es_MX,es}
shared/skipfile.js, shared/subscan.js, lexicon/*.json, css/tokens.css, fonts/, icons/logo-mark.svg
                         COPIES of shared/, spec/lexicon/, desktop/renderer (see below)
```

- **Copies, not a build.** Chrome only loads files inside this folder, so a few shared files are
  verbatim copies: `shared/skipfile.js`, `shared/subscan.js` (from `/shared`), `lexicon/*.json`
  (from `/spec/lexicon`), `css/tokens.css` (from `desktop/renderer/css/tokens.css`), the two OFL
  fonts and `icons/logo-mark.svg`. Edit the originals, then run `node extension/tools/sync-shared.js`.
  The unit tests fail when a copy drifts.
- **Locales.** `_locales/es_MX` is the Spanish (Mexico) text used by the language toggle.
  `_locales/es` is an identical copy because Chrome picks `es` or `es-419` for Spanish browsers and
  never `es_MX` (a test keeps them identical).
- **Scoring** follows `spec/lexicon/README.md`, shared with the Python analyzer, and gives the same
  per-second scores. Ranges use the levels table in `spec/SKIPFILE.md` (strict 0.40, moderate 0.60,
  light 0.80), merge gaps under 3 s, add 2 s before and 1 s after, minimum 1.5 s; strong language is
  muted with tighter padding (0.5 s), like the analyzer.
- **Live listening.** The popup's switch (the user's click) asks the service worker, which calls
  `chrome.tabCapture.getMediaStreamId({targetTabId})`, opens `offscreen/offscreen.html` (reason
  `USER_MEDIA`) and hands it the stream id. The offscreen document runs `getUserMedia` on it, plays the
  sound back through an `AudioContext` (a captured tab is otherwise silent), downmixes to mono,
  resamples to 16 kHz and runs YAMNet (onnxruntime-web, wasm, one thread) on the last 0.96 s every
  0.48 s; a window that arrives while the previous one is still running is dropped, never queued. The
  521 class scores become `sex`, `implied` and `gore` (= the brief's "violence") with the analyzer's own
  table and rule (max of weight × score; `audio/classmap.js`, checked against
  `analyzer/bonis_analyzer/config.py` by a unit test). It covers when `sex >= 0.5` or `gore >= 0.6` on
  two windows in a row and releases at the first window 3 s after the last window at or above half the
  threshold. Decisions go to the content script as `{t: "live", cover, category, score}` through the
  service worker. The content script covers through the enforcer; it does **not** mute the video
  element (a muted element makes the captured sound silent, so the listener would go deaf and release
  too early): the offscreen document mutes its own route to the speakers instead. A category set to
  Off is ignored. Everything stops when the switch is turned off, the tab is closed, or starting fails
  (the panel then shows the reason).
- **Enforcement.** A skip range covers and mutes at once, asks the adapter to jump to its end and
  checks within 500 ms. If the time did not leave the range (or the site sent it back), it keeps the
  cover and mute until the range ends, then restores exactly at the end (a timer fires at the end
  time). Hide and blur are treated as cover + mute; no visual filter is ever applied to the video.

## Third-party files (vendored)

Committed so the extension never downloads anything; `node tools/fetch-vendor.js` re-downloads them
and checks each sha256 (`--check` verifies without network, `--from DIR` copies matching files from a
folder such as the analyzer's models). A unit test fails if a file differs from its pinned hash.

| File | Size | Source | Licence |
|---|---|---|---|
| `vendor/ort.wasm.min.js` | 48 327 B | onnxruntime-web 1.22.0 `dist/` (jsDelivr) | MIT |
| `vendor/ort-wasm-simd-threaded.mjs` | 20 856 B | same (loaded by the file above) | MIT |
| `vendor/ort-wasm-simd-threaded.wasm` | 11 210 254 B | same; used with one thread | MIT |
| `vendor/LICENSE-onnxruntime-web.txt` | 1 073 B | microsoft/onnxruntime v1.22.0 | MIT |
| `models/yamnet.onnx` | 16 093 603 B | YAMNet ONNX, same file as `analyzer/models/manifest.json` | Apache-2.0 |
| `models/LICENSE-yamnet-Apache-2.0.txt` | 11 358 B | apache.org | Apache-2.0 |

They add about 27 MB to the extension folder (it was under 1 MB). Vendored files are exempt from the
ES5 rule (`tools/lint-es5.js` skips any `vendor/` folder).

## Tests

```
node --test extension/test/unit       manifest, ES5 syntax, copies, locales, no network code,
                                      adapters' URL handling, enforcement engine (fake clock, fuzz),
                                      live listening: class table vs the analyzer, hysteresis on fed
                                      score streams, resampler on sines/noise/silence, windower,
                                      vendored file hashes
node --test shared/test               includes shared/test/subscan.test.js (parsers, scoring, ranges, sync)
node extension/test/run.js            all of the above + the real-browser test
node extension/test/run.js --unit     unit tests only
```

The real-browser test needs Playwright, Chromium and ffmpeg, none of which go into this repository:

```
mkdir -p /tmp/bo-pw && (cd /tmp/bo-pw && npm init -y >/dev/null && npm i playwright-core)
BO_PLAYWRIGHT=/tmp/bo-pw/node_modules node extension/test/run.js
```

Optional: `BO_CHROMIUM=/path/to/chrome` (default `/opt/pw-browsers/chromium`, else Playwright's
download), `BO_FFMPEG`, `BO_SCRATCH` (work folder, default in the system temp folder), `HEADED=1`
to watch it. It generates a 60 s colour-bar clip with `ffmpeg testsrc2` (H.264 MP4, plus a VP8 WebM
because Playwright's Chromium has no H.264 decoder), serves `test/site/` from 127.0.0.1, loads a copy
of the extension that has the all-websites permission already granted, and checks: planned scenes
and badge, a jump over a skip range, mute and restore, cover + mute when the page refuses the jump,
the panic command through the service worker (and the saved moment), a parent's .srt giving the same
ranges as the page's track, automatic timing match of a file shifted by 2.5 s, skip-file import and
refusal of a broken one, the Spanish toggle, and that no request left 127.0.0.1. It takes about
45 seconds plus browser start-up (20 s before live listening).

Live listening in the browser test (about 25 s more): the popup switch shows Chrome's refusal when
the extension was not invoked by a click (and leaves nothing running); the offscreen document loads
the runtime and the model and classifies two clips made with ffmpeg through the real audio path
(media element, AudioWorklet, resampler, windows): 2 s silence + 3 s of short white-noise impulses
every 80 ms + 2 s silence (YAMNet hears "Machine gun", so it covers and mutes the test video, then
releases), and a 5 s sine ("Telephone"; never covers); a fed score stream covers and releases at
exactly the expected windows; switching off closes everything. These use a test-only path: the test
copy of the manifest is marked `BO_TEST` in `version_name`, which lets the offscreen document play a
file from `127.0.0.1` instead of capturing the tab. The inference time per window is printed.

Then a second, headed browser (under `xvfb-run` when there is no display; about 11 s) checks the
real tab capture: the service worker's own start path captures the test page's sound, the impulses
cover the video **without muting the element**, the cover lifts 3 s after the last loud window, and
closing the tab closes the offscreen document. Chrome gives a tab stream only after a user click;
`--allowlisted-extension-id` stands in for it. Captured sound is silent in headless mode and with
`--mute-audio`, so this part plays about 8 s of test sound if the machine has speakers. Skip it with
`BO_NO_TAB_CAPTURE=1`; it is skipped automatically when there is neither a display nor `xvfb-run`.

The test subtitles are neutral dialogue plus the cues `[moaning]`, `[kissing]` and a mild
"Oh, crap. Damn it." The sound clips are noise impulses, a sine and silence. Nothing explicit is
used anywhere in the tests (brief 8.1).
