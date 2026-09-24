# Full-Dialogue Subtitle Enforcement & Forced Track Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely eliminate forced and signs/songs-only subtitle tracks from being served by `animetoshoProvider` and `probe.ts`, prioritize full dialogue tracks (default flag and file size), and purge existing corrupted cache entries like `195600:2:eng:animetosho`.

**Architecture:** In `animetoshoProvider.ts`, filter out attachments where `forced === 1` or title/name matches `forced`, `sign`, or `song`, then sort candidate attachments by `default: 1` first and descending byte size second. In `probe.ts`, filter streams to exclude `disposition.forced === 1` and titles with `forced`, `sign`, or `song`, sort remaining dialogue streams by `disposition.default === 1` first, and return `null` if no dialogue streams exist. In `cacheStore.ts`, implement `deleteByKey` with disk file unlinking and purge known contaminated forced entries (such as `195600:2:eng:animetosho`) on store initialization.

**Tech Stack:** TypeScript, Node.js (`better-sqlite3`, `node:fs`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-forced-subtitle-filtering-design.md`

## Global Constraints

- Never serve a forced or sign/song-only subtitle track when full dialogue is expected.
- If all subtitle attachments or streams for a requested language are forced or signs/songs, return not found (`found: false` or `null`) so fallback providers or tiers can provide full dialogue subtitles.
- Maintain existing provider and probe signatures: `findAnimeToshoSubtitle` returns `Promise<ProviderResult>`, `parseSubtitleStreams` returns `FoundSubtitleStream | null`.
- Unlink `.vtt` files from disk when cache entries are deleted to prevent orphaned files.
- All existing Vitest suites must pass with zero regressions (`npm test`).

## Review Focus

- Correct filtering of both flag-based (`forced === 1` / `disposition.forced === 1`) and name-based (`forced`, `sign`, `signs`, `song`, `songs` in name/title) tracks.
- Attachment sorting order: `default: 1` first, then secondary sort by descending size `size`.
- Stream selection in `probe.ts`: Dialogue streams must be filtered first before selecting text vs bitmap; `disposition.default === 1` prioritized; return `null` when no dialogue streams exist.
- Cache purge cleans both the SQLite database record and the `.vtt` file on disk.

---

## Task 1: AnimeTosho Forced/Signs Attachment Filtering & Prioritization

**Files:**
- Modify: `src/providers/animetoshoProvider.ts:14-19`, `src/providers/animetoshoProvider.ts:143-166`
- Test: `test/providers/animetoshoProvider.test.ts`

**Interfaces:**
- Consumes: `ToshoAttachment` interface and `findAnimeToshoSubtitle()` in `src/providers/animetoshoProvider.ts`.
- Produces: Exported helper `isForcedOrSignsAttachment(info?: ToshoAttachment['info']): boolean` and updated attachment filtering and sorting in `findAnimeToshoSubtitle()`.

- [ ] **Step 1: Write the failing tests**

Add the following tests to `test/providers/animetoshoProvider.test.ts` inside the `describe('findAnimeToshoSubtitle', ...)` block:

```ts
  it('filters out forced tracks and selects the full dialogue subtitle track based on size', async () => {
    // ID 60 has two English attachments: Track 1 (Forced, 6KB) and Track 2 (Full, 35KB)
    const result = await findAnimeToshoSubtitle(69999, 1, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Full dialogue subtitle line');
  });

  it('filters out tracks whose name contains "[Forced]" or "Signs" even if forced flag is 0 or omitted', async () => {
    // ID 61 has Track 1 with name "English [Forced]" (no forced flag) and Track 2 with name "Full Dialogue"
    const result = await findAnimeToshoSubtitle(69999, 2, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Full dialogue subtitle line');
  });

  it('prioritizes default: 1 attachments over non-default attachments', async () => {
    // ID 62 has Track 1 (default: 0, 40KB) and Track 2 (default: 1, 25KB)
    const result = await findAnimeToshoSubtitle(69999, 3, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Default track subtitle line');
  });

  it('returns found: false when all attachments for the requested language are forced or signs/songs', async () => {
    // ID 63 has only forced/signs attachments for English
    const result = await findAnimeToshoSubtitle(69999, 4, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
  });
```

And in `beforeAll` in `test/providers/animetoshoProvider.test.ts`, add the mock server routes and fixture buffers:

```ts
  let compressedFullDialogueAss: Buffer;
  let compressedDefaultAss: Buffer;
  let compressedForcedAss: Buffer;
```

In `beforeAll`:
```ts
    compressedFullDialogueAss = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Full dialogue subtitle line\n'),
    });
    compressedDefaultAss = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Default track subtitle line\n'),
    });
    compressedForcedAss = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Forced signs line only\n'),
    });
```

In the mock server handler:
- Search handler when `aid === '69999'`:
```ts
        } else if (aid === '69999') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 60, title: '[Group] Show - 01 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 61, title: '[Group] Show - 02 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 62, title: '[Group] Show - 03 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 63, title: '[Group] Show - 04 [1080p].mkv', status: 'complete', num_files: 1 },
          ]));
```
- Detail handler for `id === '60'`:
```ts
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '60') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 01 [1080p].mkv',
            attachments: [
              { id: 6001, type: 'subtitle', size: 6000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, forced: 1 } },
              { id: 6002, type: 'subtitle', size: 35000, info: { codec: 'ASS', lang: 'eng', tracknum: 2, forced: 0 } },
            ],
          }],
        }));
```
- Detail handler for `id === '61'`:
```ts
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '61') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 02 [1080p].mkv',
            attachments: [
              { id: 6101, type: 'subtitle', size: 10000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, name: 'CR ASS) English [Forced]' } },
              { id: 6102, type: 'subtitle', size: 15000, info: { codec: 'ASS', lang: 'eng', tracknum: 2, name: 'English (Full)' } },
            ],
          }],
        }));
```
- Detail handler for `id === '62'`:
```ts
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '62') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 03 [1080p].mkv',
            attachments: [
              { id: 6201, type: 'subtitle', size: 40000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, default: 0 } },
              { id: 6202, type: 'subtitle', size: 25000, info: { codec: 'ASS', lang: 'eng', tracknum: 2, default: 1 } },
            ],
          }],
        }));
```
- Detail handler for `id === '63'`:
```ts
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '63') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 04 [1080p].mkv',
            attachments: [
              { id: 6301, type: 'subtitle', size: 5000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, forced: 1, name: 'Signs & Songs' } },
            ],
          }],
        }));
```
- Storage download endpoints for attachments 6001, 6002, 6101, 6102, 6201, 6202, 6301:
```ts
      } else if (url.pathname.includes('00001771') || url.pathname.includes('000017d5') || url.pathname.includes('0000189d')) {
        // 6001, 6101, 6301 are forced
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedForcedAss);
      } else if (url.pathname.includes('00001772') || url.pathname.includes('000017d6') || url.pathname.includes('00001839')) {
        // 6002, 6102, 6201 are full dialogue
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedFullDialogueAss);
      } else if (url.pathname.includes('0000183a')) {
        // 6202 is default track
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedDefaultAss);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: FAIL — Track 1 (forced) is selected instead of Track 2 because `animetoshoProvider.ts` does not yet filter out forced tracks or prioritize by default/size.

- [ ] **Step 3: Implement forced/signs filtering and sorting in `animetoshoProvider.ts`**

In `src/providers/animetoshoProvider.ts`:
Update `ToshoAttachment`:
```ts
export interface ToshoAttachment {
  id: number;
  type: string;
  size?: number;
  info?: {
    codec?: string;
    lang?: string;
    tracknum?: number;
    forced?: number;
    default?: number;
    name?: string;
  };
}
```

Add exported helper:
```ts
export function isForcedOrSignsAttachment(info?: ToshoAttachment['info']): boolean {
  if (!info) return false;
  if (info.forced === 1) return true;
  const name = (info.name ?? '').toLowerCase();
  return name.includes('forced') || name.includes('sign') || name.includes('song');
}
```

In `findAnimeToshoSubtitle()`, update the subtitle attachment filtering and sorting:
```ts
      const subtitleAttachments = (targetFile.attachments ?? []).filter(
        (a) =>
          a.type === 'subtitle' &&
          a.info?.lang === lang &&
          a.info?.codec &&
          a.info.tracknum !== undefined &&
          !isForcedOrSignsAttachment(a.info),
      );

      subtitleAttachments.sort((a, b) => {
        const aDef = a.info?.default === 1 ? 1 : 0;
        const bDef = b.info?.default === 1 ? 1 : 0;
        if (aDef !== bDef) {
          return bDef - aDef;
        }
        return (b.size ?? 0) - (a.size ?? 0);
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/providers/animetoshoProvider.ts test/providers/animetoshoProvider.test.ts
git commit -m "feat(animetosho): filter forced/signs attachments and prioritize default/larger tracks"
```

---

## Task 2: FFmpeg Probe Forced & Signs Stream Filtering Hardening

**Files:**
- Modify: `src/ffmpeg/probe.ts:14-21`, `src/ffmpeg/probe.ts:96-118`
- Test: `test/ffmpeg/probe.test.ts`

**Interfaces:**
- Consumes: `FfprobeStream` and `parseSubtitleStreams()` in `src/ffmpeg/probe.ts`.
- Produces: Exported helper `isForcedOrSignsStream(s: FfprobeStream): boolean` and hardened dialogue stream selection in `parseSubtitleStreams()`.

- [ ] **Step 1: Write the failing tests**

In `test/ffmpeg/probe.test.ts`, add the following tests inside the `describe('parseSubtitleStreams', ...)` block:

```ts
  it('ignores streams with disposition: { forced: 1 } in favor of full dialogue stream', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', disposition: { forced: 1 }, tags: { language: 'eng', title: 'English' } },
        { index: 2, codec_name: 'ass', disposition: { forced: 0 }, tags: { language: 'eng', title: 'English' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('ignores streams with title containing "[Forced]" or "signs" in favor of full dialogue stream', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', tags: { language: 'eng', title: 'English [Forced]' } },
        { index: 2, codec_name: 'ass', tags: { language: 'eng', title: 'English Dialogue' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('prioritizes streams with disposition: { default: 1 } among dialogue streams', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', disposition: { default: 0 }, tags: { language: 'eng', title: 'Secondary Dialogue' } },
        { index: 2, codec_name: 'ass', disposition: { default: 1 }, tags: { language: 'eng', title: 'Default Dialogue' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('returns null when all streams for requested language are forced or signs/songs', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', disposition: { forced: 1 }, tags: { language: 'eng', title: 'Signs & Songs' } },
        { index: 2, codec_name: 'subrip', tags: { language: 'eng', title: 'English [Forced]' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toBeNull();
  });
```

And update the existing test in `test/ffmpeg/probe.test.ts` (lines 75-84):
Old test:
```ts
  it('falls back to first text stream if all text streams are sign/song titled', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'subrip', tags: { language: 'eng', title: 'Songs & Signs' } },
        { index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'Full' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 1, codec: 'subrip' });
  });
```
Update it to reflect that the sign/song stream is rejected in favor of the dialogue stream:
```ts
  it('rejects sign/song text stream and chooses full dialogue stream even if bitmap', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'subrip', tags: { language: 'eng', title: 'Songs & Signs' } },
        { index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'Full' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'hdmv_pgs_subtitle' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: FAIL — `parseSubtitleStreams` does not yet inspect `disposition.forced` or title `[Forced]`, or sort by `default: 1`.

- [ ] **Step 3: Implement stream filtering and sorting in `probe.ts`**

In `src/ffmpeg/probe.ts`:
Update `FfprobeStream`:
```ts
export interface FfprobeStream {
  index: number;
  codec_name?: string;
  disposition?: { forced?: number; default?: number };
  tags?: { language?: string; title?: string };
}
```

Add exported helper:
```ts
export function isForcedOrSignsStream(s: FfprobeStream): boolean {
  if (s.disposition?.forced === 1) return true;
  const title = (s.tags?.title ?? '').toLowerCase();
  return title.includes('forced') || title.includes('sign') || title.includes('song');
}
```

Update `parseSubtitleStreams`:
```ts
export function parseSubtitleStreams(output: string, lang: string): FoundSubtitleStream | null {
  try {
    const parsed = JSON.parse(output) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const matching = streams.filter((s) => s.tags?.language === lang);
    if (matching.length === 0) return null;

    const dialogueStreams = matching.filter((s) => !isForcedOrSignsStream(s));
    if (dialogueStreams.length === 0) return null;

    const textStreams = dialogueStreams.filter((s) =>
      TEXT_SUBTITLE_CODECS.has((s.codec_name ?? '').toLowerCase()),
    );
    const pool = textStreams.length > 0 ? textStreams : dialogueStreams;

    pool.sort((a, b) => {
      const aDef = a.disposition?.default === 1 ? 1 : 0;
      const bDef = b.disposition?.default === 1 ? 1 : 0;
      return bDef - aDef;
    });

    const selected = pool[0];
    return {
      index: selected.index,
      codec: (selected.codec_name ?? 'ass').toLowerCase(),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/probe.ts test/ffmpeg/probe.test.ts
git commit -m "feat(probe): filter forced and signs streams and prioritize default dialogue stream"
```

---

## Task 3: Cache Invalidation & Known Forced Subtitles Purge

**Files:**
- Modify: `src/cache/cacheStore.ts:1-5`, `src/cache/cacheStore.ts:118-121`
- Test: `test/cache/cacheStore.test.ts`

**Interfaces:**
- Consumes: `CacheStore` in `src/cache/cacheStore.ts`.
- Produces: `deleteByKey(rawKey: string): boolean`, disk file removal on delete, and `purgeKnownForcedEntries(): number` called on `CacheStore` instantiation.

- [ ] **Step 1: Write the failing tests**

In `test/cache/cacheStore.test.ts`, add the following tests inside the `describe('CacheStore', ...)` block:

```ts
  it('deleteByKey removes the database entry and unlinks the file from disk', () => {
    const toshoKey = { ...key, provider: 'animetosho' as const };
    const filePath = store.setReady(toshoKey, 'WEBVTT\n\n1\nhello');
    expect(existsSync(filePath)).toBe(true);

    const deleted = store.deleteByKey(`${toshoKey.anilistId}:${toshoKey.episode}:${toshoKey.lang}:${toshoKey.provider}`);
    expect(deleted).toBe(true);
    expect(store.get(toshoKey)).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('delete removes the database entry and unlinks the file from disk', () => {
    const toshoKey = { ...key, provider: 'animetosho' as const };
    const filePath = store.setReady(toshoKey, 'WEBVTT\n\n1\nhello');
    expect(existsSync(filePath)).toBe(true);

    store.delete(toshoKey);
    expect(store.get(toshoKey)).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('purges known forced cache entries (e.g. 195600:2:eng:animetosho) on initialization', () => {
    const forcedKey = { anilistId: 195600, episode: 2, lang: 'eng', provider: 'animetosho' as const };
    const filePath = store.setReady(forcedKey, 'WEBVTT\n\n1\nForced subtitle line');
    expect(store.get(forcedKey)).not.toBeNull();
    expect(existsSync(filePath)).toBe(true);

    // Re-initialize a new CacheStore on the same directory
    const dbPath = join(dir, 'cache.db');
    const newStore = new CacheStore(dbPath, join(dir, 'files'));
    try {
      expect(newStore.get(forcedKey)).toBeNull();
      expect(existsSync(filePath)).toBe(false);
    } finally {
      newStore.close();
    }
  });
```

Make sure `existsSync` is imported in `test/cache/cacheStore.test.ts`:
```ts
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: FAIL — `deleteByKey` is not defined and known forced entries are not purged on startup.

- [ ] **Step 3: Implement `deleteByKey` and forced entries purge in `cacheStore.ts`**

In `src/cache/cacheStore.ts`:
1. Import `unlinkSync`:
```ts
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
```

2. Add `deleteByKey`:
```ts
  deleteByKey(rawKey: string): boolean {
    const row = this.db
      .prepare('SELECT file_path FROM cache WHERE key = ?')
      .get(rawKey) as { file_path: string | null } | undefined;
    if (row?.file_path && existsSync(row.file_path)) {
      try {
        unlinkSync(row.file_path);
      } catch {
        // file unlink error ignored
      }
    }
    const result = this.db.prepare('DELETE FROM cache WHERE key = ?').run(rawKey);
    return result.changes > 0;
  }
```

3. Update `delete`:
```ts
  delete(key: CacheKey): void {
    this.deleteByKey(keyId(key));
  }
```

4. Add `purgeKnownForcedEntries`:
```ts
  purgeKnownForcedEntries(): number {
    const KNOWN_FORCED_KEYS = ['195600:2:eng:animetosho'];
    let count = 0;
    for (const rawKey of KNOWN_FORCED_KEYS) {
      if (this.deleteByKey(rawKey)) {
        count++;
      }
    }
    return count;
  }
```

5. Call `this.purgeKnownForcedEntries()` in `constructor`:
```ts
    this.migrateTierColumnIfPresent(columns);
    this.purgeKnownForcedEntries();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/cache/cacheStore.ts test/cache/cacheStore.test.ts
git commit -m "feat(cache): add deleteByKey with disk unlinking and purge known forced entries on startup"
```

---

## Task 4: Full Regression Suite Verification

**Files:**
- Test: All 21 test files (`test/**/*.test.ts`)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: 21 test files passed, zero failures.

- [ ] **Step 2: Commit (if any adjustments were needed) or tag ready**

Run: `git status`
Verify workspace is clean with all tasks committed.
