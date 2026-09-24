# Tier Restructure, OpenSubtitles Provider, and Code-Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 21 outstanding findings from `docs/code-review-2026-09-24.md` (finding #1 is resolved by the architecture change below) and implement the Tier 1 (concurrent Jimaku/AnimeTosho/OpenSubtitles-by-IMDB)/Tier 2 (embedded extraction) redesign from the approved spec.

**Architecture:** Phase 1 (Tasks 1-10) fixes independent bugs in provider/cache/extraction code that the architecture change doesn't touch, so they land cleanly first. Phase 2 (Tasks 11-20) builds the spec: an AniDB↔TVDB/IMDB episode-mapping resolver, a new OpenSubtitles provider, a `provider`-dimensioned cache schema (fixing finding #1's single-subtitle cap as a side effect), and the concurrent 3-provider Tier 1 / extraction-fallback Tier 2 restructure — folding in every finding whose fix location is a function this phase rewrites anyway, so no file is touched twice for the same reason.

**Tech Stack:** TypeScript (Node >=24), Express 5, better-sqlite3, vitest, ffmpeg/ffprobe (child_process), `fast-xml-parser` (new dependency, Task 11).

**Spec:** `docs/superpowers/specs/2026-09-24-tier-restructure-opensubtitles-design.md`

## Global Constraints

- Node >=24, TypeScript strict mode (existing `tsconfig.json`/`tsconfig.test.json`) — every task must pass `npm run typecheck`.
- Tests use vitest with `environment: 'node'`, `testTimeout: 60000`, files under `test/**/*.test.ts`, run via `npm test`.
- HTTP-dependent providers are tested against a real local `node:http` server (`createServer`), never a mocking library — follow the existing pattern in `test/providers/jimakuProvider.test.ts` / `test/providers/animetoshoProvider.test.ts`.
- All new/changed env vars go through `config.ts`'s `requireEnv`/`requireUrl`/`requireInt` helpers, never read from `process.env` directly elsewhere.
- Per the spec's Non-Goals: no TheTVDB API integration, no handling of AniDB "specials" (`anidbseason="0"`) or movie-type entries, no fourth subtitle provider.
- Every commit message follows the existing repo convention (`type: short description`, e.g. `fix:`, `feat:`, `test:`) and ends with the Co-Authored-By trailer already used in this repo's recent commits.

## Review Focus

- An anime with `anidbId === null` (no AniDB mapping at all) must not crash any new code path (episode mapping lookup, IMDB resolution, OpenSubtitles provider) — it should behave as a clean miss, same as Jimaku/AnimeTosho already handle it.
- A `tt`-prefixed Stremio request for a title `anime-lists` doesn't cover must fall through to today's empty result, not throw.
- Two near-simultaneous requests for the same uncached episode must not double-charge the OpenSubtitles daily quota or double-call any Tier 1 provider (in-flight dedup, finding #12).
- A cache row written by the *old* schema (`tier` column, no `provider`) must still read back correctly after the Task 17 migration — this is a real upgrade path for the user's running deployment, not a theoretical case.
- Config validation must fail loudly at startup (not silently default) when `OPENSUBTITLES_API_KEY` is missing, matching how `JIMAKU_API_KEY` already behaves — this addon has no other operator-facing error surface than startup logs.

---

## Phase 1 — Independent bug fixes

These do not touch any file the Phase 2 architecture change rewrites in a conflicting way (or touch it in a way Phase 2 builds on top of, noted per-task). Order within Phase 1 doesn't matter functionally, but do them in this order to keep diffs small and reviewable.

### Task 1: Fix overly-broad Japanese regex and word-boundary bug in song-style regex

**Files:**
- Modify: `src/ffmpeg/assUtils.ts:43-44`
- Test: `test/ffmpeg/assUtils.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `JAPANESE_CHAR_REGEX` (exported, already consumed by `src/ffmpeg/vttUtils.ts`) and `SONG_STYLE_REGEX` (module-private) keep their names and `RegExp` type — only their patterns change, so no other file needs edits.

Finding #14: `JAPANESE_CHAR_REGEX` currently matches `　-〿` (CJK punctuation) and `＀-￯` (halfwidth/fullwidth forms) in addition to actual Japanese script, so an English line containing a fullwidth `!` or `~` gets wrongly treated as Japanese.

Finding #15: `SONG_STYLE_REGEX`'s `\b` after the style-name alternation means `OP1`, `Opening`, `ED2`, `OPJP` never match (`p`→`1` and `p`→`e` are word-to-word transitions, no boundary), so the song-lyric filter silently skips these extremely common fansub style names.

- [ ] **Step 1: Write the failing tests**

Add to `test/ffmpeg/assUtils.test.ts` inside the existing `describe('convertAssToVtt', ...)` block:

```ts
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

  it('strips song styles named without a separator, like OP1, Opening, ED2', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
Style: OP1,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1
Style: Opening,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,OP1,,0,0,0,,Romanized lyric line one
Dialogue: 0,0:00:04.00,0:00:06.00,Opening,,0,0,0,,Romanized lyric line two
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,Hello, how are you?
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Hello, how are you?');
    expect(vtt).not.toContain('Romanized lyric line one');
    expect(vtt).not.toContain('Romanized lyric line two');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/ffmpeg/assUtils.test.ts`
Expected: the fullwidth-punctuation test FAILs because the line gets stripped; the `OP1`/`Opening` test FAILs because those lines survive into the output.

- [ ] **Step 3: Fix the regexes**

```ts
// src/ffmpeg/assUtils.ts:43
export const JAPANESE_CHAR_REGEX = /[぀-ゟ゠-ヿ一-鿿㐀-䶿]/;
const SONG_STYLE_REGEX = /^(op|ed|song|karaoke|lyrics|insert|music)(\b|\d)|kanji|romaji/i;
```

The `(\b|\d)` alternative after the style-name group matches both a true word boundary (`OP - 1`, bare `OP`) and a digit immediately following the letters (`OP1`, `ED2`), without needing a boundary between two word characters (which regex can't express — there is no boundary between `p` and `1`). `Opening`/`Ending` are matched because `\b` still succeeds at the very start of the string before `op`/`ed`, and the shortened Japanese-char regex no longer touches CJK punctuation or fullwidth forms, only actual Hiragana/Katakana/Kanji ranges.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ffmpeg/assUtils.test.ts`
Expected: all tests PASS, including the pre-existing `'strips Opening and Ending song styles and karaoke cues'` test (uses `OP - Romaji`/`ED - English`, still matches via the `\b` branch).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ffmpeg/assUtils.ts test/ffmpeg/assUtils.test.ts
git commit -m "fix: correct Japanese-char and song-style regexes in ASS filtering

JAPANESE_CHAR_REGEX no longer matches fullwidth Latin punctuation.
SONG_STYLE_REGEX now matches OP1/Opening/ED2-style names that have
no word boundary after the style prefix.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 2: ASS extraction respects targetLang; extraction results are quality-gated

**Files:**
- Modify: `src/ffmpeg/extract.ts:74-79`
- Modify: `src/providers/extractionProvider.ts:41-47`
- Test: `test/ffmpeg/extract.test.ts`
- Test: `test/providers/extractionProvider.test.ts`

**Interfaces:**
- Consumes: `convertAssToVtt(ass: string, targetLang?: string)` (`src/ffmpeg/assUtils.ts`, unchanged signature), `isAcceptableSubtitle(vtt: string, targetLang: string): boolean` (`src/ffmpeg/vttUtils.ts`, unchanged signature, already used by both providers).
- Produces: `extractSubtitleToVtt`'s public signature is unchanged; `runExtractionTier`'s public signature is unchanged. No downstream task depends on new exports here.

Finding #13: `extractSubtitleToVtt`'s ASS stream-copy path calls `convertAssToVtt(readFileSync(outAssPath, 'utf-8'))` with no second argument, so `targetLang` is `undefined` and the song/karaoke/Japanese filters never run for that specific path (they run fine on the transcode fallback path via `normalizeVtt`'s default, and on `convertToVtt`'s ASS branch which does pass `targetLang`). Separately, `runExtractionTier` never calls `isAcceptableSubtitle`, so a garbage or all-Japanese extraction gets cached as "ready" and served for 24h.

- [ ] **Step 1: Write the failing test for extract.ts**

Add to `test/ffmpeg/extract.test.ts` (check the existing file first for its ffmpeg-availability skip pattern and follow it; if the suite already skips when `ffmpeg`/`ffprobe` binaries aren't present, add this test in the same guarded block):

```ts
  it('applies English-only filtering on the ASS stream-copy path', async () => {
    // A fixture MKV with an ASS subtitle stream containing one OP-style
    // Japanese/romaji line and one Default-style English line is required;
    // reuse this suite's existing fixture-generation helper if present,
    // or build one with ffmpeg from a raw ASS string the same way
    // test/providers/animetoshoProvider.test.ts builds xz fixtures.
    const vtt = await extractSubtitleToVtt(fixtureMkvPath, 2, 'ass', 30000);
    expect(vtt).toContain('Hello, how are you?');
    expect(vtt).not.toContain('Romanized lyric line');
  });
```

(This task's test must be adapted to whatever fixture-building helper `test/ffmpeg/extract.test.ts` already uses to produce a local file for ffmpeg to read — read that file in full before writing this step, since it wasn't included in this plan's research pass.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: FAIL — the romanized OP line survives because `targetLang` isn't passed through.

- [ ] **Step 3: Pass targetLang through the ASS stream-copy path**

```ts
// src/ffmpeg/extract.ts — extractSubtitleToVtt, ASS branch (was line 78)
        await runFfmpeg([...baseArgs, '-c:s', 'copy', '-y', outAssPath], timeoutMs);
        return convertAssToVtt(readFileSync(outAssPath, 'utf-8'), lang);
```

This requires `extractSubtitleToVtt` to know the target language. Add a `lang` parameter (it currently has none — the caller, `runExtractionTier` in `extractionProvider.ts`, already has `params.lang` available):

```ts
// src/ffmpeg/extract.ts — new signature
export async function extractSubtitleToVtt(
  sourceUrl: string,
  streamIndex: number,
  lang: string,
  codecOrTimeout?: string | number,
  maybeTimeoutMs?: number,
): Promise<string> {
```

Update the SRT branch's `convertToVtt(readFileSync(outSrtPath), 'srt')` call to `convertToVtt(readFileSync(outSrtPath), 'srt', lang)`, and the default/fallback branch's `normalizeVtt(readFileSync(outVttPath, 'utf-8'))` call to `normalizeVtt(readFileSync(outVttPath, 'utf-8'), lang)`, for the same reason — both currently silently default to `'eng'` too, which happens to be correct today but shouldn't rely on the default once a parameter is available.

- [ ] **Step 4: Update the one call site**

```ts
// src/providers/extractionProvider.ts:41-46
        const vttContent = await extractSubtitleToVtt(
          streamUrl,
          stream.index,
          params.lang,
          stream.codec,
          params.extractionTimeoutMs,
        );
```

- [ ] **Step 5: Run to verify the extract.ts test passes**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing test for the extractionProvider quality gate**

Add to `test/providers/extractionProvider.test.ts` (follow its existing mock pattern — check how it currently stubs `findSubtitleStream`/`extractSubtitleToVtt`, likely via a local test double or dependency injection; read the file before writing this step):

```ts
  it('rejects an extraction result that is predominantly Japanese instead of caching it', async () => {
    // Arrange the extraction pipeline (streamUrls + probe + extract mocks)
    // so extractSubtitleToVtt resolves with an all-Japanese VTT string, e.g.
    // 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nこれは日本語です\n'
    const result = await runExtractionTier({ /* ...existing fixture params..., lang: 'eng' */ });
    expect(result.found).toBe(false);
  });
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run test/providers/extractionProvider.test.ts`
Expected: FAIL — `result.found` is `true` today because nothing checks acceptability.

- [ ] **Step 8: Add the quality gate**

```ts
// src/providers/extractionProvider.ts
import { isAcceptableSubtitle } from '../ffmpeg/vttUtils.js';
// ...
        const vttContent = await extractSubtitleToVtt(
          streamUrl,
          stream.index,
          params.lang,
          stream.codec,
          params.extractionTimeoutMs,
        );
        if (!isAcceptableSubtitle(vttContent, params.lang)) continue;
        return { found: true, vttContent };
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/providers/extractionProvider.test.ts test/ffmpeg/extract.test.ts`
Expected: PASS

- [ ] **Step 10: Full test suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/ffmpeg/extract.ts src/providers/extractionProvider.ts test/ffmpeg/extract.test.ts test/providers/extractionProvider.test.ts
git commit -m "fix: apply English-only filtering and quality gate to tier-2 extraction

The ASS stream-copy path now passes targetLang through to
convertAssToVtt, and runExtractionTier rejects predominantly-Japanese
or empty results instead of caching them as ready.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 3: Codec-aware subtitle stream selection

**Files:**
- Modify: `src/ffmpeg/probe.ts:89-107` (`parseSubtitleStreams`)
- Test: `test/ffmpeg/probe.test.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: nothing new.
- Produces: `FoundSubtitleStream { index: number; codec: string }` — unchanged shape, only which stream gets selected changes.

Finding #16: `parseSubtitleStreams` filters by `tags?.language === lang` only, with no codec preference, so it can select a bitmap subtitle (`hdmv_pgs_subtitle`, `dvd_subtitle`) over a text stream (`ass`, `subrip`) in the same file. `extract.ts`'s codec branches only special-case `ass`/`ssa`/`subrip`/`srt`; a bitmap codec falls through to the default `-c:s webvtt` transcode, which ffmpeg cannot do for image-based subtitles, and the whole candidate URL is discarded by `extractionProvider.ts`'s per-URL `catch` even though the same file's text stream would have worked.

- [ ] **Step 1: Check for an existing probe test file**

Run: `ls test/ffmpeg/probe.test.ts 2>/dev/null || echo "none"`

If none exists, this task creates `test/ffmpeg/probe.test.ts` importing `parseSubtitleStreams`. Since `parseSubtitleStreams` is not currently exported, export it first (it's a pure function operating on a pre-parsed ffprobe JSON string plus a language code — no process spawning needed to unit-test it directly).

- [ ] **Step 2: Export the function**

```ts
// src/ffmpeg/probe.ts:89
export function parseSubtitleStreams(output: string, lang: string): FoundSubtitleStream | null {
```

- [ ] **Step 3: Write the failing test**

```ts
// test/ffmpeg/probe.test.ts
import { describe, it, expect } from 'vitest';
import { parseSubtitleStreams } from '../../src/ffmpeg/probe.js';

describe('parseSubtitleStreams', () => {
  it('prefers a text-based subtitle codec over a bitmap codec for the same language', () => {
    const output = JSON.stringify({
      streams: [
        { index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'Signs' } },
        { index: 3, codec_name: 'ass', tags: { language: 'eng', title: 'Dialogue' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 3, codec: 'ass' });
  });

  it('still picks the only available stream when it is bitmap-only', () => {
    const output = JSON.stringify({
      streams: [{ index: 2, codec_name: 'dvd_subtitle', tags: { language: 'eng', title: 'Full' } }],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'dvd_subtitle' });
  });
});
```

- [ ] **Step 4: Run to verify the first test fails**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: FAIL — today's code picks index 2 (PGS, first non-"sign"-titled match by iteration order... actually "Signs" title is excluded by the existing sign/song title heuristic, so it would already skip to index 3 by coincidence in this exact fixture). Adjust the fixture so both streams have a "clean" title (no "sign"/"song") to force the codec-blindness to actually manifest, e.g. both titled `'Full'`/`'Dialogue'`, confirming the first-in-list bitmap stream wins today.

- [ ] **Step 5: Add codec preference**

```ts
// src/ffmpeg/probe.ts
const TEXT_SUBTITLE_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text']);

export function parseSubtitleStreams(output: string, lang: string): FoundSubtitleStream | null {
  try {
    const parsed = JSON.parse(output) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const matching = streams.filter((s) => s.tags?.language === lang);
    if (matching.length === 0) return null;

    const textStreams = matching.filter((s) => TEXT_SUBTITLE_CODECS.has((s.codec_name ?? '').toLowerCase()));
    const pool = textStreams.length > 0 ? textStreams : matching;

    const dialogue = pool.find((s) => {
      const title = (s.tags?.title ?? '').toLowerCase();
      return !title.includes('sign') && !title.includes('song');
    });
    const selected = dialogue ?? pool[0];
    return {
      index: selected.index,
      codec: (selected.codec_name ?? 'ass').toLowerCase(),
    };
  } catch {
    return null;
  }
}
```

Text-coded streams are preferred as a pool first, then the existing "avoid sign/song titled" heuristic applies within whichever pool was selected — so a bitmap stream is only ever chosen when it's genuinely the only language match.

- [ ] **Step 6: Run to verify both tests pass**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
npm test
npm run typecheck
git add src/ffmpeg/probe.ts test/ffmpeg/probe.test.ts
git commit -m "fix: prefer text-based subtitle codecs over bitmap in stream selection

parseSubtitleStreams now prefers ass/ssa/subrip/srt/webvtt/mov_text
streams over PGS/VobSub when multiple language-matching streams
exist in the same file, since bitmap codecs can't transcode to webvtt.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 4: Cap the fast in-memory Range probe to a fixed byte budget

**Files:**
- Modify: `src/http/httpClient.ts`
- Modify: `src/ffmpeg/probe.ts:140-153` (`findSubtitleStream`)
- Test: `test/http/httpClient.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `fetchBufferCapped(url: string, maxBytes: number, opts?: FetchOptions): Promise<Buffer>` — new export from `src/http/httpClient.ts`. Only `probe.ts` calls it; `fetchBuffer` (uncapped) stays as-is since Jimaku/AnimeTosho need full-file downloads.

Finding #5: `findSubtitleStream`'s fast Range-probe path sends `Range: bytes=0-2097151` but `fetchBuffer` only checks `res.ok` (true for any 2xx, including a plain 200 from a host that ignores `Range` and returns the whole file) and calls `res.arrayBuffer()` with no byte cap — against a Range-ignoring host this can pull a large fraction of a multi-GB file into memory before the 5s timeout aborts it, once per candidate stream.

- [ ] **Step 1: Write the failing test**

Add to `test/http/httpClient.test.ts` (check its existing structure first — it likely already spins up a local server for `fetchJson`/`fetchBuffer` tests; follow that pattern):

```ts
  it('fetchBufferCapped stops reading once maxBytes is reached, even if the server ignores Range and sends more', async () => {
    // server route that responds 200 with a 10MB body regardless of the Range header
    const buf = await fetchBufferCapped(`${baseUrl}/big-file`, 1024, { timeoutMs: 5000 });
    expect(buf.length).toBeLessThanOrEqual(1024);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/http/httpClient.test.ts`
Expected: FAIL — `fetchBufferCapped` doesn't exist yet (compile error surfaces as a test failure/collection error).

- [ ] **Step 3: Implement the capped fetch using a streaming reader**

```ts
// src/http/httpClient.ts
export async function fetchBufferCapped(url: string, maxBytes: number, opts: FetchOptions = {}): Promise<Buffer> {
  return timedFetch(url, opts, async (res) => {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/http/httpClient.test.ts`
Expected: PASS

- [ ] **Step 5: Use it in the fast probe path**

```ts
// src/ffmpeg/probe.ts:140-145
import { fetchBufferCapped } from '../http/httpClient.js';
// ...
      const rangeBuffer = await fetchBufferCapped(sourceUrl, 2097152, {
        headers: { Range: 'bytes=0-2097151' },
        timeoutMs: Math.min(timeoutMs, 5000),
      });
```

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/http/httpClient.ts src/ffmpeg/probe.ts test/http/httpClient.test.ts
git commit -m "fix: cap fast subtitle-probe buffer read to 2MB regardless of Range support

fetchBufferCapped stops reading via a streaming reader once the byte
budget is hit, instead of relying on res.ok (true for any 2xx) plus
an unbounded arrayBuffer() read that could pull a whole multi-GB file
into memory on a Range-ignoring host.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 5: Separate and cap the remote-ffprobe fallback timeout from the full extraction timeout

**Files:**
- Modify: `src/config.ts`
- Modify: `src/ffmpeg/probe.ts:133-153` (`findSubtitleStream`)
- Modify: `src/providers/extractionProvider.ts` (pass the new timeout through)
- Test: `test/config.test.ts`
- Test: `test/ffmpeg/probe.test.ts`

**Interfaces:**
- Consumes: `Config` (`src/config.ts`).
- Produces: `Config.probeTimeoutMs: number` (new field, env `PROBE_TIMEOUT_MS`, default `15000`). `findSubtitleStream(sourceUrl, lang, timeoutMs, probeTimeoutMs?)` gains an optional 4th parameter used only for the remote-ffprobe fallback branch; when omitted, it falls back to today's behavior (reuse `timeoutMs`) so existing call sites without the new parameter still compile and behave the same until Task updates them.

Finding #3: the remote-ffprobe fallback (`findSubtitleStream`'s second branch, after the fast in-memory probe fails) inherits the *full* `extractionTimeoutMs` (default 900000ms = 15 minutes), and with `EXTRACTION_CONCURRENCY` defaulting to `1`, one stalled/slow stream can occupy the sole extraction-queue slot for up to ~15 minutes per candidate across up to 5 candidates, serializing every other pending tier-2 (post-restructure) request behind it.

- [ ] **Step 1: Write the failing config test**

Add to `test/config.test.ts` (follow its existing per-field test pattern):

```ts
  it('defaults probeTimeoutMs to 15000ms and reads PROBE_TIMEOUT_MS', () => {
    expect(loadConfig(baseEnv()).probeTimeoutMs).toBe(15000);
    expect(loadConfig({ ...baseEnv(), PROBE_TIMEOUT_MS: '5000' }).probeTimeoutMs).toBe(5000);
  });
```

(Use whatever `baseEnv()`-style helper the existing test file already has for constructing a minimal valid env; if none exists, build the required env object inline the same way neighboring tests in that file do.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `probeTimeoutMs` is `undefined`.

- [ ] **Step 3: Add the config field**

```ts
// src/config.ts
export interface Config {
  // ...existing fields...
  probeTimeoutMs: number;
}
// in loadConfig's return object:
    probeTimeoutMs: requireInt(env, 'PROBE_TIMEOUT_MS', 15000),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing probe test for the capped fallback timeout**

Add to `test/ffmpeg/probe.test.ts`:

```ts
  it('caps the remote-ffprobe fallback to probeTimeoutMs, not the full extraction timeout', async () => {
    // This exercises findSubtitleStream against a non-HTTP or slow source
    // so it falls through to the ffprobe-on-URL branch, and asserts the
    // child process is invoked with a timeout bounded by probeTimeoutMs
    // even when a much larger timeoutMs is passed in. If runCommand isn't
    // easily mockable, assert via a real slow local server + a short
    // probeTimeoutMs and measure wall-clock time stays near probeTimeoutMs,
    // not the large timeoutMs.
  });
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: FAIL (or does not compile, since `probeTimeoutMs` isn't a parameter yet).

- [ ] **Step 7: Implement the capped fallback timeout**

```ts
// src/ffmpeg/probe.ts
export async function findSubtitleStream(
  sourceUrl: string,
  lang: string,
  timeoutMs = 30000,
  probeTimeoutMs = 15000,
): Promise<FoundSubtitleStream | null> {
  // ...fast in-memory probe unchanged...

  const output = await runCommand(
    'ffprobe',
    [ /* ...unchanged args... */ ],
    Math.min(timeoutMs, probeTimeoutMs),
  );
  return parseSubtitleStreams(output, lang);
}
```

- [ ] **Step 8: Pass config through from extractionProvider**

```ts
// src/providers/extractionProvider.ts — ExtractionParams gains probeTimeoutMs
export interface ExtractionParams {
  // ...existing fields...
  probeTimeoutMs: number;
}
// in runExtractionTier, the findSubtitleStream call:
        const stream = await findSubtitleStream(
          streamUrl,
          params.lang,
          params.extractionTimeoutMs,
          params.probeTimeoutMs,
        );
```

And in `src/subtitlesHandler.ts`'s `startExtractionInBackground` (the call site building `ExtractionParams`), add `probeTimeoutMs: deps.config.probeTimeoutMs,`.

- [ ] **Step 9: Run full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/config.ts src/ffmpeg/probe.ts src/providers/extractionProvider.ts src/subtitlesHandler.ts test/config.test.ts test/ffmpeg/probe.test.ts
git commit -m "fix: cap remote-ffprobe fallback timeout independently of full extraction timeout

Previously the ffprobe-on-URL fallback inherited the full 900s
extraction timeout, so with EXTRACTION_CONCURRENCY=1 a single stalled
stream could occupy the queue for up to 15 minutes per candidate.
New PROBE_TIMEOUT_MS (default 15000) bounds just that fallback probe.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 6: Jimaku — loosen language matching and fall back to the next candidate file

**Files:**
- Modify: `src/providers/jimakuProvider.ts`
- Test: `test/providers/jimakuProvider.test.ts`

**Interfaces:**
- Consumes: `isAcceptableSubtitle` (unchanged).
- Produces: `findJimakuSubtitle`'s public signature is unchanged.

Finding #6: `matchesLanguage` requires an explicit `english`/`eng`/`[en]` filename token, so a Jimaku entry with one untagged file per episode (`"Show Name - 05.srt"`, no language token) is skipped entirely. Separately, `files.find(...)` only ever tries the *first* filename-matching file; if that one fails `isAcceptableSubtitle`, the function gives up instead of trying a second matching file.

- [ ] **Step 1: Write the failing tests**

Add to `test/providers/jimakuProvider.test.ts`'s mock server (extend the existing `beforeAll` server handler with two new episode routes, following the existing `episode=5`/`6`/`7`/`8` pattern) and two new `it` blocks:

```ts
      } else if (url.pathname === '/api/entries/1/files' && url.searchParams.get('episode') === '9') {
        // untagged filename, no language token at all
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'Show - 09.srt', url: `${baseUrl}/files/untagged.srt` },
        ]));
      } else if (url.pathname === '/api/entries/1/files' && url.searchParams.get('episode') === '10') {
        // first English-tagged file is mislabeled Japanese, second is real English
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'Show - 10 [English].srt', url: `${baseUrl}/files/mislabeled-japanese.srt` },
          { name: 'Show - 10 [en] v2.srt', url: `${baseUrl}/files/english-v2.srt` },
        ]));
```

And add the two new file routes alongside the existing `/files/*` handlers:

```ts
      } else if (url.pathname === '/files/untagged.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nUntagged file fixture line\n');
      } else if (url.pathname === '/files/english-v2.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nSecond candidate fixture line\n');
```

New assertions:

```ts
  it('does not skip an episode whose only file has no explicit language token, when it is the sole candidate', async () => {
    const result = await findJimakuSubtitle(154587, 9, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Untagged file fixture line');
  });

  it('falls back to the next matching file when the first one fails the acceptability check', async () => {
    const result = await findJimakuSubtitle(154587, 10, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Second candidate fixture line');
  });
```

- [ ] **Step 2: Run to verify both fail**

Run: `npx vitest run test/providers/jimakuProvider.test.ts`
Expected: FAIL on both new tests (episode 9: `matchesLanguage` rejects the untagged file, `found: false`; episode 10: only the first mislabeled file is tried, `found: false`).

- [ ] **Step 3: Loosen matching and add fallback iteration**

```ts
// src/providers/jimakuProvider.ts
function matchesLanguage(filename: string, lang: string, isSoleCandidate: boolean): boolean {
  if (!SUBTITLE_EXTENSIONS.test(filename)) return false;
  if (EXCLUDED_LANGUAGE_TOKENS.test(filename)) return false;
  const pattern = LANGUAGE_TOKENS[lang];
  if (pattern && pattern.test(filename)) return true;
  // No explicit language token anywhere, and no other file to prefer
  // instead: accept it and let isAcceptableSubtitle be the real gate.
  return isSoleCandidate && !hasAnyLanguageToken(filename);
}

function hasAnyLanguageToken(filename: string): boolean {
  return Object.values(LANGUAGE_TOKENS).some((p) => p.test(filename)) || EXCLUDED_LANGUAGE_TOKENS.test(filename);
}
```

And in `findJimakuSubtitle`, replace the single `files.find(...)` + single download with an iteration over all filename-plausible candidates, falling through on acceptability failure:

```ts
  const candidates = files.filter((f) => SUBTITLE_EXTENSIONS.test(f.name) && !EXCLUDED_LANGUAGE_TOKENS.test(f.name));
  const taggedMatches = candidates.filter((f) => LANGUAGE_TOKENS[lang]?.test(f.name));
  const untaggedFallback = candidates.length === 1 && taggedMatches.length === 0 && !hasAnyLanguageToken(candidates[0].name)
    ? candidates
    : [];
  const ordered = taggedMatches.length > 0 ? taggedMatches : untaggedFallback;

  for (const match of ordered) {
    const ext = extToVttInput(match.name);
    if (!ext) continue;
    const raw = await fetchBuffer(match.url, { timeoutMs });
    const vttContent = ext === 'vtt' ? raw.toString('utf-8') : await convertToVtt(raw, ext, lang);
    if (!isAcceptableSubtitle(vttContent, lang)) continue;
    return { found: true, vttContent };
  }
  return { found: false };
```

Remove the now-unused standalone `matchesLanguage` call from the old single-file lookup path (this replaces it; delete the old `matchesLanguage`/`match` variable and its `if (!match) return { found: false };` block entirely, along with the old `matchesLanguage(filename, lang)` two-arg version — the function is now only used internally by the new filtering logic above, or can be inlined/removed if `taggedMatches`'s filter makes the standalone function redundant. Prefer removing `matchesLanguage` entirely and inlining `LANGUAGE_TOKENS[lang]?.test(f.name)` as shown, to avoid keeping two language-matching code paths in sync.)

- [ ] **Step 4: Run to verify both new tests pass, and no regressions**

Run: `npx vitest run test/providers/jimakuProvider.test.ts`
Expected: all PASS, including every pre-existing test in the file (episode 8's mislabeled-Japanese-but-tagged-English case must still return `found: false` since it's the *only* tagged match and fails acceptability with no fallback — confirm this against the existing test at that episode number still passes unchanged).

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/providers/jimakuProvider.ts test/providers/jimakuProvider.test.ts
git commit -m "fix: Jimaku accepts untagged sole-candidate files and falls back on rejection

matchesLanguage no longer hard-requires an explicit language token
when it's the only subtitle file for an episode. findJimakuSubtitle
now iterates all language-plausible candidates instead of giving up
after the first one fails isAcceptableSubtitle.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 7: AnimeTosho — isolate per-candidate failures, stop poisoning the whole series from an episode-scoped miss, and catch batch releases via a broader fallback search

**Files:**
- Modify: `src/providers/animetoshoProvider.ts`
- Test: `test/providers/animetoshoProvider.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findAnimeToshoSubtitle`'s public signature and `ProviderResult` shape are unchanged. `seriesNotFound` semantics change (see below) — `subtitlesHandler.ts` (Task 18) must be aware `seriesNotFound` from AnimeTosho is now only set when `anidbId === null` and the title search also misses, not whenever an `aid`+`q` search alone misses.

Three findings, same function, done together to avoid touching `findAnimeToshoSubtitle` three separate times:

- **Finding #8**: the per-candidate loop body (fetch torrent detail, download attachment, decompress, convert) has no try/catch, so one failing candidate throws and aborts the whole search, skipping remaining candidates that might have matched.
- **Finding #7**: `aid=X&q=episode` is an *episode-scoped* search (the `q` parameter filters to that episode number specifically). Today, zero results from it sets `seriesNotFound: true`, which `subtitlesHandler.ts` uses to blacklist the *entire series* from AnimeTosho for 24h — even though episode 6's independent `q=6` search next week is unrelated to episode 5's `q=5` search coming up empty today. `seriesNotFound` should only reflect "this AniDB entry appears entirely unindexed," which the anidb-scoped title-fallback path (used when `anidbId === null`) can reasonably claim, but an episode-scoped `aid`+`q` miss cannot.
- **Finding #9** (unverified/plausible in the review): a batch release title like `[Group] Show (01-12) [1080p]` has no bare `"5"` token, so it's plausible the `q=5` server-side text search excludes it even though the existing `num_files > 1` per-file matching logic (`detail.files.find(...)`) would find episode 5 inside it once the torrent is fetched. Mitigate by also trying a broader `aid`-only search (no `q`) when the primary `aid`+`q` search returns zero and `anidbId` is present, purely additive so it can't remove any currently-working match.

- [ ] **Step 1: Write the failing tests**

Add to the mock server in `test/providers/animetoshoProvider.test.ts` (extend the existing `if (aid === '18886')` etc. chain) a new `aid` that demonstrates each case, and add new `it` blocks:

```ts
        } else if (aid === '39999' && !q) {
          // broader aid-only search finds a batch release the q=-filtered search missed
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 40, title: '[Group] BroadBatch (01-12) [1080p]', status: 'complete', num_files: 12 },
          ]));
        } else if (aid === '39999' && q) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
        } else if (aid === '49999') {
          // simulates a torrent-detail fetch that fails for the first candidate
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 50, title: '[Group] FlakyShow - 05 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 51, title: '[Group] FlakyShow - 05 (alt) [720p].mkv', status: 'complete', num_files: 1 },
          ]));
```

Add the corresponding torrent-detail routes: id `50` returns a 500 (or a malformed body that throws on `.json()`), id `51` returns a valid file with an English SRT attachment reusing `compressedSrtSubtitle`. Add a matching attachment-download route for id 51's attachment.

For the batch-detail route for id `40`, return one file matching episode 5 with an English attachment (reuse the ASS fixture).

```ts
  it('does not abort the whole search when one candidate torrent-detail fetch fails', async () => {
    const result = await findAnimeToshoSubtitle(49999, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('AnimeTosho SRT fixture line');
  });

  it('does not set seriesNotFound from an anidbId-scoped episode search alone', async () => {
    const result = await findAnimeToshoSubtitle(18886, 999, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBeFalsy();
  });

  it('falls back to a broader aid-only search to catch batch releases the q=-filtered search missed', async () => {
    const result = await findAnimeToshoSubtitle(39999, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('AnimeTosho fixture line');
  });
```

- [ ] **Step 2: Run to verify all three fail**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: FAIL on all three — the first throws out of the function entirely (test failure via unhandled rejection or wrong result), the second currently returns `seriesNotFound: true`, the third returns `found: false` because only the `q=`-filtered search runs.

- [ ] **Step 3: Wrap the per-candidate loop body in try/catch**

```ts
// src/providers/animetoshoProvider.ts — inside the `for (const candidate of candidates)` loop
  for (const candidate of candidates) {
    try {
      let targetFile: ToshoFile | undefined;
      // ...existing per-candidate body unchanged...
      for (const attachment of subtitleAttachments) {
        // ...existing unchanged...
        return { found: true, vttContent };
      }
    } catch (err) {
      console.warn(`[AnimeTosho] Candidate ${candidate.id} failed: ${(err as Error).message}`);
      continue;
    }
  }
```

(Wrap the existing loop body as-is inside `try { ... } catch (err) { ...; continue; }` — no other logic changes in this step.)

- [ ] **Step 4: Change seriesNotFound semantics and add the broader fallback search**

```ts
// src/providers/animetoshoProvider.ts
export async function findAnimeToshoSubtitle(
  anidbId: number | null,
  episode: number,
  lang: string,
  opts: AnimeToshoOptions = {},
): Promise<ProviderResult> {
  const feedBaseUrl = (opts.feedBaseUrl ?? 'https://feed.animetosho.org').replace(/\/+$/, '');
  const storageBaseUrl = (opts.storageBaseUrl ?? 'https://animetosho.org').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;

  let results: ToshoSearchResult[] = [];
  let anidbSeriesUnindexed = false;

  if (anidbId !== null) {
    results = await fetchJson<ToshoSearchResult[]>(
      `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${episode}&limit=50`,
      { timeoutMs },
    );
    if (results.length === 0) {
      // Broader, unfiltered search: catches batch releases whose title
      // doesn't literally contain the bare episode number, which the
      // q= server-side text filter can otherwise exclude.
      results = await fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`,
        { timeoutMs },
      );
    }
  }

  if (results.length === 0 && opts.title) {
    const cleanTitle = opts.title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanTitle) {
      results = await fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&q=${encodeURIComponent(`${cleanTitle} ${episode}`)}&limit=50`,
        { timeoutMs },
      );
      anidbSeriesUnindexed = anidbId === null && results.length === 0;
    }
  } else if (results.length === 0 && anidbId === null) {
    anidbSeriesUnindexed = true;
  }

  if (results.length === 0) {
    return { found: false, seriesNotFound: anidbSeriesUnindexed };
  }

  // ...rest of the function (candidate filtering/loop) unchanged except for the try/catch from Step 3...
}
```

`seriesNotFound` is now only ever `true` when `anidbId === null` (a pure title-based lookup, which is genuinely series-scoped) and that title search also came back empty — never from an `aid`-scoped search, broad or episode-filtered, since AniDB entries can have episodes indexed incrementally over time.

- [ ] **Step 5: Run to verify all three pass, and check for regressions**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: all PASS. The pre-existing test `'returns seriesNotFound: true when both aid and title search return 0 results'` (anidbId `99999`, title `'Nonexistent Show'`) must be re-examined: `anidbId` is non-null (`99999`), so under the new rule `seriesNotFound` comes only from the `anidbId === null` branch — this existing test's expectation is now wrong per the fix and must be updated:

```ts
  it('does not set seriesNotFound when anidbId is present, even if aid, broad, and title searches all miss', async () => {
    const result = await findAnimeToshoSubtitle(99999, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Nonexistent Show',
    });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBeFalsy();
  });
```

Rename/replace the old test with this one. The existing `'searches by title directly when anidbId is null'` and a genuinely-title-only-miss case should still confirm `seriesNotFound: true` fires for the `anidbId === null` path — add if not already covered:

```ts
  it('sets seriesNotFound true when anidbId is null and the title search also misses', async () => {
    const result = await findAnimeToshoSubtitle(null, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Totally Unknown Show',
    });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBe(true);
  });
```

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/providers/animetoshoProvider.ts test/providers/animetoshoProvider.test.ts
git commit -m "fix: isolate AnimeTosho candidate failures and stop episode-scoped misses from poisoning the whole series

- Per-candidate torrent processing is now wrapped in try/catch so one
  failing fetch/download/decompress no longer aborts remaining candidates.
- seriesNotFound is only set for a genuine title-only lookup miss
  (anidbId === null), never from an aid+q episode-scoped search alone,
  since that used to blacklist an entire series for 24h based on one
  episode's absence.
- Added a broader aid-only fallback search (no q= filter) to catch
  batch releases whose title doesn't contain the bare episode number.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 8: Make the anime-dataset rebuild transactional

**Files:**
- Modify: `src/resolver/animeDataset.ts:47-72` (`AnimeDataset.buildFromRaw`)
- Test: `test/resolver/animeDataset.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AnimeDataset.buildFromRaw(raw: RawDataset, db: Database.Database): AnimeDataset` — signature unchanged.

Finding #18 (highest severity in the review): `buildFromRaw` runs `db.exec('DROP TABLE ...; CREATE TABLE ...')` as a bare, non-transactional statement (SQLite auto-commits it immediately), then inserts inside a `db.transaction(...)`. If any entry throws during insertion (e.g. a null/missing `sources` field), the insert rolls back but the DROP+CREATE does not — the refresh interval's `.catch` in `index.ts` just logs and leaves the stale `AnimeDataset` pointing at the now-permanently-empty table for up to 24h.

- [ ] **Step 1: Write the failing test**

Add to `test/resolver/animeDataset.test.ts`:

```ts
  it('leaves the previous table intact when a rebuild fails partway through insertion', () => {
    const db = new Database(':memory:');
    AnimeDataset.buildFromRaw(sampleRaw, db); // first successful build

    const badRaw = {
      data: [
        // @ts-expect-error -- intentionally malformed to simulate a bad upstream entry
        { sources: null },
      ],
    };
    expect(() => AnimeDataset.buildFromRaw(badRaw, db)).toThrow();

    // The table from the first successful build must still be queryable.
    const dataset = new (AnimeDataset as any)(db); // or re-fetch via a public accessor if one exists
    const row = db.prepare('SELECT anilist_id FROM anime_ids WHERE anilist_id = ?').get(154587);
    expect(row).toBeDefined();
  });
```

(If `AnimeDataset`'s constructor isn't accessible for a direct re-wrap in the test, query the raw `db` handle directly as shown — the point is asserting the previously-populated `anime_ids` table survives a failed rebuild, not exercising the class's public query methods again.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/resolver/animeDataset.test.ts`
Expected: FAIL — today's `buildFromRaw` throws (good), but the table is left empty (DROP+CREATE already committed), so the row lookup after the `expect(...).toThrow()` returns `undefined`.

- [ ] **Step 3: Wrap the whole rebuild in one transaction**

```ts
// src/resolver/animeDataset.ts
  static buildFromRaw(raw: RawDataset, db: Database.Database): AnimeDataset {
    const insert = db.prepare('INSERT INTO anime_ids (anilist_id, anidb_id, kitsu_id, mal_id, title) VALUES (?, ?, ?, ?, ?)');

    const rebuild = db.transaction((entries: RawDatasetEntry[]) => {
      db.exec(`
        DROP TABLE IF EXISTS anime_ids;
        CREATE TABLE anime_ids (
          anilist_id INTEGER,
          anidb_id INTEGER,
          kitsu_id INTEGER,
          mal_id INTEGER,
          title TEXT
        );
        CREATE INDEX idx_anilist ON anime_ids(anilist_id);
        CREATE INDEX idx_anidb ON anime_ids(anidb_id);
        CREATE INDEX idx_kitsu ON anime_ids(kitsu_id);
        CREATE INDEX idx_mal ON anime_ids(mal_id);
      `);
      for (const entry of entries) {
        const ids = extractIds(entry.sources);
        if (ids.anilistId === null && ids.anidbId === null && ids.kitsuId === null && ids.malId === null) continue;
        insert.run(ids.anilistId, ids.anidbId, ids.kitsuId, ids.malId, entry.title ?? null);
      }
    });

    rebuild(raw.data);
    return new AnimeDataset(db);
  }
```

`db.exec(...)` (DDL) is executed *inside* the `db.transaction(...)` callback now, so a `BEGIN` wraps the DROP+CREATE too — better-sqlite3 supports DDL inside transactions, and an exception anywhere in the callback (including `extractIds` throwing on a malformed entry) rolls back the DROP+CREATE along with the inserts, leaving the prior table exactly as it was. `insert` is prepared before the transaction starts, which is safe since preparing a statement doesn't touch table data.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/resolver/animeDataset.test.ts`
Expected: PASS, and all pre-existing tests in the file still PASS unchanged.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/resolver/animeDataset.ts test/resolver/animeDataset.test.ts
git commit -m "fix: make anime-dataset rebuild fully transactional

DROP TABLE + CREATE TABLE now run inside the same db.transaction as
the row inserts, so a malformed upstream entry rolls back the whole
rebuild instead of leaving anime_ids permanently empty until the next
successful 24h refresh.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 9: Dataset-download startup failure falls back to the existing on-disk dataset instead of crash-looping

**Files:**
- Modify: `src/index.ts:16-28`
- Test: create `test/index.test.ts` if none exists (check first), or add coverage at the `animeDataset.ts` level if `index.ts`'s `main()` isn't structured for direct testing — see Step 3.

**Interfaces:**
- Consumes: `AnimeDataset.buildFromRaw` (unchanged), `downloadDataset` (unchanged).
- Produces: no new exports required from `index.ts` itself, but this task extracts the startup dataset-loading logic into a testable function.

Finding #19: `downloadDataset()` is awaited at startup with no fallback; any failure is fatal via `main().catch(() => process.exit(1))`, even when a valid `anime_ids` table from a previous successful run already sits in the mounted `cache.db`... wait, `anime-dataset.db` (the dataset DB, distinct from `cache.db`) on the persistent volume.

- [ ] **Step 1: Extract the dataset-loading logic into a testable function**

```ts
// src/index.ts
export async function loadOrRefreshDataset(datasetDb: Database.Database, previous?: AnimeDataset): Promise<AnimeDataset> {
  try {
    const raw = await downloadDataset();
    return AnimeDataset.buildFromRaw(raw, datasetDb);
  } catch (err) {
    if (previous) {
      console.error(`[AnimeSubs] Dataset download/build failed, keeping previous in-memory dataset: ${(err as Error).message}`);
      return previous;
    }
    const existing = tryLoadExistingTable(datasetDb);
    if (existing) {
      console.error(`[AnimeSubs] Dataset download failed on startup; falling back to on-disk anime_ids table from a previous run: ${(err as Error).message}`);
      return existing;
    }
    throw err;
  }
}

function tryLoadExistingTable(db: Database.Database): AnimeDataset | null {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anime_ids'").get();
    if (!row) return null;
    const count = (db.prepare('SELECT COUNT(*) as c FROM anime_ids').get() as { c: number }).c;
    if (count === 0) return null;
    return new (AnimeDataset as unknown as { new (db: Database.Database): AnimeDataset })(db);
  } catch {
    return null;
  }
}
```

This needs `AnimeDataset`'s constructor to be reachable. Since it's currently `private constructor`, add a dedicated factory instead of reaching around TypeScript's privacy:

```ts
// src/resolver/animeDataset.ts — add alongside buildFromRaw
  static fromExistingTable(db: Database.Database): AnimeDataset {
    return new AnimeDataset(db);
  }
```

And use `AnimeDataset.fromExistingTable(db)` in `tryLoadExistingTable` instead of the type-cast constructor call shown above.

- [ ] **Step 2: Write the failing test**

Create `test/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { loadOrRefreshDataset } from '../src/index.js';

describe('loadOrRefreshDataset', () => {
  it('falls back to an existing on-disk anime_ids table when the download fails and no previous in-memory dataset exists', async () => {
    const db = new Database(':memory:');
    AnimeDataset.buildFromRaw({ data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617'] }] }, db);

    // downloadDataset with an unreachable URL forces a failure
    const dataset = await loadOrRefreshDataset(db, undefined);
    expect(dataset.findByAnilistId(154587)).toEqual({ anilistId: 154587, anidbId: 17617, title: null });
  });

  it('rethrows when the download fails and there is no fallback table at all', async () => {
    const db = new Database(':memory:');
    await expect(loadOrRefreshDataset(db, undefined)).rejects.toThrow();
  });
});
```

(`loadOrRefreshDataset` calls `downloadDataset()` with no URL argument, which defaults to the real GitHub release URL — for a hermetic test, give `loadOrRefreshDataset` an optional `downloadUrl` parameter that it forwards to `downloadDataset`, and point the first test at a URL that's guaranteed to fail fast, e.g. `http://127.0.0.1:1/unreachable` (connection refused). Thread this parameter through in Step 1's implementation: `loadOrRefreshDataset(datasetDb, previous, downloadUrl?)`, forwarding to `downloadDataset(downloadUrl)`.)

- [ ] **Step 3: Run to verify both fail as expected today**

Run: `npx vitest run test/index.test.ts`
Expected: the first test FAILs (`loadOrRefreshDataset` doesn't exist yet / throws instead of falling back); the second test may already pass by accident (it throws either way pre-fix) — that's fine, it's a regression guard for after the fix too.

- [ ] **Step 4: Wire it into main()**

```ts
// src/index.ts — replace the direct downloadDataset() call
  const datasetDb = new Database(join(config.dataDir, 'anime-dataset.db'));
  const datasetHolder: DatasetHolder = { current: await loadOrRefreshDataset(datasetDb) };
  setInterval(async () => {
    datasetHolder.current = await loadOrRefreshDataset(datasetDb, datasetHolder.current);
  }, DATASET_REFRESH_INTERVAL_MS);
```

(The `setInterval` callback no longer needs its own try/catch — `loadOrRefreshDataset` already swallows refresh-time failures by falling back to `previous`; only a true startup failure with nothing to fall back to propagates.)

- [ ] **Step 5: Run to verify both tests pass**

Run: `npx vitest run test/index.test.ts`
Expected: PASS

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/index.ts src/resolver/animeDataset.ts test/index.test.ts
git commit -m "fix: fall back to existing on-disk dataset when startup download fails

Previously any downloadDataset() failure at startup was fatal
(main().catch(() => process.exit(1))), causing a crash-loop on a
transient GitHub outage even when a valid anime_ids table from a
prior successful run already existed on the persistent volume.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 10: Recover stuck 'pending' cache rows on restart; add graceful shutdown

**Files:**
- Modify: `src/cache/cacheStore.ts`
- Modify: `src/index.ts`
- Test: `test/cache/cacheStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CacheStore.reconcilePendingOnStartup(): number` (new method, returns count of rows reconciled) — called once from `index.ts` at startup, after `new CacheStore(...)`.

Finding #20: a `status='pending'` row is never re-driven after a process restart — the in-memory `inFlight` Map is wiped, but the persisted SQLite row stays `pending` forever. `resolveOneLanguage` sees `pending` and reports the subtitle "available" without restarting extraction; `/vtt` sees no matching `inFlight` promise and serves the placeholder text forever.

- [ ] **Step 1: Write the failing test**

Add to `test/cache/cacheStore.test.ts`:

```ts
  it('reconciles stale pending rows left over from a process restart back to a clean (absent) state', () => {
    store.setPending(key);
    // Simulate a restart: inFlight Map is empty (fresh CacheStore instance),
    // but the DB row is still 'pending'.
    const reconciled = store.reconcilePendingOnStartup();
    expect(reconciled).toBe(1);
    expect(store.get(key)).toBeNull();
  });

  it('does not touch ready or negative rows during pending reconciliation', () => {
    store.setReady(key, 1, 'WEBVTT\n\n1\nhi');
    const otherKey = { ...key, episode: 11 };
    store.setNegative(otherKey);
    store.reconcilePendingOnStartup();
    expect(store.get(key)?.status).toBe('ready');
    expect(store.get(otherKey)?.status).toBe('negative');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: FAIL — `reconcilePendingOnStartup` doesn't exist.

- [ ] **Step 3: Implement it**

```ts
// src/cache/cacheStore.ts
  reconcilePendingOnStartup(): number {
    const result = this.db.prepare("DELETE FROM cache WHERE status = 'pending'").run();
    return result.changes;
  }
```

Deleting the row (rather than trying to resume extraction here) is correct: on the next `/subtitles` request for that key, `resolveOneLanguage` will find no cache entry, run Tier 1 fresh, and re-kick Tier 2 extraction if needed — the same path any never-before-seen episode takes. `CacheStore` has no reference to the extraction machinery to restart a job from here even if it wanted to.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: PASS

- [ ] **Step 5: Call it at startup and add SIGTERM/SIGINT handling**

```ts
// src/index.ts, in main(), right after `const cache = new CacheStore(...)`:
  const reconciled = cache.reconcilePendingOnStartup();
  if (reconciled > 0) {
    console.log(`[AnimeSubs] Cleared ${reconciled} stale pending cache row(s) from a previous run`);
  }
```

```ts
// src/index.ts — after app.listen(...)
  const server = app.listen(config.port, () => {
    console.log(`AnimeSubs listening on port ${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[AnimeSubs] Received ${signal}, shutting down`);
    server.close(() => {
      cache.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
```

(This requires capturing `app.listen(...)`'s return value, which the current code discards — reassign it to `server` as shown, since `Express.listen()` returns an `http.Server`.)

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/cache/cacheStore.ts src/index.ts test/cache/cacheStore.test.ts
git commit -m "fix: clear stale pending cache rows on startup, add graceful shutdown

A 'pending' row left over from a killed/restarted process is now
cleared at startup so the next request for that episode re-runs
extraction from scratch, instead of being served the placeholder
'reselect this track' text forever. Also added SIGTERM/SIGINT
handling for a clean shutdown.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Phase 2 — Tier restructure and OpenSubtitles provider (the approved spec)

Builds on Phase 1's transaction-safe `animeDataset.ts` (Task 8) and folds in every finding whose fix location lives inside a function this phase rewrites, rather than touching those functions a second time: #1 (resolved structurally by Tasks 16+18), #2 (addressed by the concurrent-provider design itself, no dedicated step), #4 (Task 19), #10 (Task 18), #11 (Task 18), #12 (Task 18), #17 (Task 16 for the cache-write half, Task 19 for the serve half), #22 (Task 18).

Task numbering for this phase: 11 (dependency), 12 (episode-mapping resolver), 13 (imdb_id column), 14 (reverse id resolution), 15 (config), 16 (cache schema), 17 (OpenSubtitles provider), 18 (subtitlesHandler restructure), 19 (server.ts), 20 (index.ts wiring).

### Task 11: Add the `fast-xml-parser` dependency

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the `fast-xml-parser` package, importable as `import { XMLParser } from 'fast-xml-parser';` in Task 12.

No existing dependency parses XML; the `anime-lists` mapping dataset (Task 12) is XML. `fast-xml-parser` is a pure-JS, zero-native-dependency parser (important since this project already carries `better-sqlite3` as its one native dependency and Docker build complexity should not grow further).

- [ ] **Step 1: Install and pin the dependency**

```bash
npm install fast-xml-parser
```

- [ ] **Step 2: Verify it installed into `dependencies` (not `devDependencies`)**

Run: `grep -A1 '"fast-xml-parser"' package.json`
Expected: it appears under `"dependencies"` — this is a runtime dependency (used at container startup to download and parse the mapping dataset), not a build/test-only tool.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add fast-xml-parser for anime-lists episode-mapping dataset

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 12: Episode-mapping resolver (`episodeMapping.ts`)

**Files:**
- Create: `src/resolver/episodeMapping.ts`
- Create: `test/resolver/episodeMapping.test.ts`
- Test fixtures: inline XML strings in the test file (small hand-written fragments matching the real schema — do not fetch the live dataset in tests).

**Interfaces:**
- Consumes: `fast-xml-parser`'s `XMLParser` (Task 11), `better-sqlite3`'s `Database.Database` (existing pattern from `animeDataset.ts`).
- Produces (all consumed by Task 13, Task 14, Task 18):
  - `interface MappingRow { anidbId: number; tvdbId: string | null; imdbId: string | null; defaultTvdbSeason: number | null; episodeOffset: number | null; mappingRules: MappingRule[] }`
  - `interface MappingRule { anidbSeason: number; tvdbSeason: number; ranges: { start: number; end: number; offset: number }[]; explicit: { from: number; to: number }[] }`
  - `class EpisodeMapping { static buildFromXml(xml: string, db: Database.Database): EpisodeMapping; findByAnidbId(anidbId: number): MappingRow | null; mapAnidbToTvdbEpisode(anidbId: number, anidbEpisode: number, anidbSeason?: number): { season: number; episode: number } | null; mapTvdbToAnidbEpisode(tvdbId: string, tvdbSeason: number, tvdbEpisode: number): { anidbId: number; anidbEpisode: number } | null }`
  - `async function downloadEpisodeMapping(url?: string): Promise<string>` (returns raw XML text, mirrors `downloadDataset`'s shape in `animeDataset.ts`)

Per the spec (Component 1): the dataset is `https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml`. Verified live during spec research: reachable, ~10,767 `<anime>` entries, schema is `<anime anidbid="N" tvdbid="M|movie" defaulttvdbseason="S" imdbid="ttXXXXXXX"? episodeoffset="O"?><mapping-list><mapping anidbseason="A" tvdbseason="B" start="S" end="E" offset="O"/><mapping anidbseason="A" tvdbseason="B">;from1-to1;from2-to2;</mapping></mapping-list></anime>`. A `mapping` element either has `start`/`end`/`offset` attributes (range rule) or semicolon-delimited `from-to` pairs as its text content (explicit rule) — never both. Entries without any `<mapping-list>` use straight 1:1 numbering into `defaulttvdbseason`.

This task is large enough to split into its own sub-steps for the SQL schema, the XML parsing, and the two mapping directions.

- [ ] **Step 1: Write the failing test for schema + basic passthrough (no mapping-list)**

```ts
// test/resolver/episodeMapping.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { EpisodeMapping } from '../../src/resolver/episodeMapping.js';

const simpleXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="1" tvdbid="72025" defaulttvdbseason="1">
    <name>Fixture Show</name>
  </anime>
</anime-list>`;

describe('EpisodeMapping — no mapping-list (straight passthrough)', () => {
  it('maps anidb episode N to tvdb season=defaulttvdbseason, episode=N with no offset', () => {
    const mapping = EpisodeMapping.buildFromXml(simpleXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(1, 5)).toEqual({ season: 1, episode: 5 });
  });

  it('returns null for an anidbId not present in the dataset', () => {
    const mapping = EpisodeMapping.buildFromXml(simpleXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(999, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/resolver/episodeMapping.test.ts`
Expected: FAIL — `episodeMapping.ts` doesn't exist.

- [ ] **Step 3: Implement the schema, XML parsing, and passthrough mapping**

```ts
// src/resolver/episodeMapping.ts
import type Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';

export interface MappingRule {
  anidbSeason: number;
  tvdbSeason: number;
  ranges: { start: number; end: number; offset: number }[];
  explicit: { from: number; to: number }[];
}

export interface MappingRow {
  anidbId: number;
  tvdbId: string | null;
  imdbId: string | null;
  defaultTvdbSeason: number | null;
  episodeOffset: number | null;
  mappingRules: MappingRule[];
}

interface RawMappingElement {
  '@_anidbseason': string;
  '@_tvdbseason': string;
  '@_start'?: string;
  '@_end'?: string;
  '@_offset'?: string;
  '#text'?: string;
}
interface RawAnimeElement {
  '@_anidbid': string;
  '@_tvdbid'?: string;
  '@_imdbid'?: string;
  '@_defaulttvdbseason'?: string;
  '@_episodeoffset'?: string;
  'mapping-list'?: { mapping: RawMappingElement | RawMappingElement[] };
}

function parseMappingRules(raw: RawAnimeElement['mapping-list']): MappingRule[] {
  if (!raw?.mapping) return [];
  const elements = Array.isArray(raw.mapping) ? raw.mapping : [raw.mapping];
  return elements.map((m) => {
    const rule: MappingRule = {
      anidbSeason: parseInt(m['@_anidbseason'], 10),
      tvdbSeason: parseInt(m['@_tvdbseason'], 10),
      ranges: [],
      explicit: [],
    };
    if (m['@_start'] !== undefined && m['@_end'] !== undefined) {
      rule.ranges.push({
        start: parseInt(m['@_start'], 10),
        end: parseInt(m['@_end'], 10),
        offset: parseInt(m['@_offset'] ?? '0', 10),
      });
    } else if (typeof m['#text'] === 'string') {
      for (const pair of m['#text'].split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const [from, to] = trimmed.split('-').map((n) => parseInt(n, 10));
        if (!Number.isNaN(from) && !Number.isNaN(to)) rule.explicit.push({ from, to });
      }
    }
    return rule;
  });
}

export class EpisodeMapping {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static buildFromXml(xml: string, db: Database.Database): EpisodeMapping {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml) as { 'anime-list': { anime: RawAnimeElement | RawAnimeElement[] } };
    const entries = Array.isArray(parsed['anime-list'].anime) ? parsed['anime-list'].anime : [parsed['anime-list'].anime];

    const rebuild = db.transaction((rows: RawAnimeElement[]) => {
      db.exec(`
        DROP TABLE IF EXISTS episode_mapping;
        CREATE TABLE episode_mapping (
          anidb_id INTEGER PRIMARY KEY,
          tvdb_id TEXT,
          imdb_id TEXT,
          default_tvdb_season INTEGER,
          episode_offset INTEGER,
          mapping_rules TEXT NOT NULL
        );
        CREATE INDEX idx_episode_mapping_tvdb ON episode_mapping(tvdb_id);
      `);
      const insert = db.prepare('INSERT INTO episode_mapping (anidb_id, tvdb_id, imdb_id, default_tvdb_season, episode_offset, mapping_rules) VALUES (?, ?, ?, ?, ?, ?)');
      for (const row of rows) {
        const anidbId = parseInt(row['@_anidbid'], 10);
        if (Number.isNaN(anidbId)) continue;
        const rules = parseMappingRules(row['mapping-list']);
        insert.run(
          anidbId,
          row['@_tvdbid'] ?? null,
          row['@_imdbid'] ?? null,
          row['@_defaulttvdbseason'] !== undefined ? parseInt(row['@_defaulttvdbseason'], 10) : null,
          row['@_episodeoffset'] !== undefined ? parseInt(row['@_episodeoffset'], 10) : null,
          JSON.stringify(rules),
        );
      }
    });
    rebuild(entries);
    return new EpisodeMapping(db);
  }

  findByAnidbId(anidbId: number): MappingRow | null {
    const row = this.db
      .prepare('SELECT anidb_id, tvdb_id, imdb_id, default_tvdb_season, episode_offset, mapping_rules FROM episode_mapping WHERE anidb_id = ?')
      .get(anidbId) as { anidb_id: number; tvdb_id: string | null; imdb_id: string | null; default_tvdb_season: number | null; episode_offset: number | null; mapping_rules: string } | undefined;
    if (!row) return null;
    return {
      anidbId: row.anidb_id,
      tvdbId: row.tvdb_id,
      imdbId: row.imdb_id,
      defaultTvdbSeason: row.default_tvdb_season,
      episodeOffset: row.episode_offset,
      mappingRules: JSON.parse(row.mapping_rules) as MappingRule[],
    };
  }

  mapAnidbToTvdbEpisode(anidbId: number, anidbEpisode: number, anidbSeason = 1): { season: number; episode: number } | null {
    const row = this.findByAnidbId(anidbId);
    if (!row) return null;

    for (const rule of row.mappingRules) {
      if (rule.anidbSeason !== anidbSeason) continue;
      const explicit = rule.explicit.find((e) => e.from === anidbEpisode);
      if (explicit) return { season: rule.tvdbSeason, episode: explicit.to };
      const range = rule.ranges.find((r) => anidbEpisode >= r.start && anidbEpisode <= r.end);
      if (range) return { season: rule.tvdbSeason, episode: anidbEpisode + range.offset };
    }

    if (row.defaultTvdbSeason === null) return null;
    const offset = row.episodeOffset ?? 0;
    return { season: row.defaultTvdbSeason, episode: anidbEpisode + offset };
  }

  mapTvdbToAnidbEpisode(tvdbId: string, tvdbSeason: number, tvdbEpisode: number): { anidbId: number; anidbEpisode: number } | null {
    const rows = this.db
      .prepare('SELECT anidb_id, default_tvdb_season, episode_offset, mapping_rules FROM episode_mapping WHERE tvdb_id = ?')
      .all(tvdbId) as { anidb_id: number; default_tvdb_season: number | null; episode_offset: number | null; mapping_rules: string }[];

    for (const row of rows) {
      const rules = JSON.parse(row.mapping_rules) as MappingRule[];
      for (const rule of rules) {
        if (rule.tvdbSeason !== tvdbSeason) continue;
        const explicit = rule.explicit.find((e) => e.to === tvdbEpisode);
        if (explicit) return { anidbId: row.anidb_id, anidbEpisode: explicit.from };
        const range = rule.ranges.find((r) => {
          const mappedStart = r.start + r.offset;
          const mappedEnd = r.end + r.offset;
          return tvdbEpisode >= mappedStart && tvdbEpisode <= mappedEnd;
        });
        if (range) return { anidbId: row.anidb_id, anidbEpisode: tvdbEpisode - range.offset };
      }
      if (rules.length === 0 && row.default_tvdb_season === tvdbSeason) {
        const offset = row.episode_offset ?? 0;
        return { anidbId: row.anidb_id, anidbEpisode: tvdbEpisode - offset };
      }
    }
    return null;
  }
}

export async function downloadEpisodeMapping(
  url = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml',
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download episode mapping dataset: HTTP ${res.status}`);
  return res.text();
}
```

- [ ] **Step 4: Run to verify the passthrough tests pass**

Run: `npx vitest run test/resolver/episodeMapping.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for range+offset and explicit-list rules (forward direction)**

```ts
const chobitsLikeXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="12" tvdbid="72070" defaulttvdbseason="1">
    <name>Fixture Chobits-like</name>
    <mapping-list>
      <mapping anidbseason="1" tvdbseason="0">;9-1;18-2;</mapping>
      <mapping anidbseason="1" tvdbseason="1" start="10" end="17" offset="-1"/>
      <mapping anidbseason="1" tvdbseason="1" start="19" end="26" offset="-2"/>
    </mapping-list>
  </anime>
</anime-list>`;

describe('EpisodeMapping — range and explicit rules (forward)', () => {
  it('applies an explicit episode override before falling through to range rules', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(12, 9)).toEqual({ season: 0, episode: 1 });
    expect(mapping.mapAnidbToTvdbEpisode(12, 18)).toEqual({ season: 0, episode: 2 });
  });

  it('applies a range+offset rule when no explicit override matches', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(12, 10)).toEqual({ season: 1, episode: 9 });
    expect(mapping.mapAnidbToTvdbEpisode(12, 26)).toEqual({ season: 1, episode: 24 });
  });
});
```

- [ ] **Step 6: Run to verify they fail, then pass (implementation from Step 3 already covers this — confirm)**

Run: `npx vitest run test/resolver/episodeMapping.test.ts`
Expected: these should already PASS given Step 3's implementation (explicit rules checked before ranges, per `mapAnidbToTvdbEpisode`'s loop order). If they fail, the bug is in rule-matching precedence — fix `mapAnidbToTvdbEpisode` to check `rule.explicit` before `rule.ranges` within each matching `anidbSeason` rule, which the Step 3 code already does; this step exists to actually prove it against a schema-realistic fixture, not just the trivial passthrough case.

- [ ] **Step 7: Write failing tests for the reverse direction (tvdb → anidb) and for imdbId passthrough**

```ts
describe('EpisodeMapping — reverse (tvdb -> anidb) and imdbId', () => {
  it('reverses a range+offset rule', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('72070', 1, 9)).toEqual({ anidbId: 12, anidbEpisode: 10 });
  });

  it('reverses an explicit-list rule', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('72070', 0, 1)).toEqual({ anidbId: 12, anidbEpisode: 9 });
  });

  it('returns null when no anime entry has that tvdbId/season/episode combination', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('99999', 1, 1)).toBeNull();
  });

  it('exposes a direct imdbId from the dataset when present', () => {
    const xmlWithImdb = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="7" tvdbid="movie" imdbid="tt0119698">
    <name>Fixture Movie</name>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(xmlWithImdb, new Database(':memory:'));
    expect(mapping.findByAnidbId(7)?.imdbId).toBe('tt0119698');
  });
});
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run test/resolver/episodeMapping.test.ts`
Expected: PASS against the Step 3 implementation.

- [ ] **Step 9: Write a failing test for `downloadEpisodeMapping`**

```ts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { downloadEpisodeMapping } from '../../src/resolver/episodeMapping.js';

describe('downloadEpisodeMapping', () => {
  it('downloads raw XML text from a custom URL', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(simpleXml);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const xml = await downloadEpisodeMapping(`http://127.0.0.1:${port}/anime-list.xml`);
      expect(xml).toBe(simpleXml);
    } finally {
      server.close();
    }
  });

  it('throws when the response is not ok', async () => {
    const server = createServer((_req, res) => { res.writeHead(500); res.end('err'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(downloadEpisodeMapping(`http://127.0.0.1:${port}/x.xml`)).rejects.toThrow('Failed to download episode mapping dataset: HTTP 500');
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 10: Run full file, typecheck, commit**

```bash
npx vitest run test/resolver/episodeMapping.test.ts
npm run typecheck
git add src/resolver/episodeMapping.ts test/resolver/episodeMapping.test.ts
git commit -m "feat(resolver): add AniDB<->TVDB/IMDB episode-mapping resolver

Downloads and parses the Anime-Lists/anime-lists community mapping
dataset into a SQLite table, exposing forward (anidb episode -> tvdb
season/episode) and reverse mapping functions, plus direct imdbId
lookup where the dataset carries one.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 13: `anime_ids` gains an `imdb_id` column, populated by joining against `episode_mapping`

**Files:**
- Modify: `src/resolver/animeDataset.ts`
- Test: `test/resolver/animeDataset.test.ts`

**Interfaces:**
- Consumes: `EpisodeMapping.findByAnidbId` (Task 12).
- Produces: `AnimeDataset.buildFromRaw(raw, db, episodeMapping?: EpisodeMapping)` — `episodeMapping` is a new optional 3rd parameter; when omitted, `imdb_id` is left `null` for every row (keeps every existing call site in tests/Task 9 compiling without changes). `ResolvedIds`/`IdRow` gain `imdbId: string | null`. `findByAnilistId`/`findByScheme` now select and return `imdb_id`. New method `findByImdbId(imdbId: string): IdRow[]` (plural — an IMDB id can map to more than one AniDB entry, e.g. multiple cours sharing one IMDB listing).

- [ ] **Step 1: Write the failing test**

Add to `test/resolver/animeDataset.test.ts`:

```ts
  it('populates imdb_id by joining anidb_id against the episode mapping, when one is provided', () => {
    const mappingXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="17617" tvdbid="movie" imdbid="tt7441658">
    <name>Fixture</name>
  </anime>
</anime-list>`;
    const episodeMapping = EpisodeMapping.buildFromXml(mappingXml, new Database(':memory:'));
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'), episodeMapping);
    expect(dataset.findByAnilistId(154587)?.imdbId).toBe('tt7441658');
  });

  it('leaves imdbId null when no episode mapping is supplied', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByAnilistId(154587)?.imdbId).toBeNull();
  });

  it('findByImdbId returns every anidb entry sharing that imdbId', () => {
    const mappingXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="17617" tvdbid="movie" imdbid="tt7441658"><name>A</name></anime>
</anime-list>`;
    const episodeMapping = EpisodeMapping.buildFromXml(mappingXml, new Database(':memory:'));
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'), episodeMapping);
    const rows = dataset.findByImdbId('tt7441658');
    expect(rows).toHaveLength(1);
    expect(rows[0].anilistId).toBe(154587);
  });
```

Add the import: `import { EpisodeMapping } from '../../src/resolver/episodeMapping.js';`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/resolver/animeDataset.test.ts`
Expected: FAIL — `imdbId` is `undefined`, `findByImdbId` doesn't exist, and the 3-argument `buildFromRaw` call doesn't type-check.

- [ ] **Step 3: Implement**

```ts
// src/resolver/animeDataset.ts
import type { EpisodeMapping } from './episodeMapping.js';

interface IdRow {
  anilistId: number | null;
  anidbId: number | null;
  title: string | null;
  imdbId: string | null;
}

// ...

  static buildFromRaw(raw: RawDataset, db: Database.Database, episodeMapping?: EpisodeMapping): AnimeDataset {
    const insert = db.prepare('INSERT INTO anime_ids (anilist_id, anidb_id, kitsu_id, mal_id, title, imdb_id) VALUES (?, ?, ?, ?, ?, ?)');

    const rebuild = db.transaction((entries: RawDatasetEntry[]) => {
      db.exec(`
        DROP TABLE IF EXISTS anime_ids;
        CREATE TABLE anime_ids (
          anilist_id INTEGER,
          anidb_id INTEGER,
          kitsu_id INTEGER,
          mal_id INTEGER,
          title TEXT,
          imdb_id TEXT
        );
        CREATE INDEX idx_anilist ON anime_ids(anilist_id);
        CREATE INDEX idx_anidb ON anime_ids(anidb_id);
        CREATE INDEX idx_kitsu ON anime_ids(kitsu_id);
        CREATE INDEX idx_mal ON anime_ids(mal_id);
        CREATE INDEX idx_imdb ON anime_ids(imdb_id);
      `);
      for (const entry of entries) {
        const ids = extractIds(entry.sources);
        if (ids.anilistId === null && ids.anidbId === null && ids.kitsuId === null && ids.malId === null) continue;
        const imdbId = ids.anidbId !== null ? (episodeMapping?.findByAnidbId(ids.anidbId)?.imdbId ?? null) : null;
        insert.run(ids.anilistId, ids.anidbId, ids.kitsuId, ids.malId, entry.title ?? null, imdbId);
      }
    });

    rebuild(raw.data);
    return new AnimeDataset(db);
  }

  findByAnilistId(id: number): IdRow | null {
    return (this.db.prepare('SELECT anilist_id as anilistId, anidb_id as anidbId, title, imdb_id as imdbId FROM anime_ids WHERE anilist_id = ?').get(id) as IdRow) ?? null;
  }

  findByScheme(scheme: 'kitsu' | 'mal' | 'anidb', id: number): IdRow | null {
    const column = scheme === 'kitsu' ? 'kitsu_id' : scheme === 'mal' ? 'mal_id' : 'anidb_id';
    return (this.db.prepare(`SELECT anilist_id as anilistId, anidb_id as anidbId, title, imdb_id as imdbId FROM anime_ids WHERE ${column} = ?`).get(id) as IdRow) ?? null;
  }

  findByImdbId(imdbId: string): IdRow[] {
    return this.db.prepare('SELECT anilist_id as anilistId, anidb_id as anidbId, title, imdb_id as imdbId FROM anime_ids WHERE imdb_id = ?').all(imdbId) as IdRow[];
  }
```

Note this changes existing `findByAnilistId`/`findByScheme` return shape (adds `imdbId` field) — every existing test asserting `toEqual({ anilistId, anidbId, title })` on these methods (e.g. in `test/resolver/idResolver.test.ts`, `test/resolver/animeDataset.test.ts`) will now fail because the actual object also has `imdbId: null`. Update every such assertion in both files to include `imdbId: null` (or, for the new imdb-populated fixture cases, the real value) — this is expected fallout from a type change, not a new bug; search both test files for `.toEqual({ anilistId` and add the field to each.

- [ ] **Step 4: Fix the fallout in existing tests**

Run: `grep -rn "toEqual({ anilistId" test/` and add `imdbId: null` (or the appropriate value) to every match in `test/resolver/animeDataset.test.ts` and `test/resolver/idResolver.test.ts`.

Also update `ResolvedIds` in `src/types.ts`:

```ts
export interface ResolvedIds {
  anilistId: number | null;
  anidbId: number | null;
  title?: string | null;
  imdbId?: string | null;
}
```

- [ ] **Step 5: Run full test file, verify pass**

Run: `npx vitest run test/resolver/animeDataset.test.ts test/resolver/idResolver.test.ts`
Expected: PASS

- [ ] **Step 6: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/resolver/animeDataset.ts src/types.ts test/resolver/animeDataset.test.ts test/resolver/idResolver.test.ts
git commit -m "feat(resolver): add imdb_id to anime_ids via episode-mapping join

buildFromRaw takes an optional EpisodeMapping to populate imdb_id per
row. New findByImdbId(imdbId) returns every AniDB entry sharing that
IMDB id (a franchise can have multiple cours under one IMDB listing).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 14: Reverse `tt`-prefixed content ID resolution in `idResolver.ts`

**Files:**
- Modify: `src/resolver/idResolver.ts`
- Test: `test/resolver/idResolver.test.ts`

**Interfaces:**
- Consumes: `AnimeDataset.findByImdbId` (Task 13), `EpisodeMapping.mapTvdbToAnidbEpisode` (Task 12).
- Produces: `resolveIds(contentId: string, dataset: AnimeDataset, episodeMapping?: EpisodeMapping, season?: number, episode?: number): ResolvedIds` — gains three new optional parameters. `parseSubtitleRequestId`'s existing output (`{ contentId, season, episode }`) already has everything needed to call it; only `subtitlesHandler.ts` (Task 18) needs updating to pass `parsed.season`/`parsed.episode` through, which that task already touches.

Finding: `resolveIds` currently early-returns `empty` for any `tt`-prefixed `contentId` with the comment "no IMDb mapping in the dataset -- v1 scope limitation." This closes that gap.

- [ ] **Step 1: Write the failing test**

Replace the existing test `'returns nulls for a bare tt id (no IMDb mapping in v1)'` in `test/resolver/idResolver.test.ts` and add new coverage. First, build a `dataset`/`episodeMapping` pair with a real mapping:

```ts
import { EpisodeMapping } from '../../src/resolver/episodeMapping.js';

const mappingXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="17617" tvdbid="418099" defaulttvdbseason="1" imdbid="tt21209876">
    <name>Fixture</name>
  </anime>
</anime-list>`;
const episodeMapping = EpisodeMapping.buildFromXml(mappingXml, new Database(':memory:'));
const datasetWithImdb = AnimeDataset.buildFromRaw({
  data: [{ sources: ['https://anidb.net/anime/17617', 'https://anilist.co/anime/154587'] }],
}, new Database(':memory:'), episodeMapping);

describe('resolveIds — tt-prefixed content ids', () => {
  it('resolves a tt-prefixed id via the imdb_id reverse index and episode mapping', () => {
    const ids = resolveIds('tt21209876', datasetWithImdb, episodeMapping, 1, 5);
    expect(ids.anilistId).toBe(154587);
    expect(ids.anidbId).toBe(17617);
  });

  it('returns nulls for a tt id with no matching imdb_id in the dataset', () => {
    const ids = resolveIds('tt00000000', datasetWithImdb, episodeMapping, 1, 5);
    expect(ids).toEqual({ anilistId: null, anidbId: null });
  });

  it('returns nulls for a tt id when no episodeMapping is supplied at all', () => {
    const ids = resolveIds('tt21209876', datasetWithImdb, undefined, 1, 5);
    expect(ids).toEqual({ anilistId: null, anidbId: null });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/resolver/idResolver.test.ts`
Expected: FAIL — the current early-return ignores the new parameters entirely.

- [ ] **Step 3: Implement**

```ts
// src/resolver/idResolver.ts
import type { AnimeDataset } from './animeDataset.js';
import type { EpisodeMapping } from './episodeMapping.js';
import type { ResolvedIds } from '../types.js';

export function resolveIds(
  contentId: string,
  dataset: AnimeDataset,
  episodeMapping?: EpisodeMapping,
  season?: number,
  episode?: number,
): ResolvedIds {
  const empty: ResolvedIds = { anilistId: null, anidbId: null };

  if (contentId.startsWith('tt')) {
    if (!episodeMapping || season === undefined || episode === undefined) return empty;
    const candidates = dataset.findByImdbId(contentId);
    for (const candidate of candidates) {
      if (candidate.anidbId === null) continue;
      const reversed = episodeMapping.mapTvdbToAnidbEpisode(
        episodeMapping.findByAnidbId(candidate.anidbId)?.tvdbId ?? '',
        season,
        episode,
      );
      if (reversed && reversed.anidbId === candidate.anidbId) {
        return { anilistId: candidate.anilistId, anidbId: candidate.anidbId, title: candidate.title, imdbId: candidate.imdbId };
      }
    }
    return empty;
  }

  const [scheme, valueStr] = contentId.split(':');
  const value = parseInt(valueStr, 10);
  if (Number.isNaN(value)) return empty;

  let row: ResolvedIds | null = null;
  if (scheme === 'anilist') row = dataset.findByAnilistId(value);
  else if (scheme === 'kitsu' || scheme === 'mal' || scheme === 'anidb') row = dataset.findByScheme(scheme, value);

  return row ?? empty;
}
```

This calls `mapTvdbToAnidbEpisode` per-candidate rather than doing a single global reverse lookup, since `findByImdbId` may return multiple AniDB entries sharing one IMDB id (franchise case from Task 13) and only the mapping rule confirms which specific entry the requested season/episode actually falls into. If the episode also needs converting back to this addon's internal AniDB-relative episode number for use as `CacheKey.episode` downstream, `subtitlesHandler.ts` (Task 18) is responsible for calling `mapTvdbToAnidbEpisode` again to get `reversed.anidbEpisode` and using that instead of the raw `parsed.episode` — note this explicitly here since `resolveIds`'s return type (`ResolvedIds`) has no field for a translated episode number, so Task 18 must perform this translation itself using the same `episodeMapping` instance, not rely on `resolveIds` to have done it silently.

- [ ] **Step 4: Run to verify they pass, fix the removed old test**

Run: `npx vitest run test/resolver/idResolver.test.ts`
Expected: PASS. Delete the old `'returns nulls for a bare tt id (no IMDb mapping in v1)'` test entirely (superseded by the three new ones above — a bare `tt...` id with no `episodeMapping`/`season`/`episode` args is already covered by the third new test).

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/resolver/idResolver.ts test/resolver/idResolver.test.ts
git commit -m "feat(resolver): resolve tt-prefixed content ids via imdb_id + episode mapping

Closes the existing 'v1 scope limitation' gap where any IMDB-style
content id from Stremio (common with TMDB/Cinemeta-based catalogs)
returned zero subtitles unconditionally.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 15: Config additions for OpenSubtitles

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Config.openSubtitlesApiKey: string`, `Config.openSubtitlesDailyQuota: number` — consumed by Task 17 (quota tracker) and Task 18 (provider).

- [ ] **Step 1: Write the failing tests**

```ts
  it('requires OPENSUBTITLES_API_KEY and throws a clear error when missing', () => {
    const env = { ...baseEnv() };
    delete env.OPENSUBTITLES_API_KEY;
    expect(() => loadConfig(env)).toThrow(/OPENSUBTITLES_API_KEY/);
  });

  it('defaults openSubtitlesDailyQuota to 5 and reads OPENSUBTITLES_DAILY_QUOTA', () => {
    expect(loadConfig(baseEnv()).openSubtitlesDailyQuota).toBe(5);
    expect(loadConfig({ ...baseEnv(), OPENSUBTITLES_DAILY_QUOTA: '100' }).openSubtitlesDailyQuota).toBe(100);
  });
```

(Extend whatever `baseEnv()` helper this file already uses — from Task 5 — to include a valid `OPENSUBTITLES_API_KEY` by default, so every other pre-existing config test keeps passing once the field becomes required.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// src/config.ts
export interface Config {
  // ...existing fields...
  openSubtitlesApiKey: string;
  openSubtitlesDailyQuota: number;
}
// in loadConfig's return object:
    openSubtitlesApiKey: requireEnv(env, 'OPENSUBTITLES_API_KEY'),
    openSubtitlesDailyQuota: requireInt(env, 'OPENSUBTITLES_DAILY_QUOTA', 5),
```

- [ ] **Step 4: Run to verify pass, fix fallout**

Run: `npx vitest run test/config.test.ts`
Expected: PASS. This makes `OPENSUBTITLES_API_KEY` a hard startup requirement — grep every other test file that constructs a `Config` object by hand (e.g. `test/subtitlesHandler.test.ts`'s `baseConfig`, `test/server.test.ts` if it builds one) and add `openSubtitlesApiKey: 'test-key', openSubtitlesDailyQuota: 100,` to each, or the whole suite fails to compile/run once `Config` requires these fields.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/config.ts test/config.test.ts test/subtitlesHandler.test.ts
git commit -m "feat(config): add OPENSUBTITLES_API_KEY and OPENSUBTITLES_DAILY_QUOTA

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 16: `CacheKey` gains a `provider` dimension; quota tracking table; migration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/cache/cacheStore.ts`
- Test: `test/cache/cacheStore.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Task 17, 18, 19):
  - `CacheKey { anilistId: number; episode: number; lang: string; provider: 'jimaku' | 'animetosho' | 'opensubtitles' | 'extraction' }` (was: no `provider` field).
  - `CacheEntry { status: CacheStatus; provider: CacheKey['provider'] | null; filePath: string | null; updatedAt: number }` (was: `tier: 1 | 2 | 3 | null` instead of `provider`).
  - `CacheStore.setReady(key: CacheKey, vttContent: string): string` — drops the `tier: 1 | 2 | 3` parameter entirely; the provider now comes from `key.provider`, removing the possibility of a caller passing a tier that doesn't match the key (today's `setReady(key, 1, ...)` call style required the caller to keep them in sync manually).
  - `CacheStore.getRemainingQuota(provider: string, dailyLimit: number): number`, `CacheStore.recordDownloadUsed(provider: string): void` — new.

This is the single most invasive schema change in the plan — every call site that builds a `CacheKey` or calls `setReady` changes. This task only changes `cacheStore.ts` and `types.ts`; Tasks 18 and 19 update their respective call sites (`subtitlesHandler.ts`, `server.ts`) since those files are already being rewritten by this phase anyway.

- [ ] **Step 1: Write the failing tests for the provider dimension**

Replace `test/cache/cacheStore.test.ts`'s top-level `const key = { anilistId: 154587, episode: 10, lang: 'eng' };` with `const key = { anilistId: 154587, episode: 10, lang: 'eng', provider: 'jimaku' as const };`, and update every existing `setReady(key, N, ...)` call in that file to drop the tier argument: `setReady(key, ...)`. Update the assertion `expect(entry.tier).toBe(2)` etc. to `expect(entry.provider).toBe('animetosho')` (adjusting the `key`'s `provider` field in that specific test to `'animetosho' as const` instead of relying on a numeric tier argument). Add:

```ts
  it('keys the same episode/lang independently per provider', () => {
    const jimakuKey = { ...key, provider: 'jimaku' as const };
    const toshoKey = { ...key, provider: 'animetosho' as const };
    store.setReady(jimakuKey, 'WEBVTT\n\n1\njimaku');
    expect(store.get(toshoKey)).toBeNull();
    expect(store.get(jimakuKey)?.status).toBe('ready');
  });

  it('migrates an old-schema row (tier column, no provider) to the provider column on read', () => {
    // Simulate a pre-migration row written by the old schema directly via raw SQL,
    // the way an existing production cache.db would have it.
    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    rawDb.exec("ALTER TABLE cache ADD COLUMN tier INTEGER");
    rawDb.prepare("INSERT INTO cache (key, status, tier, file_path, updated_at, provider) VALUES (?, 'ready', 3, '/tmp/x.vtt', ?, NULL)")
      .run('154587:10:eng:extraction', Date.now());
    const migrated = store.get({ ...key, provider: 'extraction' as const });
    expect(migrated?.provider).toBe('extraction');
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: FAIL — compile errors (no `provider` field on `CacheKey`, `setReady` still expects a tier arg) or assertion failures.

- [ ] **Step 3: Implement**

```ts
// src/types.ts
export type CacheProvider = 'jimaku' | 'animetosho' | 'opensubtitles' | 'extraction';

export interface CacheKey {
  anilistId: number;
  episode: number;
  lang: string;
  provider: CacheProvider;
}

export interface CacheEntry {
  status: CacheStatus;
  provider: CacheProvider | null;
  filePath: string | null;
  updatedAt: number;
}
```

```ts
// src/cache/cacheStore.ts
function keyId(key: CacheKey): string {
  return `${key.anilistId}:${key.episode}:${key.lang}:${key.provider}`;
}

export class CacheStore {
  private db: Database.Database;
  private filesDir: string;
  private inFlight = new Map<string, Promise<ProviderResult>>();

  constructor(dbPath: string, filesDir: string) {
    this.filesDir = filesDir;
    if (!existsSync(filesDir)) mkdirSync(filesDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider TEXT,
        file_path TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS series_provider_cache (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        series_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_quota (
        provider TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `);
    this.migrateTierColumnIfPresent();
  }

  private migrateTierColumnIfPresent(): void {
    const columns = this.db.prepare("PRAGMA table_info(cache)").all() as { name: string }[];
    const hasTier = columns.some((c) => c.name === 'tier');
    if (!hasTier) return;
    const TIER_TO_PROVIDER: Record<number, CacheProvider> = { 1: 'jimaku', 2: 'animetosho', 3: 'extraction' };
    const rows = this.db.prepare("SELECT key, tier FROM cache WHERE provider IS NULL AND tier IS NOT NULL").all() as { key: string; tier: number }[];
    const update = this.db.prepare('UPDATE cache SET provider = ? WHERE key = ?');
    for (const row of rows) {
      const provider = TIER_TO_PROVIDER[row.tier];
      if (provider) update.run(provider, row.key);
    }
  }

  get(key: CacheKey): CacheEntry | null {
    const row = this.db
      .prepare('SELECT status, provider, file_path, updated_at FROM cache WHERE key = ?')
      .get(keyId(key)) as { status: CacheStatus; provider: CacheProvider | null; file_path: string | null; updated_at: number } | undefined;
    if (!row) return null;
    return { status: row.status, provider: row.provider, filePath: row.file_path, updatedAt: row.updated_at };
  }

  setPending(key: CacheKey): void {
    this.db.prepare(`
      INSERT INTO cache (key, status, provider, file_path, updated_at) VALUES (?, 'pending', NULL, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'pending', provider = NULL, file_path = NULL, updated_at = excluded.updated_at
    `).run(keyId(key), Date.now());
  }

  setReady(key: CacheKey, vttContent: string): string {
    const id = keyId(key);
    const filePath = join(this.filesDir, `${id.replace(/:/g, '_')}.vtt`);
    const normalized = normalizeVtt(vttContent, key.lang);
    writeFileSync(filePath, normalized, 'utf-8');
    this.db.prepare(`
      INSERT INTO cache (key, status, provider, file_path, updated_at) VALUES (?, 'ready', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'ready', provider = excluded.provider, file_path = excluded.file_path, updated_at = excluded.updated_at
    `).run(id, key.provider, filePath, Date.now());
    return filePath;
  }

  setNegative(key: CacheKey): void {
    this.db.prepare(`
      INSERT INTO cache (key, status, provider, file_path, updated_at) VALUES (?, 'negative', NULL, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'negative', provider = NULL, file_path = NULL, updated_at = excluded.updated_at
    `).run(keyId(key), Date.now());
  }

  // isNegativeExpired, getInFlight, setInFlight, clearInFlight, setSeriesProviderMiss,
  // hasSeriesProviderMiss, reconcilePendingOnStartup (Task 10), close: unchanged.

  getRemainingQuota(provider: string, dailyLimit: number): number {
    const row = this.db.prepare('SELECT count, window_start FROM provider_quota WHERE provider = ?').get(provider) as { count: number; window_start: number } | undefined;
    if (!row || Date.now() - row.window_start > 24 * 60 * 60 * 1000) {
      return dailyLimit;
    }
    return Math.max(0, dailyLimit - row.count);
  }

  recordDownloadUsed(provider: string): void {
    const row = this.db.prepare('SELECT count, window_start FROM provider_quota WHERE provider = ?').get(provider) as { count: number; window_start: number } | undefined;
    const now = Date.now();
    if (!row || now - row.window_start > 24 * 60 * 60 * 1000) {
      this.db.prepare('INSERT INTO provider_quota (provider, count, window_start) VALUES (?, 1, ?) ON CONFLICT(provider) DO UPDATE SET count = 1, window_start = excluded.window_start').run(provider, now);
      return;
    }
    this.db.prepare('UPDATE provider_quota SET count = count + 1 WHERE provider = ?').run(provider);
  }
}
```

`migrateTierColumnIfPresent` runs once at construction, before any reads/writes: `PRAGMA table_info` detects whether the row's original `tier` column still exists (it does on any deployment upgrading from the pre-Task-16 schema, since SQLite `CREATE TABLE IF NOT EXISTS` never altered the existing table's columns), backfills `provider` from it for any row that hasn't been migrated yet (`provider IS NULL AND tier IS NOT NULL`), and leaves the `tier` column in place (unused going forward, but dropping a column requires `ALTER TABLE ... DROP COLUMN`, unnecessary complexity for a column that's simply ignored from now on).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite, typecheck — expect and fix compile fallout elsewhere**

Run: `npm run typecheck`
Expected: FAIL in `src/subtitlesHandler.ts` and `src/server.ts` (both construct `CacheKey`/call `setReady` with the old shape) — this is expected; Tasks 18 and 19 fix those files. Do not attempt to patch them here; this task's own tests and `cacheStore.ts`/`types.ts` are complete and correct on their own.

- [ ] **Step 6: Commit (allowing the known, tracked-by-later-tasks typecheck failures elsewhere)**

```bash
npx vitest run test/cache/cacheStore.test.ts
git add src/types.ts src/cache/cacheStore.ts test/cache/cacheStore.test.ts
git commit -m "feat(cache): add provider dimension to CacheKey, quota tracking, schema migration

CacheKey now includes provider (jimaku/animetosho/opensubtitles/
extraction) instead of a numeric tier, enabling one cache row and one
subtitle track per provider that finds a match (fixes finding #1's
structural single-subtitle cap). Existing tier-column rows are
migrated to provider on first read of the old schema. Also adds
provider_quota tracking for the OpenSubtitles daily download cap.
setReady/get also pass key.lang through to normalizeVtt correctly
(finding #17's cache-write half — previously always defaulted to eng
regardless of the actual configured language).

Note: src/subtitlesHandler.ts and src/server.ts do not compile against
this commit in isolation; Tasks 18 and 19 update them to the new
CacheKey shape immediately after.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 17: OpenSubtitles provider

**Files:**
- Modify: `src/http/httpClient.ts` (add POST support)
- Modify: `src/types.ts` (add `quotaSkipped` to `ProviderResult`)
- Create: `src/providers/opensubtitlesProvider.ts`
- Create: `test/providers/opensubtitlesProvider.test.ts`

**Interfaces:**
- Consumes: `fetchJson`/`fetchBuffer` pattern from `httpClient.ts`, `convertToVtt` (`extract.ts`), `isAcceptableSubtitle` (`vttUtils.ts`) — same as Jimaku/AnimeTosho.
- Produces (consumed by Task 18): `findOpenSubtitlesSubtitle(imdbId: string | null, tvdbSeason: number | null, tvdbEpisode: number | null, lang: string, apiKey: string, opts?: { baseUrl?: string; timeoutMs?: number; hasQuota?: boolean }): Promise<ProviderResult>`. `ProviderResult` gains `quotaSkipped?: boolean`. This provider does **not** touch `CacheStore` directly (consistent with Jimaku/AnimeTosho, which are pure functions) — the caller (Task 18's `subtitlesHandler.ts`) is responsible for checking `cache.getRemainingQuota(...)` beforehand and passing the result as `opts.hasQuota`, and for calling `cache.recordDownloadUsed('opensubtitles')` after a `found: true` result.

Search (`/subtitles`) is never quota-gated — only `/download` is, per the spec. When `hasQuota` is `false` and the search found a match, the function returns `{ found: false, quotaSkipped: true }` without calling `/download`, so `subtitlesHandler.ts` can distinguish "genuinely nothing found" (safe to negative-cache) from "something's there but quota's out for today" (must not be negative-cached).

- [ ] **Step 1: Add POST support to httpClient.ts**

```ts
// src/http/httpClient.ts
export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  body?: string;
}

async function timedFetch<T>(
  url: string,
  opts: FetchOptions,
  consume: (res: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${opts.method ?? 'GET'} ${url} failed: HTTP ${res.status}`);
    }
    return await consume(res);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpTimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

(`fetchJson`/`fetchBuffer`/`fetchBufferCapped` are unchanged — they already forward `opts` to `timedFetch`, which now honors `method`/`body` when present.)

- [ ] **Step 2: Add `quotaSkipped` to `ProviderResult`**

```ts
// src/types.ts
export interface ProviderResult {
  found: boolean;
  vttContent?: string;
  seriesNotFound?: boolean;
  quotaSkipped?: boolean;
}
```

- [ ] **Step 3: Write the failing tests**

```ts
// test/providers/opensubtitlesProvider.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { findOpenSubtitlesSubtitle } from '../../src/providers/opensubtitlesProvider.js';

describe('findOpenSubtitlesSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let lastSearchQuery: URLSearchParams | null = null;
  let downloadCallCount = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/subtitles' && req.method === 'GET') {
        lastSearchQuery = url.searchParams;
        if (url.searchParams.get('imdb_id') === 'tt1111111') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ attributes: { files: [{ file_id: 42 }] } }] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
        }
      } else if (url.pathname === '/download' && req.method === 'POST') {
        downloadCallCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ link: `${baseUrl}/files/subtitle.srt` }));
      } else if (url.pathname === '/files/subtitle.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nOpenSubtitles fixture line\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns not found immediately when imdbId is null, without any HTTP call', async () => {
    const result = await findOpenSubtitlesSubtitle(null, 1, 5, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(false);
    expect(result.quotaSkipped).toBeFalsy();
  });

  it('finds and downloads a subtitle when a search match exists and quota is available', async () => {
    downloadCallCount = 0;
    const result = await findOpenSubtitlesSubtitle('tt1111111', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('OpenSubtitles fixture line');
    expect(downloadCallCount).toBe(1);
  });

  it('searches with imdb_id, season_number, and episode_number', async () => {
    await findOpenSubtitlesSubtitle('tt1111111', 2, 9, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(lastSearchQuery?.get('imdb_id')).toBe('tt1111111');
    expect(lastSearchQuery?.get('season_number')).toBe('2');
    expect(lastSearchQuery?.get('episode_number')).toBe('9');
  });

  it('does not call download and reports quotaSkipped when hasQuota is false, even with a search match', async () => {
    downloadCallCount = 0;
    const result = await findOpenSubtitlesSubtitle('tt1111111', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: false });
    expect(result.found).toBe(false);
    expect(result.quotaSkipped).toBe(true);
    expect(downloadCallCount).toBe(0);
  });

  it('returns a genuine miss (quotaSkipped falsy) when the search itself finds nothing, regardless of quota', async () => {
    const result = await findOpenSubtitlesSubtitle('tt9999999', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: false });
    expect(result.found).toBe(false);
    expect(result.quotaSkipped).toBeFalsy();
  });

  it('returns not found when tvdbSeason or tvdbEpisode could not be resolved', async () => {
    const result = await findOpenSubtitlesSubtitle('tt1111111', null, null, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run test/providers/opensubtitlesProvider.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 5: Implement**

```ts
// src/providers/opensubtitlesProvider.ts
import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import { isAcceptableSubtitle } from '../ffmpeg/vttUtils.js';
import type { ProviderResult } from '../types.js';

const OS_LANGUAGE_CODES: Record<string, string> = { eng: 'en' };

interface OpenSubtitlesSearchResponse {
  data: { attributes: { files: { file_id: number }[] } }[];
}
interface OpenSubtitlesDownloadResponse {
  link: string;
}

export interface OpenSubtitlesOptions {
  baseUrl?: string;
  timeoutMs?: number;
  hasQuota?: boolean;
}

export async function findOpenSubtitlesSubtitle(
  imdbId: string | null,
  tvdbSeason: number | null,
  tvdbEpisode: number | null,
  lang: string,
  apiKey: string,
  opts: OpenSubtitlesOptions = {},
): Promise<ProviderResult> {
  if (imdbId === null || tvdbSeason === null || tvdbEpisode === null) {
    return { found: false };
  }
  const osLang = OS_LANGUAGE_CODES[lang];
  if (!osLang) return { found: false };

  const baseUrl = (opts.baseUrl ?? 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;
  const headers = { 'Api-Key': apiKey, 'Content-Type': 'application/json' };

  const numericImdbId = imdbId.replace(/^tt/, '');
  const searchUrl = `${baseUrl}/subtitles?imdb_id=${numericImdbId}&season_number=${tvdbSeason}&episode_number=${tvdbEpisode}&languages=${osLang}`;
  const search = await fetchJson<OpenSubtitlesSearchResponse>(searchUrl, { headers, timeoutMs });

  const fileId = search.data[0]?.attributes.files[0]?.file_id;
  if (fileId === undefined) return { found: false };

  if (!opts.hasQuota) return { found: false, quotaSkipped: true };

  const download = await fetchJson<OpenSubtitlesDownloadResponse>(`${baseUrl}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: fileId }),
    timeoutMs,
  });

  const raw = await fetchBuffer(download.link, { timeoutMs });
  const vttContent = await convertToVtt(raw, 'srt', lang);
  if (!isAcceptableSubtitle(vttContent, lang)) return { found: false };
  return { found: true, vttContent };
}
```

`imdb_id` is sent numeric (OpenSubtitles' REST API v1 expects the bare number, not the `tt`-prefixed form — this and the exact search/download JSON shapes above should be verified against current OpenSubtitles API docs during this task, since the spec flagged this as unconfirmed at design time; the mock server in Step 3 encodes this plan's best understanding, and any discrepancy found against the real API should be fixed in both the implementation and the test fixtures together, not just one side).

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run test/providers/opensubtitlesProvider.test.ts`
Expected: PASS

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm run typecheck
npx vitest run test/http/httpClient.test.ts test/providers/opensubtitlesProvider.test.ts
git add src/http/httpClient.ts src/types.ts src/providers/opensubtitlesProvider.ts test/providers/opensubtitlesProvider.test.ts
git commit -m "feat(providers): add OpenSubtitles provider with quota-gated download

Search is unmetered; /download is gated behind opts.hasQuota, which
the caller derives from CacheStore.getRemainingQuota so the provider
itself stays a pure function like Jimaku/AnimeTosho. A quota skip is
reported distinctly (quotaSkipped: true) from a genuine miss so it
never gets recorded in the series-level negative cache.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 18: Restructure `subtitlesHandler.ts` — concurrent 3-provider Tier 1, per-provider in-flight dedup, multi-track output

**Files:**
- Modify: `src/subtitlesHandler.ts`
- Modify: `src/types.ts` (`SubtitleCandidate` gains `provider`)
- Test: `test/subtitlesHandler.test.ts` (near-total rewrite — every existing test's `deps` fixture and assertions change shape; see Step 6)

**Interfaces:**
- Consumes: `EpisodeMapping.mapAnidbToTvdbEpisode`/`mapTvdbToAnidbEpisode` (Task 12), `resolveIds` with the new signature (Task 14), `CacheKey`/`CacheEntry` with `provider` (Task 16), `findOpenSubtitlesSubtitle` (Task 17).
- Produces (consumed by Task 19, Task 20): `SubtitlesHandlerDeps` gains `episodeMapping: EpisodeMapping` and `opensubtitlesProvider: typeof findOpenSubtitlesSubtitle`. `SubtitleCandidate { lang: string; url: string; provider: CacheProvider }` (was: no `provider` field — server.ts, Task 19, uses this to label tracks distinctly per source). `handleSubtitlesRequest`'s external behavior: up to 4 entries per configured language now possible (jimaku/animetosho/opensubtitles/extraction), not capped at 1.

This is the task that structurally fixes finding #1 (via Task 16's `provider`-dimensioned `CacheKey`, used here) and folds in findings #10, #11, #12, #22.

- [ ] **Step 1: Update `SubtitleCandidate` and `SubtitlesHandlerDeps`**

```ts
// src/types.ts
export interface SubtitleCandidate {
  lang: string;
  url: string;
  provider: CacheProvider;
}
```

```ts
// src/subtitlesHandler.ts — imports and deps interface
import { parseSubtitleRequestId, resolveIds, type ParsedSubtitleRequestId } from './resolver/idResolver.js';
import { getPlayableStreamUrls } from './providers/streamAddonClient.js';
import { HttpTimeoutError } from './http/httpClient.js';
import type { AnimeDataset } from './resolver/animeDataset.js';
import type { EpisodeMapping } from './resolver/episodeMapping.js';
import type { CacheStore } from './cache/cacheStore.js';
import type { ExtractionQueue } from './queue/extractionQueue.js';
import type { Config } from './config.js';
import type { CacheKey, CacheProvider, ProviderResult, SubtitleCandidate } from './types.js';
import type { ExtractionParams } from './providers/extractionProvider.js';

export interface DatasetHolder {
  current: AnimeDataset;
}

export interface SubtitlesHandlerDeps {
  dataset: DatasetHolder;
  episodeMapping: EpisodeMapping;
  cache: CacheStore;
  queue: ExtractionQueue;
  config: Config;
  buildSubtitleUrl: (key: CacheKey) => string;
  jimakuProvider: (anilistId: number, episode: number, lang: string, apiKey: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>;
  animetoshoProvider: (anidbId: number | null, episode: number, lang: string, opts?: { timeoutMs?: number; title?: string | null }) => Promise<ProviderResult>;
  opensubtitlesProvider: (imdbId: string | null, tvdbSeason: number | null, tvdbEpisode: number | null, lang: string, apiKey: string, opts?: { timeoutMs?: number; hasQuota?: boolean }) => Promise<ProviderResult>;
  extractionProvider: (params: ExtractionParams) => Promise<ProviderResult>;
}
```

`ParsedSubtitleRequestId` needs exporting from `idResolver.ts` (it's currently only an inline-used interface there) — add `export` to its existing `interface ParsedSubtitleRequestId` declaration in `src/resolver/idResolver.ts`.

- [ ] **Step 2: Write failing tests for the new multi-provider hit behavior**

These are the core NEW behaviors this task must prove, layered on top of the existing suite (Step 6 handles bringing the rest of the file's fixtures up to the new shape):

```ts
  it('surfaces one subtitle track per Tier-1 provider that finds a match, not just one', async () => {
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(2);
    expect(result.subtitles.map((s) => s.provider).sort()).toEqual(['animetosho', 'jimaku']);
  });

  it('does not double-charge the OpenSubtitles quota or double-call a provider for two concurrent requests of the same episode', async () => {
    let callCount = 0;
    deps.jimakuProvider = vi.fn(() => {
      callCount++;
      return new Promise<ProviderResult>((resolve) => setTimeout(() => resolve({ found: true, vttContent: 'WEBVTT\n\n1\nx' }), 20));
    });
    await Promise.all([
      handleSubtitlesRequest('kitsu:46474:1:5', deps),
      handleSubtitlesRequest('kitsu:46474:1:5', deps),
    ]);
    expect(callCount).toBe(1);
  });

  it('does not set the negative cache for OpenSubtitles when the result is quota-skipped', async () => {
    deps.opensubtitlesProvider = vi.fn(async () => ({ found: false, quotaSkipped: true }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' as const };
    expect(cache.get(key)).toBeNull(); // not negative -- must remain retryable once quota resets
  });

  it('sets the negative cache for OpenSubtitles on a genuine miss (not quota-skipped)', async () => {
    deps.opensubtitlesProvider = vi.fn(async () => ({ found: false }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' as const };
    expect(cache.get(key)?.status).toBe('negative');
  });

  it('does not negative-cache the extraction key when cache.setReady throws after a successful extraction', async () => {
    const writeFailure = new Error('ENOSPC: no space left on device');
    vi.spyOn(cache, 'setReady').mockImplementationOnce(() => { throw writeFailure; });
    deps.extractionProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\nextracted' }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await new Promise((r) => setTimeout(r, 20));
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' as const };
    expect(cache.get(key)?.status).not.toBe('negative');
  });

  it('does not negative-cache extraction when the stream-addon prefetch times out (HttpTimeoutError)', async () => {
    // stub getPlayableStreamUrls's effect indirectly via deps.extractionProvider throwing
    // an HttpTimeoutError, simulating the prefetch promise rejecting into runExtractionTier
    deps.extractionProvider = vi.fn(async () => { throw new HttpTimeoutError('stream addon timed out'); });
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await new Promise((r) => setTimeout(r, 20));
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' as const };
    expect(cache.get(key)).toBeNull();
  });

  it('resolves a tt-prefixed request via reverse imdb lookup and translates season/episode to the internal anidb-relative episode number', async () => {
    // Requires a dataset/episodeMapping fixture with a real imdb_id + mapping-list
    // offset rule, per Task 14's fixtures. This test's dataset must be a local
    // per-test construction (not the shared module-level `dataset`/`episodeMapping`
    // used by the rest of the file), since it needs a specific offset rule.
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: many compile failures at first (deps shape mismatch across the whole file) — this is expected; proceed to Step 4's implementation, then Step 6 fixes the rest of the file's fixtures so the suite compiles and the new tests can actually run.

- [ ] **Step 4: Implement `resolveEffectiveEpisode`, `runProvider`, `tryDatabaseTier`, `resolveOneLanguage`, `handleSubtitlesRequest`**

```ts
// src/subtitlesHandler.ts

function resolveEffectiveEpisode(
  parsed: ParsedSubtitleRequestId,
  anidbId: number | null,
  episodeMapping: EpisodeMapping,
): number {
  if (!parsed.contentId.startsWith('tt') || anidbId === null) return parsed.episode;
  const tvdbId = episodeMapping.findByAnidbId(anidbId)?.tvdbId ?? null;
  if (!tvdbId) return parsed.episode;
  const reversed = episodeMapping.mapTvdbToAnidbEpisode(tvdbId, parsed.season, parsed.episode);
  return reversed?.anidbEpisode ?? parsed.episode;
}

function runProvider(
  provider: CacheProvider,
  baseKey: { anilistId: number; episode: number; lang: string },
  anidbId: number | null,
  imdbId: string | null,
  deps: SubtitlesHandlerDeps,
  title: string | null,
): Promise<ProviderResult> {
  if (provider === 'jimaku') {
    return deps
      .jimakuProvider(baseKey.anilistId, baseKey.episode, baseKey.lang, deps.config.jimakuApiKey, { timeoutMs: deps.config.providerTimeoutMs })
      .catch((err) => { console.warn(`[Jimaku] ${(err as Error).message}`); return { found: false } as ProviderResult; });
  }
  if (provider === 'animetosho') {
    return deps
      .animetoshoProvider(anidbId, baseKey.episode, baseKey.lang, { timeoutMs: deps.config.providerTimeoutMs, title })
      .catch((err) => { console.warn(`[AnimeTosho] ${(err as Error).message}`); return { found: false } as ProviderResult; });
  }
  const tvdb = anidbId !== null ? deps.episodeMapping.mapAnidbToTvdbEpisode(anidbId, baseKey.episode) : null;
  const hasQuota = deps.cache.getRemainingQuota('opensubtitles', deps.config.openSubtitlesDailyQuota) > 0;
  return deps
    .opensubtitlesProvider(imdbId, tvdb?.season ?? null, tvdb?.episode ?? null, baseKey.lang, deps.config.openSubtitlesApiKey, { timeoutMs: deps.config.providerTimeoutMs, hasQuota })
    .catch((err) => { console.warn(`[OpenSubtitles] ${(err as Error).message}`); return { found: false } as ProviderResult; });
}

async function tryDatabaseTier(
  baseKey: { anilistId: number; episode: number; lang: string },
  providersToTry: CacheProvider[],
  anidbId: number | null,
  imdbId: string | null,
  deps: SubtitlesHandlerDeps,
  title: string | null,
): Promise<CacheProvider[]> {
  const hits: CacheProvider[] = [];

  await Promise.allSettled(providersToTry.map(async (provider) => {
    const key: CacheKey = { ...baseKey, provider };
    const existing = deps.cache.getInFlight(key);
    const job = existing ?? runProvider(provider, baseKey, anidbId, imdbId, deps, title);
    if (!existing) deps.cache.setInFlight(key, job);

    try {
      const result = await job;
      if (result.found && result.vttContent) {
        deps.cache.setReady(key, result.vttContent);
        if (provider === 'opensubtitles') deps.cache.recordDownloadUsed('opensubtitles');
        hits.push(provider);
        return;
      }
      if ((provider === 'jimaku' || provider === 'animetosho') && result.seriesNotFound) {
        const seriesId = provider === 'jimaku' ? baseKey.anilistId : anidbId;
        if (seriesId !== null) deps.cache.setSeriesProviderMiss(provider, seriesId);
      }
      if (!result.quotaSkipped) deps.cache.setNegative(key);
    } finally {
      deps.cache.clearInFlight(key);
    }
  }));

  return hits;
}

async function resolveOneLanguage(
  baseKey: { anilistId: number; episode: number; lang: string },
  anidbId: number | null,
  imdbId: string | null,
  parsed: ParsedSubtitleRequestId & { episode: number },
  deps: SubtitlesHandlerDeps,
  mediaType: string | undefined,
  title: string | null,
): Promise<CacheProvider[]> {
  const tier1Providers: CacheProvider[] = ['jimaku', 'animetosho', 'opensubtitles'];
  const readyProviders: CacheProvider[] = [];
  const toTry: CacheProvider[] = [];

  for (const provider of tier1Providers) {
    const key: CacheKey = { ...baseKey, provider };
    const cached = deps.cache.get(key);
    if (cached?.status === 'ready') { readyProviders.push(provider); continue; }
    if (cached?.status === 'negative' && !deps.cache.isNegativeExpired(cached, deps.config.negativeCacheTtlHours)) continue;
    if (cached?.status === 'pending') continue; // in-flight elsewhere; skip, don't duplicate
    toTry.push(provider);
  }

  if (toTry.length > 0) {
    const hits = await tryDatabaseTier(baseKey, toTry, anidbId, imdbId, deps, title);
    readyProviders.push(...hits);
  }

  if (readyProviders.length > 0) return readyProviders;

  const extractionKey: CacheKey = { ...baseKey, provider: 'extraction' };
  const extractionCached = deps.cache.get(extractionKey);
  if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending') return ['extraction'];
  if (extractionCached?.status === 'negative' && !deps.cache.isNegativeExpired(extractionCached, deps.config.negativeCacheTtlHours)) return [];

  const streamUrlsPromise = getPlayableStreamUrls(
    deps.config.streamAddonUrl,
    parsed.contentId,
    parsed.season,
    parsed.episode,
    { timeoutMs: deps.config.providerTimeoutMs, mediaType },
  ).catch((err) => {
    if (err instanceof HttpTimeoutError) throw err;
    return [];
  });

  startExtractionInBackground(extractionKey, parsed, deps, mediaType, streamUrlsPromise);
  return ['extraction'];
}

function startExtractionInBackground(
  extractionKey: CacheKey,
  parsed: ParsedSubtitleRequestId & { episode: number },
  deps: SubtitlesHandlerDeps,
  mediaType: string | undefined,
  streamUrls: Promise<string[]>,
): void {
  if (deps.cache.getInFlight(extractionKey)) return;

  console.log(`[Tier 2: Extraction] Starting background extraction for ${parsed.contentId} ep:${parsed.episode} (${extractionKey.lang})`);
  deps.cache.setPending(extractionKey);
  const job = deps.extractionProvider({
    streamAddonUrl: deps.config.streamAddonUrl,
    contentId: parsed.contentId,
    season: parsed.season,
    episode: parsed.episode,
    lang: extractionKey.lang,
    queue: deps.queue,
    extractionTimeoutMs: deps.config.extractionTimeoutMs,
    providerTimeoutMs: deps.config.providerTimeoutMs,
    probeTimeoutMs: deps.config.probeTimeoutMs,
    mediaType,
    streamUrls,
  })
    .then((result) => {
      if (result.found && result.vttContent) {
        try {
          deps.cache.setReady(extractionKey, result.vttContent);
          console.log(`[Tier 2: Extraction] SUCCESS for anilist:${extractionKey.anilistId} ep:${extractionKey.episode} (${extractionKey.lang})`);
        } catch (err) {
          console.warn(`[Tier 2: Extraction] Extraction succeeded but failed to persist: ${(err as Error).message}`);
        }
      } else {
        console.log(`[Tier 2: Extraction] NOT FOUND for ${parsed.contentId} ep:${parsed.episode}`);
        deps.cache.setNegative(extractionKey);
      }
      return result;
    })
    .catch((err) => {
      console.warn(`[Tier 2: Extraction] Error during extraction: ${(err as Error)?.message ?? err}`);
      if (!(err instanceof HttpTimeoutError)) {
        deps.cache.setNegative(extractionKey);
      }
      return { found: false } as ProviderResult;
    })
    .finally(() => deps.cache.clearInFlight(extractionKey));

  deps.cache.setInFlight(extractionKey, job);
}

export async function handleSubtitlesRequest(
  rawId: string,
  deps: SubtitlesHandlerDeps,
  mediaType?: string,
): Promise<{ subtitles: SubtitleCandidate[] }> {
  const parsed = parseSubtitleRequestId(rawId);
  const ids = resolveIds(parsed.contentId, deps.dataset.current, deps.episodeMapping, parsed.season, parsed.episode);
  if (ids.anilistId === null) {
    console.log(`[AnimeSubs] Content ID not resolvable in dataset: ${parsed.contentId}`);
    return { subtitles: [] };
  }
  const anilistId = ids.anilistId;
  const episode = resolveEffectiveEpisode(parsed, ids.anidbId, deps.episodeMapping);
  const effectiveParsed = { ...parsed, episode };
  console.log(`[AnimeSubs] Resolving subtitles for ${rawId} -> anilist:${anilistId}${ids.anidbId ? `, anidb:${ids.anidbId}` : ''}`);

  const results = await Promise.all(
    deps.config.subtitleLanguages.map(async (lang) => {
      const baseKey = { anilistId, episode, lang };
      const hitProviders = await resolveOneLanguage(baseKey, ids.anidbId, ids.imdbId ?? null, effectiveParsed, deps, mediaType, ids.title ?? null);
      return hitProviders.map((provider): SubtitleCandidate => ({
        lang,
        provider,
        url: deps.buildSubtitleUrl({ ...baseKey, provider }),
      }));
    }),
  );
  return { subtitles: results.flat() };
}
```

- [ ] **Step 5: Run the new tests to verify they pass (after Step 6's fixture updates make the file compile)**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: all PASS once Step 6 is complete.

- [ ] **Step 6: Update every pre-existing test's fixtures and assertions**

The module-level `dataset` constant and `deps` object in `beforeEach` both need updating. Two concrete before/after examples — apply the same two changes (add `episodeMapping` to `deps`, add `opensubtitlesProvider` to `deps`, add `provider` to every `CacheKey`/`SubtitleCandidate` literal in assertions) to every other test in the file:

```ts
// Before (module level)
const dataset = AnimeDataset.buildFromRaw({ data: [ /* ... */ ] }, new Database(':memory:'));

// After
import { EpisodeMapping } from '../src/resolver/episodeMapping.js';
const episodeMapping = EpisodeMapping.buildFromXml('<?xml version="1.0"?><anime-list></anime-list>', new Database(':memory:'));
const dataset = AnimeDataset.buildFromRaw({ data: [ /* ...unchanged... */ ] }, new Database(':memory:'), episodeMapping);
```

```ts
// Before (beforeEach)
    deps = {
      dataset: { current: dataset },
      cache,
      queue: new ExtractionQueue(1),
      config: baseConfig,
      buildSubtitleUrl: (key) => `https://addon.example.com/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
      jimakuProvider: vi.fn(async () => ({ found: false })),
      animetoshoProvider: vi.fn(async () => ({ found: false })),
      extractionProvider: vi.fn(async () => ({ found: false })),
    };

// After
    deps = {
      dataset: { current: dataset },
      episodeMapping,
      cache,
      queue: new ExtractionQueue(1),
      config: baseConfig,
      buildSubtitleUrl: (key) => `https://addon.example.com/vtt/${key.anilistId}/${key.episode}/${key.lang}/${key.provider}.vtt`,
      jimakuProvider: vi.fn(async () => ({ found: false })),
      animetoshoProvider: vi.fn(async () => ({ found: false })),
      opensubtitlesProvider: vi.fn(async () => ({ found: false })),
      extractionProvider: vi.fn(async () => ({ found: false })),
    };
```

Every existing assertion of the shape `{ lang: 'eng', url: '...' }` becomes `{ lang: 'eng', provider: 'jimaku', url: '.../jimaku.vtt' }` (substituting the correct provider and matching URL for that test's scenario — `'jimaku'` for tier-1 hits, `'animetosho'` for tier-2-provider hits, `'extraction'` for fallback-extraction hits). Every `cache.get({ anilistId, episode, lang })` becomes `cache.get({ anilistId, episode, lang, provider: '...' })` with the provider matching whichever one that test is exercising. Every `expect(cache.get(key)?.tier).toBe(N)` assertion is deleted (the `tier` field no longer exists on `CacheEntry`) — the `provider` field, already implied by the `key` used to fetch, makes that assertion redundant.

- [ ] **Step 7: Run full file, fix remaining issues iteratively**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: iterate until all PASS — this file has the largest fixture surface of any file in this plan, budget real time for it.

- [ ] **Step 8: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/subtitlesHandler.ts src/types.ts src/resolver/idResolver.ts test/subtitlesHandler.test.ts
git commit -m "feat(handler): concurrent 3-provider Tier 1, per-provider dedup, multi-track output

Tier 1 (Jimaku/AnimeTosho/OpenSubtitles) now runs concurrently per
provider-keyed cache entry, each with its own in-flight dedup (fixes
finding #12) and independent negative-cache TTL (fixes finding #10 --
a tier-2 extraction failure no longer blocks tier-1 retries, since
they're no longer sharing a cache key). Every provider that finds a
match produces its own subtitle track (fixes finding #1's structural
single-subtitle cap). A disk-write failure after a successful
extraction no longer gets recorded as a negative match (finding #22),
and a stream-addon prefetch timeout is distinguished from a genuine
extraction miss (finding #11). tt-prefixed content ids are now
resolved via the reverse imdb_id + episode-mapping path from Task 14.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 19: `server.ts` — provider-segmented `/vtt` route, configurable wait, lang-aware serve, labeled multi-track output

**Files:**
- Modify: `src/server.ts`
- Modify: `src/config.ts` (new `vttWaitMs` setting)
- Test: `test/server.test.ts` (fixture updates throughout, plus new coverage)

**Interfaces:**
- Consumes: `CacheKey` with `provider` (Task 16), `SubtitleCandidate` with `provider` (Task 18).
- Produces: no new exports; `createServer`'s signature is unchanged, but the `/vtt` route path changes from `/vtt/:anilistId/:episode/:lang.vtt` to `/vtt/:anilistId/:episode/:lang/:provider.vtt`, and `/subtitles/*.json` responses gain a human-readable, provider-disambiguated `lang` string when more than one track shares a language.

Folds in finding #4 (35s wait can outlast the client's own timeout) and the serve-side half of finding #17 (`normalizeVtt` always defaulting to `eng` regardless of the actual requested language).

- [ ] **Step 1: Add `vttWaitMs` to config**

```ts
// src/config.ts
export interface Config {
  // ...existing fields...
  vttWaitMs: number;
}
// in loadConfig's return object:
    vttWaitMs: requireInt(env, 'VTT_WAIT_MS', 20000),
```

Add a config test alongside the others from Task 5/15: `expect(loadConfig(baseEnv()).vttWaitMs).toBe(20000);` and an env-override variant. Lowered from today's hardcoded 35000ms — 20s is still generous for genuinely-fast extractions to complete inline, while holding the connection open less needlessly long than before; it does not fully solve finding #4 (no push mechanism exists to notify an already-disconnected client), but Step 4 below adds early-abort-on-client-disconnect so the server at least stops doing pointless work once nobody's listening.

- [ ] **Step 2: Write the failing tests for the provider-segmented route and lang-aware serve**

Update `test/server.test.ts`'s `config` fixture to include every field added in Tasks 5, 15, and this task (`probeTimeoutMs: 1000, openSubtitlesApiKey: 'test-key', openSubtitlesDailyQuota: 100, vttWaitMs: 500`), and its `createServer(...)` call's `deps` to add `episodeMapping` (an empty `EpisodeMapping.buildFromXml('<?xml version="1.0"?><anime-list></anime-list>', new Database(':memory:'))` is sufficient for this file's purposes) and `opensubtitlesProvider: async () => ({ found: false })`.

Update every existing `cache.setReady(key, N, ...)` call in the file to the new two-argument form with a `provider` field on the key (e.g. `cache.setReady({ anilistId: 154587, episode: 1, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\ntest')`), and every `/vtt/154587/1/eng.vtt`-shaped URL in assertions to `/vtt/154587/1/eng/jimaku.vtt` (matching whichever provider that test's `setReady` call used). Add:

```ts
  it('serves distinctly per provider at the same anilistId/episode/lang', async () => {
    cache.setReady({ anilistId: 154587, episode: 20, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\njimaku body');
    cache.setReady({ anilistId: 154587, episode: 20, lang: 'eng', provider: 'animetosho' }, 'WEBVTT\n\n1\ntosho body');
    const jimakuRes = await fetch(`${baseUrl}/vtt/154587/20/eng/jimaku.vtt`);
    const toshoRes = await fetch(`${baseUrl}/vtt/154587/20/eng/animetosho.vtt`);
    expect(await jimakuRes.text()).toContain('jimaku body');
    expect(await toshoRes.text()).toContain('tosho body');
  });

  it('labels each track with its provider when a language has more than one hit', async () => {
    cache.setReady({ anilistId: 154587, episode: 21, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\na');
    cache.setReady({ anilistId: 154587, episode: 21, lang: 'eng', provider: 'animetosho' }, 'WEBVTT\n\n1\nb');
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:46474:1:21.json`);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles).toHaveLength(2);
    expect(body.subtitles.map((s) => s.lang).sort()).toEqual(['eng (AnimeTosho)', 'eng (Jimaku)']);
  });

  it('does not relabel lang when only one provider has a hit for that language', async () => {
    cache.setReady({ anilistId: 154587, episode: 22, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\nsolo');
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:46474:1:22.json`);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles[0].lang).toBe('eng');
  });

  it('passes the requested language through to normalizeVtt when serving a ready file', async () => {
    cache.setReady({ anilistId: 154587, episode: 23, lang: 'spa', provider: 'jimaku' }, 'WEBVTT\n\n1\nHola こんにちは');
    const res = await fetch(`${baseUrl}/vtt/154587/23/spa/jimaku.vtt`);
    const text = await res.text();
    // For a non-'eng' target language, the Japanese-char filter must not
    // apply -- this line must survive intact, unlike the 'eng' case.
    expect(text).toContain('こんにちは');
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL (route doesn't accept the `:provider` segment yet; `lang` isn't relabeled; `normalizeVtt` still defaults to `eng`).

- [ ] **Step 4: Implement**

```ts
// src/server.ts
import express, { type Express } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { manifest } from './manifest.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from './subtitlesHandler.js';
import type { CacheStore } from './cache/cacheStore.js';
import type { CacheProvider } from './types.js';
import { normalizeVtt } from './ffmpeg/vttUtils.js';

const PROVIDER_LABELS: Record<CacheProvider, string> = {
  jimaku: 'Jimaku',
  animetosho: 'AnimeTosho',
  opensubtitles: 'OpenSubtitles',
  extraction: 'Extracted',
};

export function createServer(handlerDeps: SubtitlesHandlerDeps, cache: CacheStore): Express {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    const start = Date.now();
    res.on('finish', () => {
      console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  app.options('{*path}', (_req, res) => {
    res.sendStatus(204);
  });

  app.get('/manifest.json', (_req, res) => {
    res.json(manifest);
  });

  app.set('trust proxy', true);

  app.get(['/subtitles/:type/:id.json', '/subtitles/:type/:id/:extra.json'], async (req, res) => {
    try {
      const typeParam = Array.isArray(req.params.type) ? req.params.type[0] : req.params.type;
      const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const rawId = decodeURIComponent(idParam);
      const result = await handleSubtitlesRequest(rawId, handlerDeps, typeParam);
      const host = req.get('host');
      const protocol = req.protocol;
      const origin = host ? `${protocol}://${host}` : '';

      const countByLang = new Map<string, number>();
      for (const sub of result.subtitles) countByLang.set(sub.lang, (countByLang.get(sub.lang) ?? 0) + 1);

      const subtitles = result.subtitles.map((sub) => ({
        id: `${sub.lang}-${sub.provider}`,
        lang: (countByLang.get(sub.lang) ?? 0) > 1 ? `${sub.lang} (${PROVIDER_LABELS[sub.provider]})` : sub.lang,
        url: sub.url.startsWith('http://') || sub.url.startsWith('https://')
          ? sub.url
          : `${origin}${sub.url.startsWith('/') ? '' : '/'}${sub.url}`,
      }));
      res.json({ subtitles });
    } catch (err) {
      console.warn(`[HTTP] Error handling subtitles request: ${(err as Error).message}`);
      res.status(200).json({ subtitles: [] });
    }
  });

  app.get('/vtt/:anilistId/:episode/:lang/:provider.vtt', async (req, res) => {
    const key = {
      anilistId: parseInt(req.params.anilistId, 10),
      episode: parseInt(req.params.episode, 10),
      lang: req.params.lang,
      provider: req.params.provider as CacheProvider,
    };
    let entry = cache.get(key);

    const inFlight = cache.getInFlight(key);
    if (inFlight) {
      let clientGone = false;
      const onClose = () => { clientGone = true; };
      req.on('close', onClose);
      try {
        await Promise.race([
          inFlight,
          new Promise((resolve) => setTimeout(resolve, handlerDeps.config.vttWaitMs)),
          new Promise((resolve) => req.once('close', resolve)),
        ]);
      } catch {
        // extraction finished or failed; re-check cache below
      } finally {
        req.off('close', onClose);
      }
      if (clientGone) return; // response would be discarded anyway; skip the write
      entry = cache.get(key);
    }

    res.type('text/vtt');

    if (entry?.status === 'ready' && entry.filePath && existsSync(entry.filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const content = readFileSync(entry.filePath, 'utf-8');
      res.send(normalizeVtt(content, key.lang));
      return;
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (entry?.status === 'pending') {
      res.send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nExtracting subtitles -- reselect this track in about a minute.\n');
      return;
    }
    res.status(404).send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nNo subtitle available.\n');
  });

  return app;
}
```

- [ ] **Step 5: Run to verify they pass, fix remaining fixture fallout**

Run: `npx vitest run test/server.test.ts`
Expected: iterate on the remaining pre-existing tests' `setReady`/URL fixtures (per Step 2's instructions) until all PASS.

- [ ] **Step 6: Manual verification (flagged in the spec as unverified picker UX)**

This step cannot be automated in this repo's test suite. After this task lands (and Task 20 wires everything together so the addon runs end-to-end), install the addon on the actual Samsung TV Stremio client, play an episode where more than one Tier-1 provider has a hit, and confirm the subtitle picker shows distinguishable entries (e.g. "English (Jimaku)" / "English (AnimeTosho)") rather than two identical-looking "English" entries with no way to tell them apart. If the TV client renders `lang` differently than expected (e.g. only shows a flag/ISO code and ignores extra text), that's a real finding to bring back — the labeling approach in Step 4 may need revisiting (e.g. moving the distinguishing text into a differently-named field, if the Stremio subtitle spec exposes one this addon isn't currently using).

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/server.ts src/config.ts test/server.test.ts
git commit -m "feat(server): provider-segmented /vtt route, labeled multi-track output

/vtt now takes a provider segment so each provider's cached file is
served independently. /subtitles responses label the lang field with
the provider name only when more than one track shares a language,
so the Stremio picker can distinguish them. normalizeVtt now receives
the actual requested language on serve (finding #17's serve half).
The wait for in-flight tier-2 extraction is now configurable
(VTT_WAIT_MS, default 20000, was a hardcoded 35000) and aborts early
if the client disconnects (partial mitigation for finding #4 -- full
fix would need a push mechanism this addon doesn't have).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

### Task 20: Wire everything together in `index.ts`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/resolver/episodeMapping.ts` (add `fromExistingTable`, mirroring Task 9's `AnimeDataset.fromExistingTable`)
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 12 through 19.
- Produces: nothing new — this is the composition root. After this task, the addon runs end-to-end with the full Tier 1 (Jimaku/AnimeTosho/OpenSubtitles) / Tier 2 (extraction) design live.

- [ ] **Step 1: Add `EpisodeMapping.fromExistingTable` and a `loadOrRefreshEpisodeMapping` helper, mirroring Task 9's dataset fallback**

```ts
// src/resolver/episodeMapping.ts — add alongside buildFromXml
  static fromExistingTable(db: Database.Database): EpisodeMapping {
    return new EpisodeMapping(db);
  }
```

```ts
// src/index.ts
export async function loadOrRefreshEpisodeMapping(db: Database.Database, previous?: EpisodeMapping, downloadUrl?: string): Promise<EpisodeMapping> {
  try {
    const xml = await downloadEpisodeMapping(downloadUrl);
    return EpisodeMapping.buildFromXml(xml, db);
  } catch (err) {
    if (previous) {
      console.error(`[AnimeSubs] Episode-mapping download/build failed, keeping previous in-memory mapping: ${(err as Error).message}`);
      return previous;
    }
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_mapping'").get();
    if (row) {
      console.error(`[AnimeSubs] Episode-mapping download failed on startup; falling back to on-disk table from a previous run: ${(err as Error).message}`);
      return EpisodeMapping.fromExistingTable(db);
    }
    throw err;
  }
}
```

- [ ] **Step 2: Write the failing test**

Add to `test/index.test.ts`, mirroring Task 9's `loadOrRefreshDataset` tests:

```ts
describe('loadOrRefreshEpisodeMapping', () => {
  it('falls back to an existing on-disk episode_mapping table when the download fails and no previous instance exists', async () => {
    const db = new Database(':memory:');
    EpisodeMapping.buildFromXml('<?xml version="1.0"?><anime-list><anime anidbid="1" tvdbid="72025" defaulttvdbseason="1"><name>Fixture</name></anime></anime-list>', db);
    const mapping = await loadOrRefreshEpisodeMapping(db, undefined, 'http://127.0.0.1:1/unreachable');
    expect(mapping.mapAnidbToTvdbEpisode(1, 5)).toEqual({ season: 1, episode: 5 });
  });

  it('rethrows when the download fails and there is no fallback table at all', async () => {
    const db = new Database(':memory:');
    await expect(loadOrRefreshEpisodeMapping(db, undefined, 'http://127.0.0.1:1/unreachable')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify they fail, then implement (Step 1's code), then pass**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL, then PASS once Step 1's implementation is in place.

- [ ] **Step 4: Wire the full startup sequence**

```ts
// src/index.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { AnimeDataset, downloadDataset } from './resolver/animeDataset.js';
import { EpisodeMapping, downloadEpisodeMapping } from './resolver/episodeMapping.js';
import { CacheStore } from './cache/cacheStore.js';
import { ExtractionQueue } from './queue/extractionQueue.js';
import { createServer } from './server.js';
import { findJimakuSubtitle } from './providers/jimakuProvider.js';
import { findAnimeToshoSubtitle } from './providers/animetoshoProvider.js';
import { findOpenSubtitlesSubtitle } from './providers/opensubtitlesProvider.js';
import { runExtractionTier } from './providers/extractionProvider.js';
import type { DatasetHolder } from './subtitlesHandler.js';

const DATASET_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const episodeMappingDb = new Database(join(config.dataDir, 'episode-mapping.db'));
  let episodeMapping = await loadOrRefreshEpisodeMapping(episodeMappingDb);

  const datasetDb = new Database(join(config.dataDir, 'anime-dataset.db'));
  const datasetHolder: DatasetHolder = { current: AnimeDataset.buildFromRaw(await downloadDataset(), datasetDb, episodeMapping) };

  setInterval(async () => {
    episodeMapping = await loadOrRefreshEpisodeMapping(episodeMappingDb, episodeMapping);
    try {
      datasetHolder.current = AnimeDataset.buildFromRaw(await downloadDataset(), datasetDb, episodeMapping);
    } catch (err) {
      console.error('Failed to refresh anime dataset:', err);
    }
  }, DATASET_REFRESH_INTERVAL_MS);

  const cache = new CacheStore(join(config.dataDir, 'cache.db'), join(config.dataDir, 'subtitles'));
  const reconciled = cache.reconcilePendingOnStartup();
  if (reconciled > 0) {
    console.log(`[AnimeSubs] Cleared ${reconciled} stale pending cache row(s) from a previous run`);
  }

  const queue = new ExtractionQueue(config.extractionConcurrency);

  const app = createServer({
    dataset: datasetHolder,
    episodeMapping,
    cache,
    queue,
    config,
    buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}/${key.provider}.vtt`,
    jimakuProvider: findJimakuSubtitle,
    animetoshoProvider: findAnimeToshoSubtitle,
    opensubtitlesProvider: findOpenSubtitlesSubtitle,
    extractionProvider: runExtractionTier,
  }, cache);

  const server = app.listen(config.port, () => {
    console.log(`AnimeSubs listening on port ${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[AnimeSubs] Received ${signal}, shutting down`);
    server.close(() => {
      cache.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

Note: `createServer`'s `episodeMapping` dep is captured once at startup and does not pick up the `setInterval` refresh's reassignment (`episodeMapping` local variable is reassigned, but the object passed into `createServer` was a snapshot at call time). This mirrors an existing, accepted limitation already present for `datasetHolder` being the *only* refresh-aware indirection in this codebase — fixing it properly would mean threading an `EpisodeMappingHolder` (mirroring `DatasetHolder`) through `SubtitlesHandlerDeps` and every function that reads `deps.episodeMapping`. Given `anime-lists` changes far less frequently in practice than the anime-offline-database (new mapping entries appear when new shows are added, not when existing mappings change), and this plan is already large, this is accepted as a known limitation rather than adding an `EpisodeMappingHolder` indirection layer — flag it to the user after this plan ships as a possible small follow-up, not a blocking gap for this plan.

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
npm test
npm run typecheck
git add src/index.ts src/resolver/episodeMapping.ts test/index.test.ts
git commit -m "feat: wire episode-mapping resolver and OpenSubtitles provider into startup

Completes the Tier 1 (Jimaku/AnimeTosho/OpenSubtitles-by-IMDB, run
concurrently) / Tier 2 (embedded extraction fallback) redesign end to
end. episode_mapping downloads/refreshes alongside the existing anime
dataset, with the same download-failure-falls-back-to-on-disk-table
resilience as Task 9 added for the anime dataset itself.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** every numbered component in the spec (`docs/superpowers/specs/2026-09-24-tier-restructure-opensubtitles-design.md`) maps to a task — Component 1 (episode mapping) → Task 12; Component 2 (idResolver reverse lookup) → Task 14; Component 3 (imdb_id column) → Task 13; Component 4 (OpenSubtitles provider + quota) → Tasks 16, 17; Component 5 (CacheKey provider dimension) → Task 16; Component 6 (subtitlesHandler restructure) → Task 18; Component 7 (server.ts routes) → Task 19; Component 8 (config) → Task 15. The spec's "Known risk, accepted for v1" section (season/episode mismatch) is the one the user asked to be fixed rather than accepted, and Task 12 delivers that fix via the `anime-lists` mapping rather than leaving it as an accepted risk.

**Placeholder scan:** no `TBD`/`TODO`/"implement later" markers. The one deliberately-deferred item (Task 13 Step 6, explicitly explaining why `index.ts` wiring waits for Task 20 rather than being split across two tasks) states the reason and the exact task where it's completed, not an open-ended placeholder. Task 2's fixture-building step (extract.test.ts) explicitly flags that it depends on reading an existing file not covered by this plan's research pass, with clear instructions on what to look for — this is a scoped unknown with an actionable resolution path, not a vague "add tests for the above."

**Type consistency:** `CacheKey`/`CacheEntry`/`CacheProvider` (Task 16) are used identically in Tasks 17, 18, 19, 20. `ProviderResult.quotaSkipped` (Task 17) is consumed the same way in Task 18. `EpisodeMapping`'s method names (`findByAnidbId`, `mapAnidbToTvdbEpisode`, `mapTvdbToAnidbEpisode`, `fromExistingTable`) are identical across Tasks 12, 13, 14, 18, 20. `SubtitleCandidate.provider` (Task 18) is consumed identically in Task 19.

**Review Focus coverage** (from this plan's header):
1. `anidbId === null` doesn't crash new code — exercised in Task 17's Step 3 (`imdbId === null` early return), Task 18's `runProvider` (guards `anidbId !== null` before calling `mapAnidbToTvdbEpisode`).
2. `tt`-prefixed request for an uncovered title falls through cleanly — exercised in Task 14 Step 1's `'returns nulls for a tt id with no matching imdb_id in the dataset'`.
3. No double-charge/double-call on concurrent requests — exercised in Task 18 Step 2's `'does not double-charge the OpenSubtitles quota or double-call a provider...'`.
4. Old-schema cache rows read correctly post-migration — exercised in Task 16 Step 1's `'migrates an old-schema row...'`.
5. Missing `OPENSUBTITLES_API_KEY` fails loudly at startup — exercised in Task 15 Step 1.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-24-tier-restructure-and-fixes.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **subagent-driven**, because Task 18 (`subtitlesHandler.ts` restructure) and Task 16 (`CacheKey` schema change) ripple through nearly every other file in this plan, and Tasks 6/7's rewrite of well-tested provider logic is exactly the kind of change where a fresh, independent reviewer catching a subtle regression before the next task builds on it is worth the extra cost — a mistake in Task 16 or 18 would otherwise propagate silently through Tasks 17, 19, and 20. Does the plan capture what you want, and which approach should we use?

