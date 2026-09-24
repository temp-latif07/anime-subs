# Samsung Tizen TV: how subtitles actually get rendered

## Why this matters

The addon converts ASS subtitles to WebVTT (`src/ffmpeg/assUtils.ts`) and serves
them to Stremio. The user watches on a Samsung TV running Tizen OS. Several
past bugs (dashes synthesized from `<font color>` mismatches, `line:auto`
position drift) were only ever confirmed on this specific TV, not derivable
from spec-reading alone — future formatting/positioning work should account
for what this player path can actually render, not just what WebVTT allows.

## Finding: which renderer is actually drawing the subtitles

The user's Stremio client on this TV is almost certainly the **official
Stremio Tizen app** (Stremio ships one in the Samsung app store). That app
plays video through Samsung's native **AVPlay** engine, not a browser
`<video>+<track>` element.

Samsung's own AVPlay documentation lists native subtitle support as **SAMI,
SMPTE-TT, and DFXP only** — no WebVTT, no ASS/SSA:
https://developer.samsung.com/smarttv/develop/guides/multimedia/subtitles.html

Since WebVTT subtitles from this addon do render on the TV (imperfectly), the
rendering must be happening in **Stremio's own app-level WebVTT overlay**,
not AVPlay's native subtitle engine. This is corroborated by a Stremio bug
report where a user requests a proper ASS/SSA renderer (SubtitlesOctopus,
WASM/canvas-based) specifically because Stremio's current renderer drops ASS
styling and positioning entirely:
https://github.com/Stremio/stremio-bugs/issues/2459

Related reports of subtitle display issues on this platform:
- https://github.com/Stremio/stremio-bugs/issues/2424
- https://github.com/Stremio/stremio-bugs/issues/1204

Stremio's Tizen-app announcement, confirming the app (and therefore this
player path) exists:
https://blog.stremio.com/stremio-is-now-available-in-the-samsung-tv-app-store/

## What this explains

- `<font color>` never rendering: consistent with Stremio's own overlay
  parser not implementing `<font>`, not a Tizen/AVPlay limitation.
- `line:auto` position drift: consistent with an incomplete/non-spec-exact
  WebVTT cue-positioning implementation in Stremio's overlay, rather than a
  browser or AVPlay quirk.

## Open question (unresolved, no public documentation either way)

Whether Stremio's Tizen WebVTT overlay honors combined `position:X%
line:Y% align:left|center|right` cue settings (added for `\pos`-based sign
positioning) is **not confirmed by any public source**. Neither Samsung's
docs nor Stremio's issue tracker say anything specific about `position:`/
`align:` handling — only that ASS-level styling/positioning is known broken.

## Recommendation for future work

1. Treat any new WebVTT cue-setting feature (positioning, alignment, markup)
   built for this TV as **unverified until manually confirmed on-device**.
   Worst case for an unsupported setting appears to be silent ignoring (as
   with `<font>`), not breakage — so it's safe to build ahead of
   verification, but don't call it "done" until checked on the TV.
2. Don't invest in more advanced ASS positioning (`\move`, `\clip`, `\org`)
   until basic `position:`/`line:`/`align:` is confirmed to render at all —
   there's no evidence yet that Stremio's Tizen overlay goes beyond basic
   `line:` positioning.
3. If subtitle fidelity on this TV becomes a recurring blocker, the more
   durable fix is upstream: pushing/tracking Stremio to adopt a real ASS
   renderer (JS/WASM, e.g. SubtitlesOctopus) as requested in
   https://github.com/Stremio/stremio-bugs/issues/2459, rather than
   continuing to work around gaps in Stremio's own WebVTT overlay from this
   addon's side.
