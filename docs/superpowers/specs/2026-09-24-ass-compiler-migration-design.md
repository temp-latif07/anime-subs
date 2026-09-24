# ASS→VTT pipeline: migrate to ass-compiler

## Context

`src/ffmpeg/assUtils.ts` converts ASS subtitle text to WebVTT with a hand-rolled,
line-by-line regex parser: manual `[Events]`/`[V4+ Styles]` section detection,
manual comma-splitting of `Dialogue:` lines, regex-based `\an`/color/formatting
tag extraction. This fragility caused two real bugs fixed in commit `c006dc5`:
a false "dual speaker" dash heuristic based on `<font color>` mismatches, and
missing explicit `line:` positions causing WebVTT position drift on playback.
Both were patched with unit tests (264 passing), but the underlying regex
approach remains fragile for anything not already covered by a test.

`ass-compiler` (npm, actively maintained, last published 2025-11-09) parses
ASS into a structured `CompiledASS` object: `dialogues[]` with resolved
`alignment` (1-9, style default + inline `\an` override already merged),
optional `pos: {x, y}` (resolved `\pos` coordinates), and per-span
`slices[].fragments[].tag` (bold/italic/underline/etc., properly scoped
instead of "does this line contain a tag anywhere"). This removes the classes
of bug regex parsing produces.

## Scope

**In scope:**
- Rewrite `convertAssToVtt()` in `src/ffmpeg/assUtils.ts` to parse via
  `ass-compiler`'s `compile()` instead of regex.
- Add `\pos`-based cue positioning for signs (new capability — the current
  parser has no `\pos` support at all).
- Drop color/`<font>` handling entirely (dead weight — the target TV doesn't
  render `<font>` and it was the direct cause of the dual-dash bug).
- Drop song/karaoke/OP-ED filtering entirely (`SONG_STYLE_REGEX`,
  `KARAOKE_TAG_REGEX` and their filtering block) — user's explicit
  scope-narrowing, not needed.
- Add `ass-compiler` as a runtime dependency.

**Out of scope:**
- `src/ffmpeg/vttUtils.ts` — normalizes already-VTT/SRT text from ffmpeg's own
  transcode path. `ass-compiler` doesn't help there (no ASS structure to
  parse). No functional changes; only confirm it keeps working against the
  same exported names (`JAPANESE_CHAR_REGEX` from `assUtils.ts`,
  `resolveLinePosition` from `subtitleFormatting.ts`).
- Using `dialogue.layer` to separate/filter signs vs. dialogue — unverified
  hypothesis, no real sample available to test against on this dev machine.
  Not addressed by this migration.
- Any refactor of `vttUtils.ts`'s own regex-based timing/tag parsing — it has
  no analogous bug reports and is not part of this migration's motivation.

**Preserved behavior (must not regress):**
- Dash pass-through only — a cue gets a leading `-` only if the source ASS
  line already has one; never synthesized.
- Japanese-line filtering scoped strictly to `targetLang === 'eng'` (dual-sub
  scenario), applied per rendered line.
- For dialogue without `\pos`: alignment groups 7-9 (top) → `line:10%`;
  everything else (1-6) → `line:90%,end`. Byte-identical output to current
  behavior for the common (no-`pos`) case.

## Design

### Data flow (`assUtils.ts`)

```
convertAssToVtt(ass, targetLang)
  -> compile(ass, { defaultInfo: { PlayResX: 384, PlayResY: 288 } })
       // 384x288 matches ass-compiler's own low-res fallback convention;
       // only used if [Script Info] omits PlayResX/Y.
  -> for each dialogue in compiledASS.dialogues:
       - build text: join slices[].fragments[].text per line, wrapping
         <i>/<b>/<u> from resolved tag.i/b/u (no color)
       - drop Japanese-only lines when targetLang === 'eng'
       - skip dialogue if all lines dropped (empty cue)
       - dash: pass through whatever the source line starts with, unchanged
       - compute settings via resolvePosition(alignment, pos, width, height)
  -> sort by start time
  -> serialize to WEBVTT text (unchanged serialization logic)
```

Notes:
- Drawing commands (`\p1`...`\p0`) need no explicit stripping — ass-compiler
  returns them as a separate `drawing` field on the fragment, never merged
  into `.text`, so simply not reading `.drawing` excludes them.
- `formatAssTime`'s manual `H:MM:SS.mmm` string parsing is replaced by
  formatting `dialogue.start`/`end` (already numeric seconds) directly.
- No song/karaoke filtering step exists in the new flow at all.

### Position mapping (`subtitleFormatting.ts`)

New function alongside the existing `resolveLinePosition`:

```ts
export function resolvePosition(
  alignment: number,
  pos: { x: number; y: number } | undefined,
  width: number,
  height: number,
): string
```

- Horizontal group from `alignment`: `(alignment - 1) % 3` → `0`=left,
  `1`=center, `2`=right.
- Vertical group from `alignment`: `7-9`=top, `1-6`=bottom (matches current
  `isTop` boolean exactly — no new "middle" bucket, since true middle
  alignment without `\pos` is rare for anime subs and mid-bucket dialogue is
  already served correctly by the bottom-anchored default).
- **No `pos`**: unchanged from today — top → `line:10%`, else →
  `line:90%,end`. No horizontal `position`/`align` added (WebVTT's default
  centering already matches current output).
- **With `pos`** (signs): `position:{round(pos.x / width * 100)}%,line:{round(pos.y / height * 100)}%` plus `align:{left|center|right}` from the horizontal
  group. New capability — old parser never read `\pos`.

`resolveLinePosition` stays as-is for `vttUtils.ts`, which never has `pos`
data (VTT has no `\pos` equivalent).

### Removed code

- `SONG_STYLE_REGEX`, `KARAOKE_TAG_REGEX`, and their filtering block.
- `assColorToHex`, the `styleColors` map, all `<font>` emission.
- Manual `\p1`...`\p0` drawing-command stripping regex.
- `formatAssTime`.
- All manual `[Events]`/`[V4+ Styles]`/`Format:`/`Dialogue:` line parsing.

### Dependency

Add `ass-compiler` (`^0.1.16`) to `package.json` `dependencies`. Verified via
its published type defs (`types/index.d.ts`, `types/tags.d.ts`): `compile()`
returns `{ info, width, height, collisions, wrapStyle, styles, dialogues }`;
each `Dialogue` has `layer, start, end, style, name, margin, alignment, q,
slices, pos?, org?, move?, fade?, clip?`; `slices[].fragments[]` has
`{ tag: CompiledTag, text, drawing? }`.

## Testing

- Update `test/ffmpeg/assUtils.test.ts`: remove/rewrite tests asserting
  `<font color=...>` output or song/karaoke-drop behavior (both behaviors are
  removed). Dash and top/bottom position tests should need no changes — same
  expected output.
- Add tests for: `\pos`-based signs (percent mapping across all three
  horizontal groups), missing `PlayResX`/`PlayResY` (fallback to 384x288),
  bold/italic/underline via resolved tags instead of regex, multi-fragment
  lines (e.g. `\r` style resets producing multiple fragments with no color
  difference).
- `vttUtils.test.ts`: no expected changes; run to confirm no regression from
  the `assUtils.ts` rewrite (shared imports only).
- Full suite (`npm test` or equivalent) must pass before this is considered
  done. TV verification (position fix from `c006dc5`, plus this migration)
  remains the user's manual follow-up, as before.

## Non-goals / explicitly deferred

- `dialogue.layer`-based sign/dialogue separation (flicker hypothesis).
- Any change to `vttUtils.ts` parsing logic itself.
- Broader positioning features (`\move`, `\org`, `\clip`, `\fade`) — only
  static `\pos` + `alignment` are read.
