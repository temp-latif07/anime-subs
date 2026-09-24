# ASS-compiler Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/ffmpeg/assUtils.ts`'s hand-rolled regex ASS parser with the `ass-compiler` library, dropping color/font handling and song/karaoke filtering, and adding `\pos`-based cue positioning for signs.

**Architecture:** `convertAssToVtt()` keeps its existing signature (`(ass: string, targetLang?: string) => string`) and file location. Internally it calls `ass-compiler`'s `compile()` to get structured `Dialogue[]` objects (resolved `alignment`, optional `pos`, per-fragment `tag.b/i/u`), builds cue text per dialogue from those fragments, and computes cue settings via a new `resolvePosition()` helper in `subtitleFormatting.ts`. `vttUtils.ts` is untouched — it has no ASS structure to gain from the library and keeps its own regex-based normalizer for already-VTT/SRT input.

**Tech Stack:** TypeScript, Node.js, Vitest, `ass-compiler` (new dependency, `^0.1.16`).

**Spec:** `docs/superpowers/specs/2026-09-24-ass-compiler-migration-design.md`

## Global Constraints

- Add `ass-compiler` pinned to `^0.1.16` in `package.json` `dependencies`.
- Dash handling stays pass-through only — never synthesize a `-`, only preserve one the source line already has.
- Japanese-line filtering stays scoped to `targetLang === 'eng'` only.
- Color/`<font>` handling is removed entirely — no `<font>` in any output, no color extraction from styles or inline tags.
- Song/karaoke/OP-ED filtering is removed entirely — no dialogue line is dropped based on style name or `\k` tags.
- Dialogue without `\pos`: alignment 7-9 → `line:10%`; alignment 1-6 → `line:90%,end`. This must match byte-for-byte what the old parser produced for the no-`pos` case.
- `dialogue.layer` is not read or used anywhere in this migration.
- `vttUtils.ts` is not modified. Its imports of `JAPANESE_CHAR_REGEX` (from `assUtils.ts`) and `resolveLinePosition` (from `subtitleFormatting.ts`) must keep resolving to the same names after the rewrite.

## Review Focus

- `\pos`-based signs must map to the correct `position%`/`line%`/`align` for all three horizontal alignment groups (left/center/right), not just the common center case — covered by Task 2's `maps \pos-based signs...` test.
- Malformed/non-ASS input must not throw and must return `WEBVTT\n\n`, matching the old regex parser's tolerance — covered by Task 2's `returns an empty VTT document...` test.
- Missing or explicit `PlayResX`/`PlayResY` must both resolve correctly (default fallback vs. reading the file's own value) rather than producing `NaN%` or `null` settings — covered by Task 2's two PlayRes tests.
- Dialogue lines with zero or negative duration are silently dropped by `ass-compiler` itself (new inherited behavior, the old regex parser had no such check) — covered by Task 2's `drops dialogue lines with zero or negative duration` test.
- A mid-line style reset (`\r`) must not drop or duplicate text from either side of the reset — covered by Task 2's `concatenates text across a mid-line style reset` test.

---

## Task 1: `resolvePosition` helper in `subtitleFormatting.ts`

**Files:**
- Modify: `src/ffmpeg/subtitleFormatting.ts`
- Test: `test/ffmpeg/subtitleFormatting.test.ts` (new file)

**Interfaces:**
- Consumes: nothing (pure function, no dependencies on other tasks).
- Produces: `resolvePosition(alignment: number, pos: { x: number; y: number } | undefined, width: number | null, height: number | null): string`, exported from `src/ffmpeg/subtitleFormatting.ts`, alongside the existing `resolveLinePosition(isTop: boolean): string`. Task 2 imports and calls `resolvePosition`.

- [ ] **Step 1: Write the failing test file**

Create `test/ffmpeg/subtitleFormatting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveLinePosition, resolvePosition } from '../../src/ffmpeg/subtitleFormatting.js';

describe('resolveLinePosition', () => {
  it('returns line:10% for top-aligned cues', () => {
    expect(resolveLinePosition(true)).toBe('line:10%');
  });

  it('returns line:90%,end for non-top-aligned cues', () => {
    expect(resolveLinePosition(false)).toBe('line:90%,end');
  });
});

describe('resolvePosition', () => {
  it('falls back to resolveLinePosition when pos is absent, for top alignment (7-9)', () => {
    expect(resolvePosition(7, undefined, 384, 288)).toBe('line:10%');
    expect(resolvePosition(8, undefined, 384, 288)).toBe('line:10%');
    expect(resolvePosition(9, undefined, 384, 288)).toBe('line:10%');
  });

  it('falls back to resolveLinePosition when pos is absent, for bottom/middle alignment (1-6)', () => {
    expect(resolvePosition(1, undefined, 384, 288)).toBe('line:90%,end');
    expect(resolvePosition(2, undefined, 384, 288)).toBe('line:90%,end');
    expect(resolvePosition(6, undefined, 384, 288)).toBe('line:90%,end');
  });

  it('maps left/center/right alignment groups to percent position, line, and align settings when pos is present', () => {
    expect(resolvePosition(7, { x: 0, y: 0 }, 200, 100)).toBe('position:0% line:0% align:left');
    expect(resolvePosition(8, { x: 100, y: 50 }, 200, 100)).toBe('position:50% line:50% align:center');
    expect(resolvePosition(9, { x: 200, y: 100 }, 200, 100)).toBe('position:100% line:100% align:right');
  });

  it('falls back to resolveLinePosition when width or height is falsy even if pos is present', () => {
    expect(resolvePosition(2, { x: 100, y: 50 }, null, 288)).toBe('line:90%,end');
    expect(resolvePosition(2, { x: 100, y: 50 }, 384, 0)).toBe('line:90%,end');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ffmpeg/subtitleFormatting.test.ts`
Expected: FAIL — `resolvePosition` is not exported from `subtitleFormatting.ts`.

- [ ] **Step 3: Implement `resolvePosition`**

Replace the full contents of `src/ffmpeg/subtitleFormatting.ts` with:

```ts
// Line-position logic shared by the ASS->VTT converter and the WebVTT normalizer.

// ",end" anchors the bottom edge at 90% so multi-line cues grow upward instead of overflowing the frame.
export function resolveLinePosition(isTop: boolean): string {
  return isTop ? 'line:10%' : 'line:90%,end';
}

const HORIZONTAL_ALIGN = ['left', 'center', 'right'] as const;

// Maps a resolved ASS numpad alignment (1-9) plus optional \pos coordinates to WebVTT cue
// settings. Dialogue without \pos keeps the top/bottom-only convention (resolveLinePosition);
// \pos-carrying signs get precise position/line/align settings derived from the source
// resolution (compiled.width/height from ass-compiler, which falls back to a default if the
// ASS file's own [Script Info] omits PlayResX/PlayResY).
export function resolvePosition(
  alignment: number,
  pos: { x: number; y: number } | undefined,
  width: number | null,
  height: number | null,
): string {
  const isTop = alignment >= 7 && alignment <= 9;
  if (!pos || !width || !height) {
    return resolveLinePosition(isTop);
  }
  const horizontal = HORIZONTAL_ALIGN[(alignment - 1) % 3];
  const x = Math.round((pos.x / width) * 100);
  const y = Math.round((pos.y / height) * 100);
  return `position:${x}% line:${y}% align:${horizontal}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/ffmpeg/subtitleFormatting.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/subtitleFormatting.ts test/ffmpeg/subtitleFormatting.test.ts
git commit -m "feat(subtitles): add pos-aware resolvePosition cue-position helper"
```

---

## Task 2: Rewrite `assUtils.ts` on `ass-compiler`

**Files:**
- Modify: `src/ffmpeg/assUtils.ts`
- Modify: `test/ffmpeg/assUtils.test.ts`
- Modify: `package.json` (add dependency)

**Interfaces:**
- Consumes: `resolveLinePosition`, `resolvePosition` from `src/ffmpeg/subtitleFormatting.js` (Task 1). `compile` from `ass-compiler`.
- Produces: `convertAssToVtt(ass: string, targetLang?: string): string` (signature unchanged, consumed by `src/ffmpeg/extract.ts` — not modified, no changes needed there). `JAPANESE_CHAR_REGEX` stays exported from `src/ffmpeg/assUtils.ts` (consumed by `vttUtils.ts`, unchanged). `assColorToHex` is deleted — confirmed unused outside `assUtils.ts`/its own test.

- [ ] **Step 1: Install the dependency**

```bash
npm install ass-compiler@^0.1.16
```

Verify: `package.json` now lists `"ass-compiler": "^0.1.16"` under `dependencies`.

- [ ] **Step 2: Replace `test/ffmpeg/assUtils.test.ts` with the updated + new test suite**

Replace the full contents of `test/ffmpeg/assUtils.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { convertAssToVtt } from '../../src/ffmpeg/assUtils.js';

describe('convertAssToVtt', () => {
  it('converts basic dialogue with normalized timestamps and sequential cue numbers', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:23.45,0:01:25.10,Default,,0,0,0,,Hello world!
Dialogue: 0,0:01:26.00,0:01:28.00,Default,,0,0,0,,Second line.
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toBe(
      'WEBVTT\n\n' +
      '1\n00:01:23.450 --> 00:01:25.100 line:90%,end\nHello world!\n\n' +
      '2\n00:01:26.000 --> 00:01:28.000 line:90%,end\nSecond line.\n'
    );
  });

  it('translates top-alignment \\an8 / \\an7 / \\an9 to line:10% cue position', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Sign on top of screen
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Bottom dialogue
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000 line:10%\nSign on top of screen');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000 line:90%,end\nBottom dialogue');
  });

  it('preserves italics and bold tags cleanly', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Internal thought{\\i0} and {\\b1}shouting{\\b0}
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('<i>Internal thought</i> and <b>shouting</b>');
  });

  it('wraps underlined text in <u> tags', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\u1}Underlined{\\u0} text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('<u>Underlined</u> text');
  });

  it('does not add speaker dashes based on differing colors alone', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Are you ready?\\N{\\c&H00FF00&}Always!
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
    expect(vtt).toContain('Are you ready?\nAlways!');
  });

  it('does not add speaker dashes when only one of two wrapped lines has a highlighted color', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Highlighted word{\\c}\\NPlain second line
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
    expect(vtt).toContain('Highlighted word\nPlain second line');
  });

  it('preserves a dash the source subtitle already wrote on a line', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,- Are you ready?\\N- Always!
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('- Are you ready?\n- Always!');
  });

  it('does not synthesize a dash on a second line just because the first line has one', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,- Wait!\\NI told you
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('- Wait!\nI told you');
  });

  it('does not add dashes when a style color and an inline emphasis color both land on the same cue', () => {
    const ass = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CharacterCyan,Arial,20,&H00FFFF00,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,CharacterCyan,,0,0,0,,Some {\\c&H00FFFF&}word{\\c} here\\NPlain second line
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
  });

  it('extracts \\pos coordinates into position/line/align cue settings and strips other residual tags cleanly', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(192,200)\\fad(100,100)\\k50\\blur1.5}Clean spoken text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000 position:50% line:69% align:center\nClean spoken text');
    expect(vtt).not.toContain('\\pos');
    expect(vtt).not.toContain('\\fad');
    expect(vtt).not.toContain('{');
  });

  it('ignores drawing commands (\\p1)', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Actual text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('m 0 0');
    expect(vtt).toContain('Actual text');
  });

  it('filters out Japanese script lines from dual-language cues and drops pure Japanese cues', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,こんにちは\\NHello there!
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,おはようございます
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,I am doing well.
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Hello there!');
    expect(vtt).not.toContain('こんにちは');
    expect(vtt).not.toContain('おはようございます');
    expect(vtt).toContain('I am doing well.');
    const cues = vtt.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(2);
  });

  it('does not treat fullwidth Latin punctuation as Japanese', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Wait！ What was that？
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Wait！ What was that？');
  });

  it('maps \\pos-based signs to percent position/line/align across left, center, and right alignment', () => {
    const ass = `[Script Info]
PlayResX: 200
PlayResY: 100

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an7\\pos(0,0)}Top left sign
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\an8\\pos(100,50)}Top center sign
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\an9\\pos(200,100)}Top right sign
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000 position:0% line:0% align:left\nTop left sign');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000 position:50% line:50% align:center\nTop center sign');
    expect(vtt).toContain('00:00:07.000 --> 00:00:09.000 position:100% line:100% align:right\nTop right sign');
  });

  it('reads PlayResX/PlayResY from [Script Info] when present', () => {
    const ass = `[Script Info]
PlayResX: 1280
PlayResY: 720

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(640,360)}Centered sign
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('position:50% line:50% align:center');
  });

  it('falls back to 384x288 when [Script Info] omits PlayResX/PlayResY', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(192,144)}Centered sign
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('position:50% line:50% align:center');
  });

  it('returns an empty VTT document instead of throwing for malformed non-ASS input', () => {
    const garbage = 'this is not ass content at all\n{{{';
    expect(() => convertAssToVtt(garbage)).not.toThrow();
    expect(convertAssToVtt(garbage)).toBe('WEBVTT\n\n');
  });

  it('drops dialogue lines with zero or negative duration', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:03.00,Default,,0,0,0,,Reversed duration
Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,Zero duration
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Valid cue
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('Reversed duration');
    expect(vtt).not.toContain('Zero duration');
    expect(vtt).toContain('Valid cue');
    const cues = vtt.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(1);
  });

  it('concatenates text across a mid-line style reset (\\r) into a single cue', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,First part {\\r}Second part
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('First part Second part');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/ffmpeg/assUtils.test.ts`
Expected: FAIL — current `convertAssToVtt` still emits `<font>` tags, still filters song styles, and has no `\pos` support, so many assertions above will not match.

- [ ] **Step 4: Replace `src/ffmpeg/assUtils.ts`**

Replace the full contents of `src/ffmpeg/assUtils.ts` with:

```ts
import { compile } from 'ass-compiler';
import { resolvePosition } from './subtitleFormatting.js';

export const JAPANESE_CHAR_REGEX = /[぀-ゟ゠-ヿ一-鿿㐀-䶿]/;

function formatVttTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

interface FragmentTag {
  b?: 0 | 1;
  i?: 0 | 1;
  u?: 0 | 1;
}

function renderFragmentText(tag: FragmentTag, rawText: string): string {
  let text = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  if (tag.b) text = `<b>${text}</b>`;
  if (tag.i) text = `<i>${text}</i>`;
  if (tag.u) text = `<u>${text}</u>`;
  return text;
}

interface CompiledDialogue {
  start: number;
  end: number;
  alignment: number;
  pos?: { x: number; y: number };
  slices: { fragments: { tag: FragmentTag; text: string }[] }[];
}

function buildCueText(dialogue: CompiledDialogue, targetLang?: string): string | null {
  let combined = '';
  for (const slice of dialogue.slices) {
    for (const fragment of slice.fragments) {
      combined += renderFragmentText(fragment.tag, fragment.text);
    }
  }
  const lines = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => (targetLang === 'eng' ? !JAPANESE_CHAR_REGEX.test(line) : true));
  if (lines.length === 0) return null;
  return lines.join('\n');
}

export function convertAssToVtt(ass: string, targetLang?: string): string {
  if (!ass || typeof ass !== 'string') return 'WEBVTT\n\n';

  let compiled;
  try {
    compiled = compile(ass, { defaultInfo: { PlayResX: 384, PlayResY: 288 } });
  } catch {
    return 'WEBVTT\n\n';
  }

  const cuesContent: string[] = [];
  let index = 1;
  for (const dialogue of compiled.dialogues as CompiledDialogue[]) {
    const text = buildCueText(dialogue, targetLang);
    if (!text) continue;
    const settings = resolvePosition(dialogue.alignment, dialogue.pos, compiled.width, compiled.height);
    const start = formatVttTime(dialogue.start);
    const end = formatVttTime(dialogue.end);
    cuesContent.push(`${index++}\n${start} --> ${end} ${settings}\n${text}`);
  }

  if (cuesContent.length === 0) return 'WEBVTT\n\n';
  return `WEBVTT\n\n${cuesContent.join('\n\n')}\n`;
}
```

Note: `compiled.dialogues` is already sorted by start time (then end time) by `ass-compiler` itself, so no manual sort is needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/ffmpeg/assUtils.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Run the full test suite and typecheck**

Run: `npm test`
Expected: PASS — all suites green, including `test/ffmpeg/vttUtils.test.ts` (unchanged, confirms its imports from the rewritten `assUtils.ts`/`subtitleFormatting.ts` still resolve) and `test/ffmpeg/extract.test.ts` (confirms `extractSubtitleToVtt`/`convertToVtt` still work with the new `convertAssToVtt`).

Run: `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/ffmpeg/assUtils.ts test/ffmpeg/assUtils.test.ts
git commit -m "feat(subtitles): migrate ASS parsing to ass-compiler, drop color/song filtering"
```

---

## Post-plan note (not a task — informational)

Cache entries written before this migration have old `<font>`-tagged or song-filtered VTT text baked into stored files on disk and won't self-heal (re-normalization on read can't distinguish baked-in old output from freshly-generated output). Clearing `$DATA_DIR/cache.db` rows and `$DATA_DIR/subtitles/*.vtt` remains the user's call, same as after commit `c006dc5` — not part of this plan.
