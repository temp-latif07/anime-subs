# AnimeTosho Enhancements and Japanese Subtitle Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase fast tier hit rates on AnimeTosho (batch torrent support, targeted episode query, title search fallback, broadened regex) and eliminate subtitle bouncing by stripping Japanese text (Kanji/Kana) and Opening/Ending song lyrics (Kanji & Romaji) from English subtitles.

**Architecture:**
1. In `src/ffmpeg/assUtils.ts` and `src/ffmpeg/vttUtils.ts`, detect and discard OP/ED song styles and inline karaoke tags (`\k`), and filter out Japanese script characters (Hiragana, Katakana, Kanji, CJK punctuation) from multi-line cues, dropping pure Japanese cues so subtitles render statically without jumping.
2. In `src/providers/jimakuProvider.ts` and `src/providers/animetoshoProvider.ts`, validate that generated VTT content has sufficient Latin characters and isn't predominantly Japanese before marking it as a hit.
3. In `src/resolver/animeDataset.ts` and `src/resolver/idResolver.ts`, store and expose the canonical anime `title` so providers can search by title when AniDB IDs are missing or unlinked.
4. In `src/providers/animetoshoProvider.ts`, query `aid` with `&q=${episode}`, inspect files inside batch torrents (`num_files > 1`), fall back to title search when `aid` returns no results, and expand episode parsing regexes.
5. In `src/subtitlesHandler.ts`, pass `title` to AnimeTosho and maintain safe negative caching.

**Tech Stack:** TypeScript, Node.js (`better-sqlite3`, `node:http`), Express, Vitest.

## Global Constraints
- Single-tenant, self-hosted Docker compatibility.
- Zero regression on existing 16 test suites (128 tests).
- All changes must adhere strictly to TDD (test-first, confirm failure, implement, confirm pass).
- Avoid unnecessary external dependencies; use native Node.js APIs and existing libraries (`better-sqlite3`).

---

### Task 1: Japanese Script & Song Stripping in ASS and VTT

**Files:**
- Modify: `src/ffmpeg/assUtils.ts`
- Modify: `src/ffmpeg/vttUtils.ts`
- Test: `test/ffmpeg/assUtils.test.ts`
- Test: `test/ffmpeg/vttUtils.test.ts`

**Interfaces:**
- Produces: `convertAssToVtt(ass: string, targetLang?: string): string`
- Produces: `normalizeVtt(vtt: string, targetLang?: string): string`
- Consumes: Unicode ranges for Japanese script (`\u3040-\u309F`, `\u30A0-\u30FF`, `\u4E00-\u9FFF`, `\u3400-\u4DBF`, `\u3000-\u303F`, `\uFF00-\uFFEF`)

- [ ] **Step 1: Write failing tests for Japanese and song filtering in `assUtils.test.ts`**

Add tests to `test/ffmpeg/assUtils.test.ts`:
```typescript
  it('strips Opening and Ending song styles and karaoke cues', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
Style: OP - Romaji,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1
Style: ED - English,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,OP - Romaji,,0,0,0,,{\\k20}A{\\k30}no {\\k40}hi {\\k50}mita {\\k60}hana
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Hello, how are you?
Dialogue: 0,0:00:20.00,0:00:23.00,ED - English,,0,0,0,,Like a bird in the sky
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Hello, how are you?');
    expect(vtt).not.toContain('Ano hi mita');
    expect(vtt).not.toContain('Like a bird in the sky');
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
    // Check that there are only 2 cues, not 3
    const cues = vtt.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/assUtils.test.ts`
Expected: FAIL (cues contain Japanese lines and song lines).

- [ ] **Step 3: Update `assUtils.ts` with song skipping and Japanese script stripping**

In `src/ffmpeg/assUtils.ts`:
1. Define constants:
```typescript
export const JAPANESE_CHAR_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF]/;
const SONG_STYLE_REGEX = /^(op|ed|song|karaoke|lyrics|insert|music)\b|kanji|romaji/i;
const KARAOKE_TAG_REGEX = /\{[^}]*\\k[f|o]?[0-9]+[^}]*\}/i;
```
2. In `convertAssToVtt(ass: string, targetLang = 'eng'): string`:
- When reading `Dialogue:`, check if `targetLang === 'eng'`:
  - If `SONG_STYLE_REGEX.test(style) || KARAOKE_TAG_REGEX.test(text)`, `continue` (skip).
- When processing lines of text in cue:
  - If `targetLang === 'eng'`, filter out lines where `JAPANESE_CHAR_REGEX.test(l)`.
- If `processedLines.length === 0`, `continue` (drop pure Japanese cue).

- [ ] **Step 4: Update `vttUtils.ts` to sanitize Japanese lines in WebVTT**

In `src/ffmpeg/vttUtils.ts`:
1. In `finalizeCue(timing: string, rawTextLines: string[], targetLang = 'eng')`:
- If `targetLang === 'eng'`:
  - Filter `rawTextLines` to drop any line containing `JAPANESE_CHAR_REGEX`.
- If `processedLines.length === 0`, return `null`.
2. Update `normalizeVtt(vtt: string, targetLang = 'eng')` to pass `targetLang` to `finalizeCue`.

- [ ] **Step 5: Write tests in `test/ffmpeg/vttUtils.test.ts`**

Add tests verifying Japanese lines are stripped and pure Japanese cues are dropped when `targetLang === 'eng'`:
```typescript
  it('strips Japanese lines from WebVTT cues when target language is English', () => {
    const input = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
こんにちは
Hello world!

2
00:00:04.000 --> 00:00:06.000
さようなら

3
00:00:07.000 --> 00:00:09.000
Goodbye!
`;
    const result = normalizeVtt(input, 'eng');
    expect(result).toContain('Hello world!');
    expect(result).not.toContain('こんにちは');
    expect(result).not.toContain('さようなら');
    expect(result).toContain('Goodbye!');
    const cues = result.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(2);
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/ffmpeg/assUtils.test.ts test/ffmpeg/vttUtils.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit changes**

```bash
git add src/ffmpeg/assUtils.ts src/ffmpeg/vttUtils.ts test/ffmpeg/assUtils.test.ts test/ffmpeg/vttUtils.test.ts
git commit -m "feat(ffmpeg): strip Japanese characters and song lyrics from English subtitles"
```

---

### Task 2: Subtitle Content Language Verification

**Files:**
- Modify: `src/ffmpeg/vttUtils.ts`
- Modify: `src/providers/jimakuProvider.ts`
- Modify: `src/providers/animetoshoProvider.ts`
- Test: `test/ffmpeg/vttUtils.test.ts`
- Test: `test/providers/jimakuProvider.test.ts`

**Interfaces:**
- Produces: `isAcceptableSubtitle(vtt: string, targetLang: string): boolean` in `src/ffmpeg/vttUtils.ts`
- Consumes: Target language code, e.g. `'eng'`

- [ ] **Step 1: Write failing test for `isAcceptableSubtitle` in `vttUtils.test.ts`**

In `test/ffmpeg/vttUtils.test.ts`:
```typescript
  it('validates acceptable subtitles for English', () => {
    const goodEnglish = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nThis is a normal English dialogue subtitle track.\n`;
    const pureJapanese = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nこれは日本語の字幕です。英語はありません。\n`;
    const emptyVtt = `WEBVTT\n\n`;

    expect(isAcceptableSubtitle(goodEnglish, 'eng')).toBe(true);
    expect(isAcceptableSubtitle(pureJapanese, 'eng')).toBe(false);
    expect(isAcceptableSubtitle(emptyVtt, 'eng')).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/vttUtils.test.ts`
Expected: FAIL (`isAcceptableSubtitle` not defined).

- [ ] **Step 3: Implement `isAcceptableSubtitle` in `vttUtils.ts`**

In `src/ffmpeg/vttUtils.ts`:
```typescript
import { JAPANESE_CHAR_REGEX } from './assUtils.js';

export function isAcceptableSubtitle(vtt: string, targetLang: string): boolean {
  if (!vtt || typeof vtt !== 'string') return false;
  if (targetLang !== 'eng') return vtt.includes('-->');

  const latinMatches = vtt.match(/[a-zA-Z]/g);
  const latinCount = latinMatches ? latinMatches.length : 0;
  if (latinCount < 20) return false;

  const jpMatches = vtt.match(new RegExp(JAPANESE_CHAR_REGEX.source, 'g'));
  const jpCount = jpMatches ? jpMatches.length : 0;

  // If Japanese characters are more than 25% of Latin characters, reject
  if (jpCount > latinCount * 0.25) return false;

  return true;
}
```

- [ ] **Step 4: Integrate `isAcceptableSubtitle` into `jimakuProvider.ts` and `animetoshoProvider.ts`**

In `src/providers/jimakuProvider.ts`:
- After `vttContent` is retrieved:
```typescript
  if (!isAcceptableSubtitle(vttContent, lang)) {
    return { found: false };
  }
```

In `src/providers/animetoshoProvider.ts`:
- After `vttContent` is retrieved:
```typescript
  if (!isAcceptableSubtitle(vttContent, lang)) {
    continue; // check next candidate
  }
```

- [ ] **Step 5: Write test in `jimakuProvider.test.ts` verifying rejection of mislabeled Japanese file**

In `test/providers/jimakuProvider.test.ts`:
```typescript
  it('rejects a subtitle file that is predominantly Japanese even if filename matched', async () => {
    // create a server mock returning a file with English in name but Japanese in text
    // verify findJimakuSubtitle returns { found: false }
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/ffmpeg/vttUtils.test.ts test/providers/jimakuProvider.test.ts test/providers/animetoshoProvider.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit changes**

```bash
git add src/ffmpeg/vttUtils.ts src/providers/jimakuProvider.ts src/providers/animetoshoProvider.ts test/ffmpeg/vttUtils.test.ts test/providers/jimakuProvider.test.ts
git commit -m "feat(validation): reject mislabeled or predominantly Japanese subtitles for English requests"
```

---

### Task 3: Canonical Anime Title Resolution

**Files:**
- Modify: `src/types.ts`
- Modify: `src/resolver/animeDataset.ts`
- Modify: `src/resolver/idResolver.ts`
- Test: `test/resolver/animeDataset.test.ts`
- Test: `test/resolver/idResolver.test.ts`

**Interfaces:**
- Consumes: `RawDatasetEntry.title`
- Produces: `ResolvedIds.title?: string | null` in `src/types.ts`
- Produces: `dataset.findByAnilistId(id)` and `dataset.findByScheme(scheme, id)` returning `title`

- [ ] **Step 1: Write failing tests in `animeDataset.test.ts` and `idResolver.test.ts`**

In `test/resolver/animeDataset.test.ts`:
```typescript
  it('stores and returns the canonical anime title', () => {
    const raw: RawDataset = {
      data: [
        {
          title: 'Grand Blue Season 3',
          sources: ['https://anidb.net/anime/19600', 'https://anilist.co/anime/199111'],
        },
      ],
    };
    const dataset = AnimeDataset.buildFromRaw(raw, db);
    const row = dataset.findByAnilistId(199111);
    expect(row?.title).toBe('Grand Blue Season 3');
  });
```

In `test/resolver/idResolver.test.ts`:
```typescript
  it('returns anime title in resolveIds', () => {
    const ids = resolveIds('kitsu:50181', dataset);
    expect(ids.title).toBe('Grand Blue Season 3');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/resolver/animeDataset.test.ts test/resolver/idResolver.test.ts`
Expected: FAIL (`title` is undefined).

- [ ] **Step 3: Update `animeDataset.ts` and `types.ts`**

1. In `src/types.ts`:
```typescript
export interface ResolvedIds {
  anilistId: number | null;
  anidbId: number | null;
  title?: string | null;
}
```

2. In `src/resolver/animeDataset.ts`:
- Update `RawDatasetEntry`:
```typescript
export interface RawDatasetEntry {
  title?: string;
  sources: string[];
}
```
- Update `CREATE TABLE anime_ids`:
```sql
CREATE TABLE anime_ids (
  anilist_id INTEGER,
  anidb_id INTEGER,
  kitsu_id INTEGER,
  mal_id INTEGER,
  title TEXT
);
```
- Update insert statement and transaction:
```typescript
const insert = db.prepare('INSERT INTO anime_ids (anilist_id, anidb_id, kitsu_id, mal_id, title) VALUES (?, ?, ?, ?, ?)');
insert.run(ids.anilistId, ids.anidbId, ids.kitsuId, ids.malId, entry.title ?? null);
```
- Update queries:
```typescript
findByAnilistId(id: number): IdRow | null {
  return (this.db.prepare('SELECT anilist_id as anilistId, anidb_id as anidbId, title FROM anime_ids WHERE anilist_id = ?').get(id) as IdRow) ?? null;
}

findByScheme(scheme: 'kitsu' | 'mal' | 'anidb', id: number): IdRow | null {
  const column = scheme === 'kitsu' ? 'kitsu_id' : scheme === 'mal' ? 'mal_id' : 'anidb_id';
  return (this.db.prepare(`SELECT anilist_id as anilistId, anidb_id as anidbId, title FROM anime_ids WHERE ${column} = ?`).get(id) as IdRow) ?? null;
}
```

3. In `src/resolver/idResolver.ts`:
- Ensure `title` is preserved in `resolveIds(contentId, dataset)` return value.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/resolver/animeDataset.test.ts test/resolver/idResolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/types.ts src/resolver/animeDataset.ts src/resolver/idResolver.ts test/resolver/animeDataset.test.ts test/resolver/idResolver.test.ts
git commit -m "feat(resolver): store and resolve canonical anime title"
```

---

### Task 4: AnimeTosho Provider Enhancements (Targeted Query, Batches, Title Fallback, Broadened Regex)

**Files:**
- Modify: `src/providers/animetoshoProvider.ts`
- Test: `test/providers/animetoshoProvider.test.ts`

**Interfaces:**
- Produces: `findAnimeToshoSubtitle(anidbId: number | null, episode: number, lang: string, opts?: AnimeToshoOptions): Promise<ProviderResult>`
- Consumes: `AnimeToshoOptions.title?: string | null`

- [ ] **Step 1: Write failing tests in `animetoshoProvider.test.ts`**

Add tests to `test/providers/animetoshoProvider.test.ts`:
1. Targeted query parameter (`q=${episode}` included in `aid` search).
2. Parsing batch torrents (`num_files > 1`), iterating through `files` array and matching episode filename.
3. Fallback to title search when `anidbId` returns 0 results.
4. Support expanded episode regex formats (`[Group] Show 06 [1080p]`, `Episode 06`, `06v2`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement AnimeTosho enhancements in `animetoshoProvider.ts`**

1. Expand `EPISODE_PATTERNS`:
```typescript
export const EPISODE_PATTERNS = [
  /S\d{1,2}E(\d{1,4})/i,
  /-\s*(\d{1,4})\s*\(/,
  /-\s*(\d{1,4})\s*\[/,
  /\s+(\d{1,4})\s*\[/i,
  /\b(?:ep|episode)\s*(\d{1,4})\b/i,
  /-\s*(\d{1,4})v\d\b/i,
  /-\s*(\d{1,4})(?:\.[a-z0-9]+)?\s*$/i,
];
```
2. In `findAnimeToshoSubtitle(anidbId: number | null, episode: number, lang: string, opts: AnimeToshoOptions = {})`:
- Perform primary search if `anidbId !== null`:
  `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${episode}&limit=50`
- If 0 results or `anidbId === null`, and `opts.title`:
  Sanitize title (remove non-alphanumeric chars, e.g. `title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()`) and query:
  `${feedBaseUrl}/json?t=search&q=${encodeURIComponent(`${cleanTitle} ${episode}`)}&limit=50`
- If total results from both searches are 0:
  Return `{ found: false, seriesNotFound: true }`.
- Filter candidates with `status === 'complete'`.
- For each candidate:
  - If `num_files === 1`:
    - Check if `parseEpisodeNumber(candidate.title) === episode`.
    - Fetch detail, check `detail.files[0].attachments`.
  - If `num_files > 1` (batch):
    - Fetch detail.
    - Find file in `detail.files` where `parseEpisodeNumber(file.filename) === episode`.
    - Check that file's `attachments`.
- Pass downloaded & decompressed subtitle through `convertToVtt(decompressed, ext, lang)` and `isAcceptableSubtitle(vttContent, lang)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/providers/animetoshoProvider.ts test/providers/animetoshoProvider.test.ts
git commit -m "feat(animetosho): support batch torrents, targeted episode queries, and title search fallback"
```

---

### Task 5: End-to-End Subtitles Handler Integration & Regression Testing

**Files:**
- Modify: `src/subtitlesHandler.ts`
- Test: `test/subtitlesHandler.test.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Updates `SubtitlesHandlerDeps.animetoshoProvider` to accept `opts: { timeoutMs?: number; title?: string | null }`
- Passes `ids.title` to `deps.animetoshoProvider`

- [ ] **Step 1: Write test in `subtitlesHandler.test.ts` verifying title is passed to AnimeTosho**

```typescript
  it('passes resolved anime title to animetoshoProvider for fallback searching', async () => {
    // assert deps.animetoshoProvider called with opts including title
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `subtitlesHandler.ts`**

1. In `SubtitlesHandlerDeps`:
```typescript
animetoshoProvider: (anidbId: number | null, episode: number, lang: string, opts?: { timeoutMs?: number; title?: string | null }) => Promise<ProviderResult>;
```
2. In `tryFastTiers(key, anidbId, deps, title?: string | null)`:
- Do not bypass AnimeTosho if `anidbId === null` when `title` is present.
- Pass `{ timeoutMs: deps.config.providerTimeoutMs, title }` to `deps.animetoshoProvider`.
- If `anidbId !== null && res.seriesNotFound`, call `deps.cache.setSeriesProviderMiss('animetosho', anidbId)`.

- [ ] **Step 4: Run full test suite to verify all tests pass**

Run: `npm test`
Expected: All test suites PASS (0 regressions).

- [ ] **Step 5: Commit changes**

```bash
git add src/subtitlesHandler.ts test/subtitlesHandler.test.ts
git commit -m "feat(handler): pass canonical title to AnimeTosho and integrate fast tier fallback"
```
