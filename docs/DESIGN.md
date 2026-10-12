# bonis oculis: visual design system (v1)

Author: Sonnet (visual design). Binding for implementers; changes go through the planner and are logged in LEDGER.md.
Source of truth for values: `desktop/renderer/css/tokens.css`. Everything on this page that has a number also exists as a token.
Live reference of every component in every state, both themes, Spanish and English, kid mode: open `desktop/renderer/design-preview.html` in Chromium.

Files

| File | What it holds |
|---|---|
| `desktop/renderer/css/tokens.css` | Custom properties only: colour (light, dark, kid), type scale, space, radii, shadows, motion, layout. No selectors for components. |
| `desktop/renderer/css/base.css` | `@font-face`, reset, document defaults, headings, focus ring, reduced motion, forced-colors. |
| `desktop/renderer/css/components.css` | All `bo-` components and the three screen layouts. |
| `desktop/renderer/assets/logo.svg`, `logo-mark.svg`, `icons/*.svg` | Logo and 45 icons. |
| `desktop/renderer/design-preview.html` | Static specimen page. The only JavaScript is a 5-line kid-mode toggle. |

Load order in `index.html`: `tokens.css`, `base.css`, `components.css`. Never reorder, never copy a hex value into a component.

## 1. Brand idea

"bonis oculis" is Latin for "with good eyes": the app looks at the film first, with care and without judgement, so that the family can simply press play. The design therefore feels like a calm, well-lit living room (warm paper neutrals, one deep teal, generous space, a literate serif for titles) and never like a security product (no red alert chrome, no shields with exclamation marks, no childish mascots).

Three rules follow from the idea.
1. Quiet confidence: one accent colour, large readable type, nothing blinks or bounces. Status is stated in words, with an icon, then colour.
2. The scene is never shown: every image that could contain a flagged scene is blurred, tinted and labelled with a category glyph, never with a description (section 12).
3. Spanish is not an afterthought: every component is built to survive text 30% longer than English (section 13).

## 2. How themes and modes are selected

| Mechanism | Effect |
|---|---|
| Nothing set | Follows the OS through `prefers-color-scheme`. |
| `<html data-theme="light">` or `"dark"` | Forces a theme. The app has no theme switch in v1; the attribute exists for tests and for the preview page. |
| Any element with `data-theme` | Re-scopes all colour tokens for its subtree (the preview shows both themes side by side with this). |
| `data-mode="kid"` on `<html>` | Kid mode. Larger type, 64px targets, thicker borders and focus ring, higher-contrast colours. The same attribute on an element that also has `data-theme` gives that element the matching kid colours. |
| `data-motion="reduce"` on `<html>` | Reduced motion regardless of the OS (Settings > Playback > Reduce motion). The OS setting is honoured without any attribute. |

Switching is done in ES5 with `document.documentElement.setAttribute(name, value)`; nothing else is needed, there is no class toggling and no re-render.

## 3. Colour

Warm paper neutrals (never pure white as page background, never pure black), one brand colour (deep teal, hue 187), and a set of semantic colours that are always paired with an icon and words. Light theme is the default look; dark is a warm charcoal, never blue-black.

All text pairs meet WCAG 2.2 AA (4.5:1). Body copy (`--bo-text`, `--bo-text-2`) and links meet AAA (7:1) in every theme and in kid mode. Control outlines and the focus ring meet 3:1. `--bo-text-3` is allowed only for captions, timecodes and hints (AA, never body copy). Disabled controls are exempt from contrast by WCAG but still readable (about 3:1).

Ratios below are computed by script from the exact hex values in `tokens.css` (WCAG relative-luminance formula), so they are a test, not an estimate.

### 3.1 Core tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bo-bg` | `#FAF8F4` | `#12110E` | App background |
| `--bo-surface` | `#FFFFFF` | `#1C1A16` | Cards, panels, modals |
| `--bo-surface-2` | `#F3EFE8` | `#25221C` | Sunken areas, hover on surface, timeline track |
| `--bo-surface-3` | `#E8E2D6` | `#302C24` | Pressed, progress track, key states |
| `--bo-scrim` | `rgb(30 26 18 / 0.52)` | `rgb(0 0 0 / 0.64)` | Modal backdrop |
| `--bo-border` | `#DDD6C8` | `#3A352B` | Decorative dividers (not relied on to find a control) |
| `--bo-border-strong` | `#8C8576` | `#8A8373` | Control outlines (3:1 or more on bg, surface, surface-2) |
| `--bo-text` | `#1E1B16` | `#F3EFE6` | Body and headings (AAA) |
| `--bo-text-2` | `#433E34` | `#D2CBBB` | Secondary text (AAA) |
| `--bo-text-3` | `#655F52` | `#A9A292` | Captions, hints, timecodes only (AA) |
| `--bo-text-on-primary` | `#FFFFFF` | `#06282C` | Label on primary buttons |
| `--bo-link` | `#0B555D` | `#5BBFC8` | Links, ghost buttons (AAA) |
| `--bo-primary` | `#0B555D` | `#5BBFC8` | Brand, primary action, selected |
| `--bo-primary-hover` | `#09444B` | `#7ACFD6` | Primary hover |
| `--bo-primary-active` | `#06353A` | `#9BDDE2` | Primary pressed |
| `--bo-primary-soft` | `#D9EEF0` | `#12353A` | Tint behind selected nav, notices, drop zone |
| `--bo-primary-ink` | `#07484E` | `#A8E3E8` | Text on primary-soft (AAA) |
| `--bo-danger` | `#A52A2A` | `#F28B82` | Destructive action and errors |
| `--bo-danger-hover` | `#8A2020` | `#F5A59E` | Danger hover |
| `--bo-danger-soft` | `#FBE4E1` | `#3F1714` | Error tint |
| `--bo-danger-ink` | `#7A1C1C` | `#FFB4AA` | Text on danger-soft (AAA) |
| `--bo-text-on-danger` | `#FFFFFF` | `#2A0A08` | Label on danger buttons |
| `--bo-focus` | `#1D4ED8` | `#9DBBFF` | Keyboard focus ring |
| `--bo-disabled-bg` | `#ECE7DD` | `#25221C` | Disabled fill |
| `--bo-disabled-text` | `#8C8576` | `#6F695C` | Disabled label (exempt from contrast) |
| `--bo-selection` | `#BFE3E7` | `#1E4A50` | Text selection and pressed ghost |
| `--bo-thumb-base` | `#2A2620` | `#0B0A08` | Letterbox behind blurred thumbnails |
| `--bo-on-cat` | `#FFFFFF` | `#14110D` | Icon or text on a solid category colour |
| `--bo-pattern-ink` | `rgb(255 255 255 / 0.40)` | `rgb(0 0 0 / 0.34)` | Stripe colour inside timeline ranges |

### 3.2 Contrast ratios (WCAG 2.2, computed from the hex values above)

Text on backgrounds. AAA body means 7:1 or more.

| Pair | Light | Dark | Kid light | Kid dark | Needs |
|---|---|---|---|---|---|
| `text` on `bg` | 16.2 | 16.5 | 18.4 | 18.9 | AAA 7 |
| `text` on `surface` | 17.2 | 15.1 | 19.5 | 17.4 | AAA 7 |
| `text` on `surface-2` | 15.0 | 13.8 | 17.0 | 15.9 | AAA 7 |
| `text-2` on `bg` | 10.0 | 11.7 | 14.9 | 15.4 | AAA 7 |
| `text-2` on `surface` | 10.6 | 10.8 | 15.8 | 14.2 | AAA 7 |
| `text-2` on `surface-2` | 9.3 | 9.8 | 13.8 | 13.0 | AAA 7 |
| `text-3` on `bg` | 6.0 | 7.4 | 11.5 | 12.4 | AA 4.5 |
| `text-3` on `surface` | 6.3 | 6.8 | 12.2 | 11.4 | AA 4.5 |
| `text-3` on `surface-2` | 5.5 | 6.2 | 10.6 | 10.4 | AA 4.5 |
| `text` on `surface-3` | 13.3 | 12.1 | 15.1 | 13.9 | AAA 7 |
| `link` on `bg` | 8.0 | 8.7 | 9.4 | 11.8 | AAA 7 |
| `link` on `surface-2` | 7.4 | 7.3 | 8.7 | 9.9 | AAA 7 |
| `text-on-primary` on `primary` | 8.5 | 7.2 | 10.0 | 9.8 | AA 4.5 |
| `text-on-primary` on `primary-hover` | 10.8 | 8.7 | 12.1 | 11.1 | AA 4.5 |
| `text-on-primary` on `primary-active` | 13.3 | 10.3 | 14.5 | 12.4 | AA 4.5 |
| `primary-ink` on `primary-soft` | 8.5 | 9.3 | 10.4 | 10.5 | AAA 7 |
| `text-on-danger` on `danger` | 7.1 | 7.7 | 8.8 | 9.1 | AA 4.5 |
| `danger` on `surface` | 7.1 | 7.3 | 8.8 | 8.6 | AA 4.5 |
| `danger-ink` on `danger-soft` | 8.6 | 9.2 | 11.0 | 11.3 | AAA 7 |
| `border-strong` on `bg` | 3.5 | 5.0 | 8.4 | 9.3 | UI 3 |
| `border-strong` on `surface-2` | 3.2 | 4.2 | 7.8 | 7.8 | UI 3 |
| `focus` ring on `bg` | 6.3 | 9.9 | 9.0 | 12.3 | UI 3 |
| `focus` ring on `surface` | 6.7 | 9.1 | 9.5 | 11.3 | UI 3 |

### 3.3 Status colours

Every status is shown as icon + words + colour, never colour alone. Pill text meets AAA.

| Status | Class | Icon | Light bg / fg / border / solid | Dark bg / fg / border / solid | Text ratio L / D / kid L / kid D |
|---|---|---|---|---|---|
| Not scanned | `bo-pill--not-scanned` | scan | `#ECE7DD` / `#3B362D` / `#CFC7B6` / `#8C8576` | `#2B2821` / `#D2CBBB` / `#4A443A` / `#9A9384` | 9.7 / 9.1 / 12.8 / 12.0 |
| Scanning | `bo-pill--scanning` | rescan, rotating | `#E1EBFA` / `#17408F` / `#B5CBEF` / `#2F6FD0` | `#15294A` / `#A9C6FF` / `#2C4A82` / `#6FA3FF` | 8.1 / 8.4 / 10.7 / 10.9 |
| Needs review | `bo-pill--review` | eye | `#FBE9C4` / `#6B3F00` / `#EBC77B` / `#BF7600` | `#3B2A0A` / `#FFD27A` / `#6B4D12` / `#F2B13C` | 7.5 / 9.7 / 10.4 / 11.0 |
| Protected | `bo-pill--protected` | shield-check | `#DCF0E2` / `#14573A` / `#A9D5B8` / `#2E8B57` | `#123425` / `#9BE0B4` / `#25593F` / `#4CC38A` | 7.2 / 8.9 / 9.9 / 10.5 |
| Needs attention | `bo-pill--attention` | alert | `#FBE0DC` / `#8B1D1D` / `#EDB0A8` / `#C03A2B` | `#3F1714` / `#FFB4AA` / `#7A2B25` / `#F2705F` | 7.3 / 9.2 / 9.8 / 11.3 |

`--bo-status-*-solid` is used for progress bars, toast edges and dots; it is at least 3:1 against `surface` in all themes.

### 3.4 Category colours

Seven categories. Colour is the third cue: each category also has its own icon, its own fill pattern in the timeline and a text label.

| Category | Icon | Timeline pattern | Light solid / soft / ink | Dark solid / soft / ink | Solid vs surface-2 L / D | ink on soft L / D |
|---|---|---|---|---|---|---|
| Nudity | cat-nudity | 45 degree stripes | `#C2410C` / `#F8E8E2` / `#882E08` | `#F0904A` / `#4E3825` / `#F7C5A1` | 4.5 / 6.6 | 7.2 / 7.0 |
| Sex | cat-sex | cross-hatch | `#A21F7A` / `#F4E4EF` / `#881A66` | `#B86CD6` / `#423141` / `#DEBBEC` | 6.1 / 4.6 | 7.2 / 7.1 |
| Implied | cat-implied | dots | `#1F6FB5` / `#E4EEF6` / `#165082` | `#4DB6E8` / `#2D4045` / `#9FD8F3` | 4.6 / 6.9 | 7.1 / 7.0 |
| Kissing | cat-kissing | horizontal lines | `#D9558D` / `#FAEBF1` / `#823355` | `#F27BAE` / `#4E3439` / `#F8BDD6` | 3.3 / 6.2 | 7.1 / 7.1 |
| Gore | cat-gore | vertical lines | `#6B1218` / `#EDE3E3` / `#6B1218` | `#D23A44` / `#482724` / `#EDB0B4` | 10.6 / 3.3 | 9.7 / 7.2 |
| Language | cat-language | reverse diagonal stripes | `#5A7D2A` / `#EBEFE5` / `#3D551D` | `#8DB04A` / `#3A3E25` / `#C4D6A1` | 4.2 / 6.4 | 7.2 / 7.1 |
| Other | cat-other | solid | `#6B6558` / `#EDEDEB` / `#514D43` | `#8F8B82` / `#3A3730` / `#C9C7C3` | 5.1 / 4.7 | 7.2 / 7.0 |

Colour-blind check (Machado 2009 simulation at full severity, CIE76 distance between the closest two categories; 10 or more is clearly different at a glance, below that the pattern and icon carry the difference):

| Vision | Light closest pair | Dark closest pair |
|---|---|---|
| Normal | 23 (sex / kissing) | 38 (sex / kissing) |
| Deuteranopia | 17 (kissing / other) | 9 (sex / implied) |
| Protanopia | 10 (nudity / language) | 7 (nudity / language) |
| Tritanopia | 18 (language / other) | 10 (nudity / kissing) |

On-category contrast (icon or label on a solid category fill, `--bo-on-cat`): light 3.7 to 12.2, dark 4.0 to 8.2. It is used for icons only (graphics need 3:1); no text is ever set in light or dark ink directly on a solid category fill, text uses the `-ink` on `-soft` pair above.

### 3.5 Kid-mode colour overrides

| Token | Kid light | Kid dark |
|---|---|---|
| `--bo-text` | `#0E0C09` | `#FFFFFF` |
| `--bo-text-2` | `#26221B` | `#EDE8DB` |
| `--bo-text-3` | `#3A352C` | `#D8D1C1` |
| `--bo-border` | `#B3AB9A` | `#625C4F` |
| `--bo-border-strong` | `#4F493D` | `#BDB5A3` |
| `--bo-primary` | `#094A50` | `#86DAE2` |
| `--bo-primary-hover` | `#073C41` | `#A3E5EB` |
| `--bo-primary-active` | `#052E32` | `#BCEEF2` |
| `--bo-link` | `#094A50` | `#86DAE2` |
| `--bo-primary-ink` | `#043A3F` | `#C2EEF2` |
| `--bo-danger` | `#8F1F1F` | `#FF9C94` |
| `--bo-danger-ink` | `#5E1212` | `#FFD0CB` |
| `--bo-focus` | `#1537B0` | `#BDD0FF` |
| `--bo-status-not-scanned-fg` | `#26221B` | `#EDE8DB` |
| `--bo-status-scanning-fg` | `#0F2F6B` | `#CFE0FF` |
| `--bo-status-review-fg` | `#4D2D00` | `#FFE3A6` |
| `--bo-status-protected-fg` | `#0D4029` | `#BCEECF` |
| `--bo-status-attention-fg` | `#6B1212` | `#FFD0CB` |

## 4. Typography

Two bundled variable fonts, both SIL Open Font License 1.1, both latin subset (covers every Spanish character: a e i o u with acute, n with tilde, u with diaeresis, inverted question and exclamation marks). No italics are bundled and none are used: emphasis is weight 600 or 700 (`em` is styled that way in `base.css`).

| Role | Family | Weight range bundled | Used for |
|---|---|---|---|
| UI and body | **Atkinson Hyperlegible Next** | 200 to 800 (variable `wght`) | Everything except titles. Designed by the Braille Institute for maximum character distinction (the zero is slashed, I and l differ), which matters for PINs, timecodes and low-vision parents. Weights used: 400 body, 500 rarely, 600 buttons and labels, 700 bold labels and h4 to h6, 800 never. |
| Titles | **Fraunces** | 100 to 900 (variable `wght`), no `opsz`, `SOFT` or `WONK` axes | h1, h2, h3, movie titles, `bo-display`, modal titles. Weight 600 only. A warm, bookish serif that gives the app its "good eyes" voice without being cute. |

Fallback stacks (used while fonts load and if a file is missing): UI `"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`; titles `"Iowan Old Style", "Palatino Linotype", Georgia, serif`. `font-display: swap`.

### 4.1 Font files to download (not committed by the designer)

Place the two font files below in `desktop/renderer/assets/fonts/` (the `@font-face` rules in `base.css` already point there). Both are the "latin" subset woff2 builds from the Fontsource packages (pinned version 5.3.0, which are unmodified conversions of the upstream OFL fonts). Both URLs were checked and returned the files with the sizes and hashes below.

| File | Download URL (pinned) | Size | SHA-256 | Upstream project |
|---|---|---|---|---|
| `atkinson-hyperlegible-next-latin-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-next@5.3.0/files/atkinson-hyperlegible-next-latin-wght-normal.woff2 | 33,996 B | `18b2a1a39a2fa298b0ba5390aca68462669826c90925656f1c1f6796e0e1bbaf` | https://github.com/googlefonts/atkinson-hyperlegible-next , https://www.brailleinstitute.org/freefont/ |
| `fraunces-latin-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/fraunces@5.3.0/files/fraunces-latin-wght-normal.woff2 | 36,620 B | `7f9d191d999336d3b9790afa72e1358e50a13b06d4f289341e92a311967a80f9` | https://github.com/undercasetype/Fraunces , https://fonts.google.com/specimen/Fraunces |

Licence: SIL Open Font License 1.1 (https://openfontlicense.org). The OFL requires the licence text to travel with the font, so also save, in the same folder:

| File | Download URL |
|---|---|
| `OFL-AtkinsonHyperlegibleNext.txt` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-next@5.3.0/LICENSE |
| `OFL-Fraunces.txt` | https://cdn.jsdelivr.net/npm/@fontsource-variable/fraunces@5.3.0/LICENSE |

`tools/fetch-binaries.js` (or a one-off `curl`) should download these at build time and verify the SHA-256 above; the files are 70 KB in total and may simply be committed. These are the only external files; the running app makes no request to any CDN (the URLs are for the developer, never for the renderer). Copyright lines: "Copyright 2020 The Fraunces Project Authors" and "Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors".

### 4.2 Size scale (rem, 1rem = 16px; the root font size is never changed)

| Token | rem / px | Line height | Use |
|---|---|---|---|
| `--bo-fs-2xs` | 0.75 / 12 | 1.3 | Timecodes on the ruler, keycap hints. Never body copy. |
| `--bo-fs-xs` | 0.8125 / 13 | 1.3 | Status pills, overlines, captions in tiles |
| `--bo-fs-sm` | 0.875 / 14 | 1.3 to 1.5 | Secondary text, helper text, table cells, chips |
| `--bo-fs-md` | 1 / 16 | 1.5 | **Body** |
| `--bo-fs-lg` | 1.125 / 18 | 1.65 (`lead`) | Lead paragraphs, large buttons, card titles |
| `--bo-fs-xl` | 1.25 / 20 | 1.3 | h4, panel titles, play tile titles |
| `--bo-fs-2xl` | 1.5 / 24 | 1.3 | h3, modal title, PIN title |
| `--bo-fs-3xl` | 1.875 / 30 | 1.15 | h2, page titles |
| `--bo-fs-4xl` | 2.375 / 38 | 1.15 | h1 |
| `--bo-fs-5xl` | 3 / 48 | 1.15 | `bo-display`, first-run welcome |

Line heights: `--bo-lh-tight` 1.15 (display), `--bo-lh-snug` 1.3 (headings, labels), `--bo-lh-normal` 1.5 (body), `--bo-lh-loose` 1.65 (help text, `lead`). Tracking: titles `-0.012em`, overlines `+0.06em` uppercase, everything else 0. Numbers that line up (timecodes, counts, PIN) use `font-variant-numeric: tabular-nums` (class `bo-num`). Paragraphs are capped at 68ch and use `text-wrap: pretty`; headings `text-wrap: balance`.

### 4.3 Kid-mode scale (`data-mode="kid"`)

Every size steps up one to two notches, minimum 15px, body 20px.

| Token | Normal | Kid |
|---|---|---|
| `--bo-fs-2xs` / `xs` / `sm` | 12 / 13 / 14 px | 15 / 16 / 18 px |
| `--bo-fs-md` (body) | 16 px | 20 px |
| `--bo-fs-lg` / `xl` | 18 / 20 px | 24 / 28 px |
| `--bo-fs-2xl` / `3xl` | 24 / 30 px | 34 / 42 px |
| `--bo-fs-4xl` / `5xl` | 38 / 48 px | 52 / 64 px |
| `--bo-lh-normal` | 1.5 | 1.55 |

## 5. Space, shape, elevation

### 5.1 Spacing (4px base)

`--bo-space-0` 0, `-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-5` 20px, `-6` 24px, `-7` 32px, `-8` 40px, `-9` 48px, `-10` 64px, `-11` 80px. Rules: inside a control use 2 to 5; between related items 2 to 4; between groups 5 to 7; page gutter `--bo-gutter` 24px (kid 32px). Kid mode enlarges `-3` to 16, `-4` to 20, `-5` to 28, `-6` to 32 so every composed component grows with it.

### 5.2 Radii

`--bo-radius-xs` 4px (keycaps, range bars), `-sm` 8px (buttons, inputs, chips), `-md` 12px (segmented control, toasts, thumbnails), `-lg` 16px (cards, panels, tiles), `-xl` 24px (modals, drop zone), `-pill` 999px (status pills, switches). Kid mode: sm 12, md 16, lg 24, xl 32.

### 5.3 Borders

`--bo-border-width` 1px (decorative dividers, cards), `--bo-border-width-strong` 2px (every control outline: buttons, inputs, segmented, chips). Kid: 2px and 3px. Dividers use `--bo-border`; control outlines use `--bo-border-strong` (3:1).

### 5.4 Elevation

Warm, soft, never harsh. In dark mode shadows are black plus a 1px white-at-4% hairline so edges still read.

| Token | Light | Used for |
|---|---|---|
| `--bo-shadow-1` | `0 1px 2px rgb(60 45 20 / .08), 0 1px 1px rgb(60 45 20 / .05)` | Cards at rest, primary buttons, tiles |
| `--bo-shadow-2` | `0 2px 6px rgb(60 45 20 / .10), 0 1px 2px rgb(60 45 20 / .06)` | Hover on cards, side panel, selected range row |
| `--bo-shadow-3` | `0 8px 24px rgb(60 45 20 / .14), 0 2px 6px rgb(60 45 20 / .08)` | Toasts, drawer, play-tile hover, play badge |
| `--bo-shadow-4` | `0 24px 64px rgb(40 30 10 / .24), 0 4px 12px rgb(40 30 10 / .10)` | Modals only |
| `--bo-shadow-inset` | `inset 0 1px 2px rgb(60 45 20 / .12)` | Pressed buttons |

Layers: drawer 20, panel 30, modal 50, toast 60 (`--bo-z-*`).

### 5.5 Focus ring (keyboard visible, never removed)

Two rings so it reads on every surface, including on top of photographs: a gap in the page colour (`--bo-focus-gap` 2px, kid 3px), then a ring in `--bo-focus` (`--bo-focus-width` 3px, kid 4px). Light `#1D4ED8`, dark `#9DBBFF`, kid light `#1537B0`, kid dark `#BDD0FF`; at least 6:1 on bg and surface in all four. Shown with `:focus-visible` only (keyboard and programmatic focus, not mouse clicks). Implementation: `outline: var(--bo-focus-width) solid var(--bo-focus); outline-offset: var(--bo-focus-gap); box-shadow: 0 0 0 var(--bo-focus-gap) var(--bo-bg)`. Segmented options (clipped by their container) draw the ring inside. In Windows high-contrast mode the ring becomes the system `Highlight` colour. Every interactive element is reachable by Tab in reading order; the PIN pad, level picker and timeline also accept arrow keys (section 7).

### 5.6 Motion

| Token | Value | Use |
|---|---|---|
| `--bo-dur-instant` | 80ms | Press feedback (translateY 1px, scale .96) |
| `--bo-dur-fast` | 120ms | Hover, colour changes, peek re-blur |
| `--bo-dur-base` | 200ms | Drawer chevron, modal and drop-zone transitions, switch |
| `--bo-dur-slow` | 320ms | Progress bar growth, PIN shake |
| `--bo-dur-toast` | 400ms | Toast entrance |
| `--bo-ease-standard` | `cubic-bezier(.2,0,0,1)` | Everything that moves between two states |
| `--bo-ease-enter` | `cubic-bezier(0,0,.2,1)` | Things appearing (toast, modal) |
| `--bo-ease-exit` | `cubic-bezier(.4,0,1,1)` | Things leaving |

Motion is short, small (12px travel at most, scale between .96 and 1.08) and never loops except the scanning arc (`bo-spin`, 1.4s linear). Reduced motion (OS or `data-motion="reduce"`): all animation and transition durations collapse to 0.001ms, the spinner stays a static arc, the PIN shake is replaced by the coloured error message that is always shown, toasts appear without sliding. Meaning is never carried by motion alone.

## 6. Targets and density

| Token | Normal | Kid | Rule |
|---|---|---|---|
| `--bo-target` | 44px | 64px | Default hit area for every button, input, key, nav item |
| `--bo-target-lg` | 56px | 80px | Primary actions: Play, Approve, Add movie |
| `--bo-target-sm` | 32px | 48px | Dense toolbars and the drawer only; keep 8px between neighbours |
| Icons `--bo-icon-sm / md / lg / xl` | 16 / 20 / 24 / 40 | 24 / 28 / 36 / 56 | Icon inside text is 1.25em |

Windows minimum size 1024×640. Nothing in the app scrolls horizontally; the timeline scrolls inside its own frame when zoomed.

## 7. Components

Conventions. Class names are `bo-block`, `bo-block__element`, `bo-block--modifier`. Every state can be forced for screenshots and tests with `.is-hover`, `.is-active`, `.is-focus`, `.is-selected`, `.is-disabled`, `.has-error`; the real pseudo-classes produce the same look. Component-private custom properties start with `--_` and are not part of the API. Static states work with no JavaScript: the level picker, drawer, switch, chip choice, drop zone focus, timeline and progress are all native HTML (radio, details, checkbox, progress) styled by CSS.

Values set per element from JavaScript (all through `el.style.setProperty`, which the CSP allows; inline `style=""` attributes in markup are blocked by `default-src 'self'`, the preview page uses them only because it is a static file): `--s` and `--w` (range start and width, percent), `--x` (tick and playhead position, percent), `--n` (strip tile count), `--zoom` (timeline zoom factor).

State legend in the tables below: D default, H hover, A active (pressed), F focus (keyboard), X disabled.

### 7.1 Buttons

`bo-button` plus `--primary`, `--secondary`, `--ghost`, `--danger`, `--quiet-danger`; sizes `--lg` (56px, 18px type), default (44px), `--sm` (32px); shapes `--icon` (square), `--block` (full width). Label 16px / 600, centred, wraps instead of truncating (`text-wrap: balance`), minimum width = content + 40px side padding. One primary button per view or modal. Icons are 20px, 8px before the label. Toggle buttons use `aria-pressed="true"` (tinted `primary-soft`, `primary` border).

| State | Primary | Secondary | Ghost | Danger |
|---|---|---|---|---|
| D | `primary` fill, `text-on-primary` label, shadow-1 | `surface` fill, 2px `border-strong`, `text` label | transparent, `link` label | `danger` fill, `text-on-danger` label |
| H | `primary-hover`, shadow-2 | `surface-2` fill, border `text-2` | `primary-soft` fill | `danger-hover` |
| A | `primary-active`, inset shadow, down 1px | `surface-3`, inset shadow, down 1px | `selection` fill, down 1px | `danger-hover`, inset, down 1px |
| F | Focus ring (5.5) | same | same | same |
| X | `disabled-bg` fill, `disabled-text` label, no shadow, `not-allowed` cursor | same | transparent, `disabled-text` | same as primary |

### 7.2 Big Play tile (kid mode) and title card (parent library)

`bo-play-tile` is one `<button>`: 16:9 thumbnail, a centred 56px (kid 80px) round Play badge in `primary` with a 4px white-85% ring, the title in Fraunces 20px (kid 28px), one meta line. The whole tile is the target; there is nothing else on it. Only Protected titles appear in kid mode. `--kid` adds 16px padding and 32px radius.

| State | Look |
|---|---|
| D | `surface` card, 2px `border`, shadow-1, badge `primary` |
| H | shadow-3, border `primary`, badge scales 1.08 and goes `primary-hover` |
| A | scale .985, shadow-1, badge `primary-active` |
| F | Focus ring around the card |
| X | `surface-2`, `text-3`, flat, thumbnail at 60%, grey badge. Use only for "not ready yet"; prefer hiding the tile. |

`bo-title-card` (parent library): thumbnail (blurred until the scan has proven it clean, 12), title (Fraunces 18px), meta line, status pill, then a full-width primary Play (or Review, or a secondary Scan now) and a 44px more button. Hover and focus-within raise it to shadow-2 and `border-strong`. A scanning card hides the pill's progress bar (the percentage stays) and shows the same bar in the drawer.

### 7.3 Status pill

`bo-pill bo-pill--{not-scanned|scanning|review|protected|attention}`: icon 1.125em, then words, 13px bold, height 28px (kid 34px), pill radius, 1px border. Wraps its words if the column is narrow; never truncates; never uses colour as the only cue (icon and words always present). The scanning pill has an inline 3.5em `<progress class="bo-pill__progress">` and a percentage, and its icon (`rescan`) rotates (static under reduced motion). Colours: section 3.3.

| Status | Words (EN / ES) | Icon | When |
|---|---|---|---|
| Not scanned | Not scanned / Sin analizar | scan | Added, never scanned |
| Scanning | Scanning 43% / Analizando 43% | rescan | Currently or queued and started |
| Needs review | 3 to review / 3 por revisar | eye | Scan done, pending ranges exist |
| Protected | Protected · 12 scenes / Protegida · 12 escenas | shield-check | Scan done and every range reviewed (or parent chose Approve all) |
| Needs attention | Needs attention / Requiere atención | alert | Scan failed three times, file missing, skip file corrupt |

### 7.4 Level picker (Off, Light, Moderate, Strict)

`<fieldset class="bo-level bo-cat--nudity">`: legend with the category icon and name (18px bold), then four radio inputs (`bo-level__input--off|light|moderate|strict`), then `bo-segmented` with four `<label class="bo-segmented__opt bo-segmented__opt--off">`, then four one-sentence descriptions (`bo-level__desc--off` and so on). The description of the checked level is shown, the others are hidden by CSS alone. Each option shows a three-bar meter (0, 1, 2, 3 bars filled) above its word so strictness reads without colour, 56px tall. Arrow keys move between options (native radio behaviour); the ring is drawn inside the option.

| State | Look |
|---|---|
| D | `surface` fill, `text` label, 1px dividers inside a 2px `border-strong` frame, radius-md |
| H | `surface-2` |
| A | `surface-3` |
| Selected | `primary` fill, `text-on-primary`, bars full-strength |
| F | Inner 3px ring over a 2px `primary-soft` band |
| X | `disabled-bg` and `disabled-text`; the whole group at 55% opacity with `is-disabled` |

One-sentence explanations, shown under the control (locale keys `level.off.desc`, `level.light.desc`, `level.moderate.desc`, `level.strict.desc`):

| Level | English | Español (MX) |
|---|---|---|
| Off / Apagado | Nothing is skipped for this. | No se omite nada de esto. |
| Light / Ligero | Skips only the scenes we are very sure about. | Omite solo las escenas de las que estamos muy seguros. |
| Moderate / Moderado | Skips clear scenes and most borderline ones. | Omite las escenas claras y casi todas las dudosas. |
| Strict / Estricto | Skips anything that might be this, even when unsure. Best for young children. | Omite todo lo que podría serlo, aun con dudas. Ideal para niños pequeños. |

### 7.5 PIN pad

`bo-pin`: title (Fraunces 24px), 4 to 6 dots (20px circles, filled with `text` when entered), one message line (always reserves its height so nothing jumps), 3×4 grid of 72px keys with 12px gaps: 1 to 9, backspace (`undo` icon, no fill), 0, confirm (`check`, `primary`). The pad is 240px wide and centred. Digits are also typed from the keyboard; Backspace and Enter work. Keys are `<button>`s in reading order.

| State | Look |
|---|---|
| Key D | `surface`, 2px `border`, shadow-1, 24px / 600 tabular digit |
| Key H | `surface-2`, `border-strong` |
| Key A | `primary-soft` fill, `primary` border, scale .96 |
| Key F | Focus ring |
| Key X | `disabled-bg`, `disabled-text`, flat |
| Error (`has-error`) | Dots turn `danger`, message in `danger` bold ("That is not the PIN. Try again."), dots shake 8px twice in 320ms (static under reduced motion; the message is the signal) |
| Locked (`is-locked`) | All keys disabled; message in `status-review-fg` with the countdown; unlocks itself |

### 7.6 Toast

`bo-toast bo-toast--{info|success|warning|error}` inside `bo-toast-region` (fixed bottom-right, 24px from the edge, above the drawer, 28rem wide, stacked with 12px gaps, `aria-live="polite"`; errors use `role="alert"`). Left edge 6px in the status colour, 24px icon, bold title (one line), optional 14px sentence, optional action buttons (`ghost` or `secondary`, small), 32px close button. Enters with a 12px rise and fade in 400ms, auto-dismisses after 6s (10s when it has an action, never while hovered or focused; errors stay until dismissed). Maximum three at once; extra ones queue.

| State | Look |
|---|---|
| D | `surface`, 1px `border`, shadow-3, radius-md |
| Close H / A | `surface-2` / `surface-3` |
| Leaving | `is-leaving`: 200ms fade and 4px drop |

### 7.7 Modal

`bo-modal-backdrop` (scrim `--bo-scrim`) containing `bo-modal` (`role="dialog"`, `aria-modal`, 32rem wide, `--wide` 46rem, radius-xl, shadow-4): header with a 48px round icon (`primary-soft`, or `danger-soft` for `--danger`) and a Fraunces 24px question title, body in `text-2`, footer right-aligned: secondary (cancel) then primary. Destructive confirmations put the safe action first and name the consequence in the title ("Remove this movie from the library?"). Focus moves to the least destructive button, is trapped inside, Escape cancels, focus returns to the opener. Entrance 200ms (8px rise, scale .98 to 1); no animation under reduced motion. `bo-modal-backdrop--inline` is for static demos only.

### 7.8 Drop zone

`<label class="bo-dropzone"><input type="file" class="bo-dropzone__input"><span class="bo-dropzone__body">` with a 64px round icon, Fraunces title, 14px hint, and a secondary "Choose files" button. Minimum height 224px, 2px dashed `border-strong`, radius-xl. Compact variant (`--compact`) is a single 80px row for the library header. While a file is dragged anywhere over the window, the whole window shows `bo-dropzone--overlay` (inset 16px, solid `primary` border, `primary-soft`).

| State | Look |
|---|---|
| D | `surface`, dashed `border-strong` |
| H | `surface-2`, dashed `primary` |
| Drag over (`is-dragover`) | `primary-soft`, solid `primary` border, scale 1.01, icon becomes a filled `primary` disc with a download arrow, title "Drop to add" |
| F | Focus ring around the dashed box (the hidden file input receives focus; Enter or Space opens the picker) |
| X | `disabled-bg`, `disabled-text`, no pointer, hint says why ("Finish the current scan first.") |
| Error (`has-error`) | `danger-soft`, dashed `danger`, `alert` icon on a `danger` disc, hint in `danger-ink` bold saying what to do |

### 7.9 Scan queue drawer

A native `<details class="bo-drawer bo-drawer--dock">` docked to the bottom of the window. Collapsed bar is 64px: scan icon (rotating while running), bold title ("Scanning “The Long Way Home”") over a 14px sentence (stage, percent, time left), a progress bar (hidden below 44rem drawer width, the percent stays in the sentence), a small Pause button, chevron. Expanded it adds a list (max 256px, scrolls) of queue rows: number, title, status words, progress, remove button. The active row is `primary-soft`; a paused row says why in `status-review-fg` ("Paused while a movie plays"). The summary is one tab stop; Enter or Space toggles. The drawer never covers the library's bottom content: `bo-main` reserves `--bo-drawer-h` plus the gutter.

### 7.10 Timeline with category ranges and blurred thumbnail strip

Structure from top: ruler (hh:mm ticks, 12px `text-3`), range track (48px, `surface-2`, 1px border), blurred thumbnail strip (56px), legend. A 2px `text` playhead with a triangle head spans track and strip. The whole canvas scrolls horizontally inside its frame and zooms with `--zoom` (1× to 32×; Ctrl+wheel, `+` and `-` buttons, `0` fits). A range is a 32px-high bar placed by `--s` and `--w`, minimum 14px wide.

Category look: fill `--bo-cat-*`, plus its own stripe pattern in `--bo-pattern-ink` (45° stripes nudity, cross-hatch sex, dots implied, horizontal lines kissing, vertical lines gore, reverse stripes language, solid other), plus its icon in a 22px disc when the bar is at least 28px wide, plus a state mark when at least 56px wide. Narrower bars show colour and pattern only; the full label is in the side panel, the list and `aria-label`.

| Range state | Look |
|---|---|
| Pending (`is-pending`) | Solid fill with a dashed 2px inner frame in `on-cat` |
| Approved (`is-approved`) | Solid fill, check disc |
| Rejected (`is-rejected`) | Hollow: `surface` fill, 2px category outline, struck through, close mark |
| H | Lifts 1px, shadow-2 |
| Selected (`is-selected`) | 2px page-colour gap plus 3px `text` outline, edge handles appear, raised above neighbours |
| F | Focus ring (outside the selection ring) |

Edge handles (`bo-handle--start|end`, `role="slider"`): 10px wide dark grip with two light grooves, inside a 28px-wide transparent hit area; cursor `ew-resize`. Hover widens the grip 25%; drag turns it `primary`. Keyboard: Left and Right move the focused edge 0.5s, Shift+arrow 5s, Home and End jump to the neighbouring cut; the new time is announced through `aria-valuetext` ("1:10:02.5"). The strip tile under a flagged range is tinted with the category veil and has a 4px category bar at its top.

### 7.11 Range side panel

`bo-panel`, docked to the right for the full window height (360px; 448px from a 1600px-wide window), three rows: header, scrolling body, sticky footer.

Header: category chip, status pill, time span in 20px bold tabular ("1:10:02 – 1:13:21"). Body sections, each titled with a 13px uppercase overline: (1) the blurred thumbnail (16:9, section 12) and the generated note; (2) What we found: intensity dots and word, certainty percent, three signal bars (Picture, Words, Sound; bars in `text-2`, never category colours); (3) Category: seven choice chips, the chosen one gets `-soft` fill, category border and a check; (4) When it plays: three-way segmented control Skip / Blur / Mute; (5) Edges: two rows "Starts" and "Ends", each `[− 0.5] [1:10:02.0] [+ 0.5]` (44px nudge buttons; holding repeats). Footer: Approve (primary) and Reject (secondary) side by side, then Peek (ghost, hold) across the full width.

States: Approve H, A as 7.1. When the range is already approved the Approve button reads "Approved" with a check and is `aria-pressed`; Reject likewise. Nudge buttons are disabled at the neighbouring range or the movie edge.

### 7.12 Parents card

`bo-parents-card`: header (movie title in Fraunces 20px, one meta line, overall status pill), one row per category in this fixed order: Nudity, Sex, Implied, Kissing, Gore, Language, Other (Other only if it has marks). Row: 36px round icon on the category `-soft`, name (600), count ("3 scenes"), three intensity dots (filled by intensity: 1 mild, 2 moderate, 3 strong; ring-style dots coloured with the category so the number is readable without colour), and the word (Mild, Moderate, Strong). A category with no marks shows "None found" and a check, in `text-2`. Footer on `surface-2`: "Counts only. We never describe the scenes." The card never contains a description, a timestamp list or an image.

### 7.13 Hotkey cheat sheet

`bo-hotkeys`: grid of groups (Watching, Marking, Panic), each an overline title and rows of `[keycaps] label`. Keycaps `bo-kbd`: 32px high, min 32px wide, 1px `border-strong` with a 3px bottom edge, radius-xs, 14px bold; `.is-active` presses down 2px (used on the Now playing panel to echo a real keypress). Key combinations are separate caps joined by a quiet "+". Panic keys are drawn in `danger`. Arrow keys use the chevron icons. The same component appears in Settings > Playback, on the Now playing panel, and under `?` in the review screen.

### 7.14 Supporting components

| Component | Classes | Notes |
|---|---|---|
| Category chip | `bo-chip bo-chip--nudity` | Icon + word, `-soft` fill, 2px category border, `-ink` text (AAA). `bo-chip-choice` wraps a radio; unselected is `surface` with `border-strong`; selected is `-soft` with category border and a check. |
| Swatch | `bo-swatch bo-swatch--nudity` | 24×16 fill plus pattern, used in legends. |
| Intensity dots, level bars | `bo-dots bo-dots--2 bo-dots--sex`, `bo-bars bo-bars--3` | Decorative; always accompanied by words or `aria-label`. |
| Card | `bo-card`, `--flat`, `--interactive` | `surface`, 1px border, radius-lg, 24px padding, shadow-1. |
| Field | `bo-field`, `bo-input`, `has-error` | Label above (600), input 44px with 2px `border-strong`, help line, error line with `alert` icon in `danger` bold; error also fills the input `danger-soft`. Focus: `primary` border plus ring. |
| Switch | `bo-switch` | 52×30 track, 20px thumb that moves 22px, `primary` when on, plus words On or Off beside it (never colour or position alone). |
| Progress | `bo-progress`, `--thick` | Native `<progress>`; 8px, `surface-3` track, `primary` value. |
| Notice | `bo-notice`, `--warning`, `--error` | Inline message with icon; for permanent explanations ("Everything stays on this computer"). |
| Empty state | `bo-empty` | 80px icon disc, Fraunces 24px title, one sentence, one large primary button. |
| Nav | `bo-nav`, `bo-nav__item`, `aria-current="page"` | 44px items, radius-md, current = `primary-soft` fill, `primary-ink` bold text, 4px `primary` bar on the left. Review count badge uses the review colours. |
| Skip link | `bo-skip-link` | First element in `body`; visible on focus. |

## 8. Layout grids

Layout classes react to the **window** width, not the screen: `.bo-app` is a size container and the rules use `@container bo-app (...)`. Wrap the whole UI in `<div class="bo-app">`. Targets: Windows minimum window 1024×640, and 1920×1080 full screen. Spacing between regions is `--bo-gutter` 24px.

### 8.1 Library

```
1024 x 640 (rail)                                        1920 x 1080 (sidebar)
+----+---------------------------------------+         +--------+--------------------------------------------------------+
|logo| Library                [+ Add movie]   |         | logo   | Library 8 movies - 5 protected        [+ Add movie]     |
|rail| 8 movies - 5 protected                 |         | Library|                                                         |
| 76 | +---------+ +---------+ +---------+    |         | To rev.|   +------+ +------+ +------+ +------+ +------+        |
| px | |  thumb  | |  thumb  | |  thumb  |    |         | Send TV|   | 16:9 | | 16:9 | | 16:9 | | 16:9 | | 16:9 |  row 1  |
|    | | title   | | title   | | title   |    |         | Settings|  | card | | card | | card | | card | | card |         |
|nav | | [pill]  | | [pill]  | | [pill]  |    |         | Help   |   +------+ +------+ +------+ +------+ +------+        |
|icons| |[Play][..]| |[Play][..]| |[Play][..]| |         |        |   +------+ +------+ ...                    row 2   |
|    | +---------+ +---------+ +---------+    |         | [Lock] |   content max 1440, centred                             |
|    | (second row scrolls)                    |         |  240px |                                                         |
+----+---------------------------------------+         +--------+--------------------------------------------------------+
| (rescan) Scanning "..." - 43%      [Pause] v|  64px   | (rescan) Scanning "..." - 43% ====----        [Pause]  v        |
+--------------------------------------------+         +-----------------------------------------------------------------+
```

| Window | Sidebar | Main | Grid | Tile |
|---|---|---|---|---|
| 1024×640 (up to 1100 wide) | 76px rail: logo mark and 24px icons, labels visually hidden but kept for screen readers; 12px padding | 1024-76 = 948, minus 2×24 gutter = 900 | `repeat(auto-fill, minmax(15rem, 1fr))`, 24px gap: **3 columns** of 284px | 160px thumbnail + about 170px body; one full row plus a peek of the second above the 64px drawer |
| 1920×1080 | 240px (`--bo-sidebar-w`) | 1680 wide, content capped at 1440 (`--bo-content-max`) and centred (96px margins) | same rule: **5 columns** of 269px | Two full rows visible, third scrolls |

Header row: page title (Fraunces 30px) with a 16px grey subtitle, right-aligned primary large "Add movie". An empty library replaces the grid with `bo-empty` plus the large drop zone. The drop zone compact variant is not needed in the header because the whole window is a drop target.

### 8.2 Review

```
1024 x 640                                                  1920 x 1080 (>= 1600 wide: panel 448, side padding 40)
+----------------------------------------------+---------+ +---------------------------------------------------+---------------+
| [< Back]  The Long Way Home  [Approve all]   | panel   | | [< Back]  The Long Way Home        [Approve all]  | panel         |
| (Nudity 3)(Sex 1)(Implied 4)(Kissing 2)...   | 360px   | | (Nudity 3)(Sex 1)(Implied 4)(Kissing 2)(Lang. 7)  | chip + pill   |
| 0:00      0:30     1:00     1:30     2:00    | full    | | 0:00        0:30        1:00        1:30   2:00   | time span     |
| [track  ranges  ====  playhead  ====]        | height  | | [track ................ ranges ...............]   | thumb (blur)  |
| [blurred strip ###############]              |         | | [blurred strip ##########################]       | note          |
| legend (wraps to 2 lines)                    | header  | | legend                                            | what we found |
| +------------------------------------------+ | body    | | +-----------+ +-----------+ +-----------+         | category      |
| | range row  Nudity 0:15:02-0:16:41 [pill] | | scrolls | | | range row | | range row | | range row |  3 cols | when it plays |
| | range row  Kissing ...                   | |         | | +-----------+ +-----------+ +-----------+         | edges         |
| | (list scrolls on its own)                | | footer  | |  (list scrolls)                                   | [Approve][Rej]|
| +------------------------------------------+ | sticky  | |                                                   | [Hold to peek]|
+----------------------------------------------+---------+ +---------------------------------------------------+---------------+
```

Review has no sidebar (a focused task with a Back button). 24px window padding (40px at 1600+). Left column rows: bar 44px, summary chips 32px, timeline about 220px (ruler 24, track 48, strip 56, legend 24 to 48, gaps), range list takes the rest and scrolls. At 1024 wide the timeline is 596px for a two-hour film, about 5px per minute, so the zoom control is always visible; at 1920 it is 1360px (about 11px per minute). The side panel is the same component at both sizes; its footer is always visible. The range list is one column of rows at 1024 and `repeat(auto-fill, minmax(24rem, 1fr))` at 1600+.

### 8.3 Settings

```
1024 x 640                                                  1920 x 1080
+----+------------+--------------------------------+       +--------+------------+---------------------------------+-------------+
|rail| Protection | Settings                       |       | sidebar| Protection | Settings                        | What we     |
| 76 | Playback   | Choose what is skipped...      |       |  240   | Playback   | [Nudity  level picker  ]        | found       |
|    | Scanning   | [ Nudity  Off|Light|Mod|Strict]|       |        | Scanning   | [Implied level picker  ]        | (help aside |
|    | Privacy    | one-sentence explanation       |       |        | Privacy    | [Language level picker ]        |  20rem,     |
|    | Language   | [ Implied ...                ] |       |        | Language   | [Gore ...]                      |  sticky)    |
|    | and PIN    | (content scrolls)              |       |        | and PIN    | cards, 52rem max (832px)        |             |
+----+------------+--------------------------------+       +--------+------------+---------------------------------+-------------+
   176px nav (11rem), 20px gap, content 704px                 224px nav, 32px gaps, content 832px, aside 320px; total <= 1440, centred
```

The content column never exceeds 52rem (about 75 characters per line). Each category is a level picker inside one card (24px between pickers); rows of switch settings use `bo-settings-row` (title, 14px help, control right). Sections are separate cards, 24px apart. The help aside appears from 1500px wide and repeats the explanation of the selected control; below that the explanation sits under the control as in 7.4.

### 8.4 Kid home

Locked screen, no sidebar: a 64px bar (logo left, lock button right, 80px target with the word "Parent"), then `bo-kid__grid`: `repeat(auto-fill, minmax(20rem, 1fr))` with 32px gaps of `bo-play-tile--kid`. At 1024×640 that is 2 columns of about 470px; at 1920×1080 it is 4. Nothing else is on screen: no pills, no counts, no settings.

## 9. Iconography

One family, drawn by hand on a **24×24 grid** with a **2px safe margin** (live area 20×20). Stroke **1.75px**, round caps, round joins, no fill (a few shapes such as the play triangle and the pause bars are drawn as outlines too; the Play badge fills its triangle with `fill: currentColor` through CSS). Colour is always `currentColor`, so an icon takes the colour of its text. Corners that are not stroke ends use radii of 1.5 to 2.5 units; counters are at least 3 units wide so the icons survive at 16px. No gradients, no two-tone, no filled variants, no emoji.

Sizes: 16 (inside pills and nudge buttons), 20 (inside buttons, default), 24 (nav, standalone), 40 (empty states, drop zone 32), kid mode one step larger. The stroke does not scale with size: it is 1.75 in the 24-unit space, so a 16px icon has a 1.2px stroke and a 40px icon 2.9px, which is intended.

Delivery. Each icon is a stand-alone file `desktop/renderer/assets/icons/<name>.svg` (`viewBox="0 0 24 24"`, `stroke="currentColor"`) for documentation, the extension and tooling. In the renderer, **do not** load them with `<img>` (cannot take `currentColor`) or CSS `mask-image` (blocked from `file://`, verified: Chromium treats mask images as cross-origin and refuses them). Use an inline sprite: paste one `<svg id="bo-sprite" class="bo-sr-only" width="0" height="0" aria-hidden="true">` of `<symbol id="bo-i-NAME" viewBox="0 0 24 24">…</symbol>` into `index.html` (the one in `design-preview.html` is the reference; the planner may later generate it from the files with a build step), then use `<svg class="bo-icon" aria-hidden="true"><use href="#bo-i-play"/></svg>`. Decorative icons are `aria-hidden`; an icon-only button carries `aria-label`. The sprite carries a class, not a `style` attribute, because the CSP blocks inline styles; `design-preview.html` uses a style attribute only because it is a static file.

The 45 icons:

| Group | Names |
|---|---|
| Transport (6) | `play`, `pause`, `skip`, `volume-off` (mute action), `panic`, `flag` (marks) |
| Protection (5) | `lock`, `unlock`, `shield-check` (protected), `eye` (review, peek), `eye-off` (hidden or blurred) |
| Interface (17) | `plus`, `minus`, `check`, `close`, `chevron-down`, `chevron-left`, `chevron-right`, `more`, `alert`, `info`, `help`, `settings`, `keyboard`, `globe`, `edit`, `trash`, `undo` |
| Library and devices (10) | `library`, `film`, `folder-plus`, `download`, `upload`, `tv`, `usb`, `clock`, `scan` (not scanned), `rescan` (scanning) |
| Content categories (7) | `cat-nudity` (outline of a person), `cat-sex` (two overlapping circles), `cat-implied` (dashed circle with three dots), `cat-kissing` (heart), `cat-gore` (drop), `cat-language` (speech bubble with an exclamation mark), `cat-other` (tag) |

Category glyphs are deliberately abstract: they name the category, they never depict it.

## 10. Logo

The mark is an almond-shaped eye, a ring and a pupil with one small catch-light: an open, steady, kind gaze. It is one compound path with the even-odd rule (almond filled, ring cut out, pupil filled, catch-light cut out), so it is a single shape, needs no gradients, works in one colour on any background (the ring and catch-light are real holes, not white paint) and stays recognisable at 16px (the almond, a ring and a dot survive). The wordmark "bonis oculis" is set in lowercase Fraunces 600, converted to outlines (so the logo needs no font), tracking +0.3 units, with the lower-case word-space of the font.

| Asset | File | ViewBox | Notes |
|---|---|---|---|
| Lockup | `assets/logo.svg` | `0 0 189.8 32` | Mark 32 high at the left, 10 units gap, wordmark vertically centred on its x-height. |
| Mark only | `assets/logo-mark.svg` | `0 0 32 32` | Use below 96px wide and as the app icon motif. |

Geometry on the 32-unit grid: almond from x=1 to x=31, height 18 (y 7 to 25); ring hole radius 6.6 at (16,16); pupil radius 3.1; catch-light radius 1.05 at (17.6, 14.75).

Colour: mark `#0B555D` (light) or `#5BBFC8` (dark), wordmark `#1E1B16` (light) or `#F3EFE6` (dark). The files carry a `prefers-color-scheme` style so an `<img>` follows the OS theme (an `<img>` cannot see `data-theme`; where the app forces a theme, use the mark inline with `fill: currentColor`, as the preview does). Monochrome: delete the style block, or set both classes to one colour; nothing else changes.

Use: minimum mark 16px, minimum lockup height 16px (about 95px wide); clear space on every side is a quarter of the mark's height (8 units); on a colour fill use white or `#1E1B16`, never the teal on teal. Do not rotate, stretch, outline, add shadows or put the eye on a person. The app icon is the mark in `#FAF8F4` on a `#0B555D` rounded square (22% corner radius), 1024 master, to be exported by the implementer.

## 11. Component and CSS API cheat sheet

| Need | Do |
|---|---|
| Category colouring | Put `bo-cat--nudity` (or any category) on an ancestor, or use the component's own `--nudity` modifier. The private colours `--_c`, `--_c-soft`, `--_c-ink`, `--_c-veil`, `--_c-pattern` resolve from it. |
| Status colouring | `bo-pill--protected` etc. |
| Place a range | `<div class="bo-range bo-range--gore is-pending" style="--s:44.3%;--w:1%">`; set the two properties with `setProperty`. |
| Show progress | Native `<progress value max>`; no JS beyond setting `value`. |
| Open the drawer | Native `<details open>`; no JS. |
| Toggle kid mode | `documentElement.setAttribute('data-mode','kid')`. Remove the attribute for normal mode. |
| Announce changes | Toasts and the PIN message are `role="status"`; errors `role="alert"`. |

## 12. The "never show the scene" rule, applied visually

The app's promise is that a parent can decide about a scene without seeing it. The design enforces this at three levels: what is stored, what is drawn, and what the interface asks for.

### 12.1 Where an image may appear

| Place | Image | Treatment |
|---|---|---|
| Review side panel, one frame per range | Blurred thumbnail | `bo-thumb` full treatment (12.2); peek available to a parent (12.3) |
| Timeline strip | Blurred tiles | Blur 10px, scale 1.5, tinted and barred if flagged; no peek |
| Range rows, parents card, queue | **No image at all** | Category icon and words only |
| Library title cards | First keyframe | Blurred like any thumbnail until the scan has finished **and** no range touches that frame; then `bo-thumb--cleared` (sharp, no tint, no label). A poster never becomes sharper than the scan allows. |
| Kid mode | Title keyframes of Protected movies only | Same rule as the library; kid mode has no peek, no ranges, no timeline |
| Not yet scanned titles | Locked panel | `bo-thumb--locked`: flat `surface-3` panel with a lock, no image of any kind |

### 12.2 How a blurred thumbnail is drawn (`bo-thumb`)

1. **On disk** (PLAN section 4): 160px wide, `boxblur=10:1` applied at extraction; the clear frame is never written. The UI can therefore never show more detail than the file holds.
2. **Blur on screen**: `filter: blur(14px) saturate(.85)` on top (`--bo-blur-thumb`, `--bo-thumb-saturate`), image scaled 1.2 (`--bo-thumb-scale`) inside an `overflow: hidden` frame so the blurred edge never shows a halo. Displayed at 300 to 600px the 160px source is upscaled, which softens it further. Strip tiles use 10px (`--bo-blur-strip`) and scale 1.5.
3. **Category veil**: the category colour at 46% (light) or 42% (dark) over the whole picture (`--bo-cat-*-veil`), plus a bottom-up black gradient (74% to 0% over the lower 62%) that makes the label readable on any picture (white label contrast at least 7:1 at the label position). The veil colours are the category solids: nudity `#C2410C`, sex `#A21F7A`, implied `#1F6FB5`, kissing `#D9558D`, gore `#6B1218`, language `#5A7D2A`, other `#6B6558` in light; the dark theme uses its own solids at 42%.
4. **Marks**: a 32px `eye-off` glyph centred at 92% white with a soft shadow ("this is hidden on purpose"), and bottom-left the category icon plus its word in 13px bold white. The label never repeats the note and never contains anything about content.
5. Shape: 16:9, radius-md (12px). Library posters use the same blur at 2:3 where posters exist.

### 12.3 The peek interaction

A parent who wants a little more context holds the **Hold to peek** button (ghost, `eye` icon) in the side panel footer.

| Moment | What happens |
|---|---|
| Press and hold (mouse down, or Space or Enter held) | Within 120ms the CSS blur drops from 14px to 5px (`--bo-blur-peek`), saturation returns to 1, the veil fades to 35%, the centre glyph hides, the label stays; a `primary` ring appears around the button. Shapes and colours become recognisable; faces, bodies and detail do not, because the stored file is already boxblurred. |
| Release, blur, Escape, 8 seconds, window hidden, selection changes | Back to fully blurred in 120ms. There is no "stay revealed" toggle. |
| First peek, and again after 5 minutes without one | A modal asks for the PIN (section 7.5, 7.7) before the first reveal. Wrong PIN: the thumbnail does not change. |
| Kid mode | The Peek button does not exist. Not hidden, not disabled: it is not rendered. |
| Reduced motion | The change is instant, nothing else differs. |

Peek is never available on the strip, in the library or on any other surface.

### 12.4 Words are protected too

Notes are generated from templates ("Nudity detected in the picture; dialogue suggests intimacy.") and never quote dialogue or captions. Category words are the only content vocabulary on any screen: Nudity, Sex, Implied, Kissing, Gore, Language, Other (ES: Desnudez, Sexo, Insinuado, Besos, Gore, Lenguaje, Otro). Intensity is a number of dots and one of Mild, Moderate, Strong. Never write a plot summary, a character name next to a category, or a time-coded description.

## 13. Text expansion: designing for Spanish (MX) at +30%

Spanish runs about 20 to 35% longer than English ("Approve all scenes" 18 characters, "Aprobar todas las escenas" 25). Rules baked into the components and required of implementers:

1. No fixed-width text containers. Buttons are `min-height` plus padding, never `width`; labels wrap (`text-wrap: balance`) rather than truncate. Pills, chips, nav items and nudge buttons wrap too.
2. Never truncate with an ellipsis anything a parent needs to decide on (titles may wrap to two lines in tiles; file names wrap by character via `overflow-wrap: break-word`).
3. Rows that pair text with a control use `minmax(0, 1fr)` for the text and `auto` for the control, so the text yields first.
4. The segmented control gives each of the four options an equal quarter and lets labels wrap to two lines; Spanish "Moderado" and "Estricto" fit at 1024px in a 600px picker. A control that would need more than two lines is changed to a vertical list.
5. Headline sizes are balanced, so a longer Spanish headline breaks into two even lines instead of one long and one short.
6. `design-preview.html` shows the dark column in Spanish for this reason; every new component must be checked there in both languages and in kid mode.
7. Dates, durations and numbers: English `Oct 12, 2026`, `1 h 52 min`, `0.5 s`; Spanish MX `12 oct 2026`, `1 h 52 min`, `0.5 s` (Mexico uses the decimal point). 24-hour clock in the review timeline.
8. Never concatenate translated fragments. Use whole sentences with `{placeholders}` in `locales/*.json`.

## 14. Writing tone

### 14.1 Rules (both languages)

1. Say what happened, then what to do next. Every error ends with an action the person can take.
2. Talk to one person, kindly and plainly: "you" and "your" in English; informal "tú" in Spanish (never "usted", never "el usuario").
3. Words a parent already knows. Say "check" or "scan", "scene", "skip". Do not say analyse, algorithm, model, classifier, threshold, false positive, confidence (we say "certainty"), metadata, fingerprint, EDL (outside the TV page).
4. Calm, not alarming and not cute: no exclamation marks, no "Oops", no "Failed", "Invalid", "Error", "Warning" as words, no emoji, no jokes.
5. Honest about limits: never "safe", "100%", "guaranteed". Say "Protected" (we checked and applied your choices) and keep the detector's limits visible in Help ("We can miss things; you can mark them while you watch").
6. Never describe a scene (section 12.4).
7. Buttons start with a verb and name the result: "Approve all 12 scenes", not "OK" or "Yes". Cancel is "Cancel", the safe choice is named ("Keep it").
8. Sentence case everywhere. Uppercase only through CSS (overlines).
9. One idea per sentence; at most two sentences in a toast or error; no passive voice where a person acts.
10. Spanish (MX): infinitive for buttons ("Elegir archivos"), imperative for instructions ("Suelta tus películas aquí"); say "computadora", "video", "archivo", "película", "Presiona"; always inverted ¿ and ¡ (and the app uses almost no ¡); gender-neutral wording ("un adulto", "quien lo configura"); no regional slang.

### 14.2 English (US), ten examples

| # | Where | String |
|---|---|---|
| 1 | Button | Play |
| 2 | Button | Add a movie |
| 3 | Button | Approve all 12 scenes |
| 4 | Button (safe choice in a confirmation) | Keep it |
| 5 | Error | We could not open that file. Check that it is a video and try again. |
| 6 | Error (PIN) | That is not the PIN. Try again. |
| 7 | Error (scan) | The scan stopped, but your review is saved. Press Scan now to continue. |
| 8 | Empty state (library) | No movies yet. Drop a movie here and we will check it for you. It stays on this computer. |
| 9 | Empty state (review) | Nothing to review. Every scene in this movie has been decided. |
| 10 | Empty state (kid mode) | Nothing to watch yet. Ask a parent to get a movie ready. |

### 14.3 Español (MX), diez ejemplos

| # | Dónde | Texto |
|---|---|---|
| 1 | Botón | Ver |
| 2 | Botón | Agregar una película |
| 3 | Botón | Aprobar las 12 escenas |
| 4 | Botón (opción segura en una confirmación) | Conservarla |
| 5 | Error | No pudimos abrir ese archivo. Revisa que sea un video e inténtalo de nuevo. |
| 6 | Error (PIN) | Ese no es el PIN. Inténtalo de nuevo. |
| 7 | Error (análisis) | El análisis se detuvo, pero tu revisión está guardada. Presiona Analizar ahora para continuar. |
| 8 | Estado vacío (biblioteca) | Aún no hay películas. Suelta una película aquí y la revisaremos por ti. Se queda en esta computadora. |
| 9 | Estado vacío (revisión) | No hay nada por revisar. Ya se decidieron todas las escenas de esta película. |
| 10 | Estado vacío (modo niños) | Todavía no hay nada para ver. Pídele a un adulto que prepare una película. |

## 15. Accessibility checklist (acceptance for every screen)

1. Every text pair is in the tables of section 3 or is a documented combination of them; no hex values outside `tokens.css`.
2. Everything works with the keyboard alone; Tab order follows reading order; focus ring always visible (5.5); no focus trap except in modals.
3. Targets at least 44px (64px in kid mode), at least 8px apart when smaller.
4. No information by colour alone: statuses have icon plus words, categories have icon, pattern and words, switches have On or Off words, errors have an icon and a sentence.
5. Respect `prefers-color-scheme`, `prefers-reduced-motion`, and Windows high contrast (`forced-colors`).
6. Zoom: the layout works at 200% without horizontal scroll at 1024px wide (rem units throughout).
7. Screen readers: landmarks (`nav`, `main`, `aside`), `aria-current`, `aria-pressed`, `aria-label` on icon-only buttons, `role="slider"` with `aria-valuetext` on handles, `role="status"` on toasts and the PIN message, `<progress>` with an accessible name.
8. Both languages checked in `design-preview.html`, plus kid mode.
9. Nothing sharper than section 12 allows ever reaches a screen.
