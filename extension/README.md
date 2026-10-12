# bonis oculis for Chrome and Brave (beta)

A small companion to the bonis oculis desktop app for videos you watch in the browser. It reads the
subtitles the video already has, finds the scenes you chose to avoid, and skips them. When a site
does not let it skip, it covers the picture and mutes the sound until the scene is over. It never
looks at the picture and nothing leaves your computer.

Beta scope (brief 3.9, milestone M6): subtitle pre-read, your own .srt/.vtt file, automatic timing
match, importing a skip file from the desktop app, panic key, DRM sites handled by skipping only.
Live sound detection is not part of this version (planned as M8).

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
| Disney+ | Partly: subtitles arrive a few seconds at a time, so scenes are found shortly before they play, not for the whole film up front | Best effort | Cover + mute (DRM) | Timing may need the timing control |

On every site you can instead give it a subtitle file you have (.srt or .vtt, English or Spanish) or
a skip file made by the desktop app (.bonis.json). Each has its own timing control (0.5 s steps);
"Match timing automatically" compares your subtitle file with the site's own captions.

## Honest limits

- **It only knows what the subtitles say.** Scenes with no dialogue and no sound cue in the
  subtitles are missed. Subtitles for the hearing impaired (SDH, "CC") work best because they
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
- It **never reads the picture or the sound**: no canvas, no frame capture, no audio capture. It does
  not download, decrypt or record protected video.
- The only thing it reads from a website is the **subtitle text that page downloads for itself**. A
  small script in the page notices those subtitle files as they arrive and passes a copy of the text
  to the extension; it does not change or delay anything the page receives. For `<track>` subtitles
  it reads the cues the browser already loaded.
- Your choices, imported files, subtitle files and saved panic moments are kept **in this browser
  profile only** (`chrome.storage.local`). "Forget everything" in the settings, or removing the
  extension, deletes them.
- Permissions and why: `storage` (your choices), `activeTab` + `scripting` ("Protect this tab" on a
  site you choose), host access to YouTube, Netflix, Prime Video/Amazon and Disney+ (to read their
  subtitles), and optional access to all websites only if you turn it on. A keyboard command (the
  panic key) needs no permission.

## How it works (for developers)

```
manifest.json            MV3; per-site content scripts: inject/hook.js in the MAIN world + the content set
background/background.js classic service worker: panic command, badge, init data, generic registration
inject/hook.js           page world: wraps fetch/XHR, posts subtitle text with a nonce (window.postMessage)
content/core.js          BO.util          content/bridge.js   BO.bridge (tracks, nonce handshake)
adapters/base.js         BO.adapters      adapters/{generic,youtube,netflix,primevideo,disneyplus}.js
content/enforcer.js      BO.enforcer (pure; 100 ms tick + timeupdate; skip/verify/cover/mute/restore)
content/overlay.js       BO.overlay (black-out in a closed shadow root)
content/main.js          BO.content (planning, storage, messages)
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
- **Enforcement.** A skip range covers and mutes at once, asks the adapter to jump to its end and
  checks within 500 ms. If the time did not leave the range (or the site sent it back), it keeps the
  cover and mute until the range ends, then restores exactly at the end (a timer fires at the end
  time). Hide and blur are treated as cover + mute; no visual filter is ever applied to the video.

## Tests

```
node --test extension/test/unit       manifest, ES5 syntax, copies, locales, no network code,
                                      adapters' URL handling, enforcement engine (fake clock, fuzz)
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
20 seconds plus browser start-up.

The test subtitles are neutral dialogue plus the cues `[moaning]`, `[kissing]` and a mild
"Oh, crap. Damn it." Nothing explicit is used anywhere in the tests (brief 8.1).
