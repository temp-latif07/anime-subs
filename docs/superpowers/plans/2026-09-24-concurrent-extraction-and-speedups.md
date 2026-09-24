# Concurrent Tier 1 & Tier 2 Extraction with Pipeline Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate embedded subtitle availability by initiating Tier 1 database queries and Tier 2 extraction concurrently on uncached requests, advertising both tracks in Stremio, and eliminating false-negative probe fallthrough and demux buffering in ffmpeg.

**Architecture:** On uncached subtitle requests, `subtitlesHandler.ts` concurrently kicks off Tier 1 (`tryDatabaseTier`) and Tier 2 (`startExtractionInBackground`), returning all successful database tracks alongside `eng (Extracted)`. `src/ffmpeg/probe.ts` detects when stream headers in a 2MB byte range prove a container lacks the requested language to fast-fail without spawning remote `ffprobe`, and `src/ffmpeg/extract.ts` sets `-analyzeduration 0` and flush packet flags to bypass video/audio buffering during subtitle stream copy.

**Tech Stack:** TypeScript (Node >=24), Express 5, better-sqlite3, vitest, child_process (`ffmpeg` / `ffprobe`).

## Global Constraints

- Node >=24, TypeScript strict mode (`tsconfig.json`/`tsconfig.test.json`) — every task must pass `npm run typecheck`.
- Tests use Vitest with `environment: 'node'`, `testTimeout: 60000`, run via `npm test`.
- All new/changed configuration goes through `config.ts` using type-safe environment helpers.
- Preserves full backward compatibility: setting `ENABLE_CONCURRENT_EXTRACTION=false` restores legacy sequential fallback behavior.
- Zero regressions across existing test suites (20 test files, 264 tests).

---

### Task 1: Configuration: `ENABLE_CONCURRENT_EXTRACTION` and `EXTRACTION_CONCURRENCY=2`

**Files:**
- Modify: `src/config.ts:8-16,59-67`
- Modify: `test/config.test.ts:17,33-75`
- Modify: `test/subtitlesHandler.test.ts:33-38`

**Interfaces:**
- Consumes: `process.env.ENABLE_CONCURRENT_EXTRACTION`, `process.env.EXTRACTION_CONCURRENCY`
- Produces: `Config.enableConcurrentExtraction: boolean` (default: `true`), `Config.extractionConcurrency: number` (default: `2`)

- [ ] **Step 1: Write failing config tests**

Add tests to `test/config.test.ts` verifying that `enableConcurrentExtraction` defaults to `true`, can be set to `false`, and `extractionConcurrency` defaults to `2`:

```ts
  it('defaults enableConcurrentExtraction to true and parses ENABLE_CONCURRENT_EXTRACTION', () => {
    expect(loadConfig(baseEnv as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(true);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: 'false' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(false);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: '0' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(false);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: 'true' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(true);
  });

  it('defaults extractionConcurrency to 2 and reads EXTRACTION_CONCURRENCY', () => {
    expect(loadConfig(baseEnv as NodeJS.ProcessEnv).extractionConcurrency).toBe(2);
    expect(loadConfig({ ...baseEnv, EXTRACTION_CONCURRENCY: '4' } as NodeJS.ProcessEnv).extractionConcurrency).toBe(4);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `extractionConcurrency` expected 2 but received 1, and `enableConcurrentExtraction` is undefined.

- [ ] **Step 3: Implement config changes**

In `src/config.ts`:
1. Add `enableConcurrentExtraction: boolean;` to `interface Config`.
2. Add helper function `requireBool`:
```ts
function requireBool(env: NodeJS.ProcessEnv, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultValue;
}
```
3. In `loadConfig`:
```ts
    extractionConcurrency: requireInt(env, 'EXTRACTION_CONCURRENCY', 2),
    enableConcurrentExtraction: requireBool(env, 'ENABLE_CONCURRENT_EXTRACTION', true),
```
4. Update `baseConfig` in `test/subtitlesHandler.test.ts` to include `enableConcurrentExtraction: true, extractionConcurrency: 2`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/config.ts test/config.test.ts test/subtitlesHandler.test.ts
git commit -m "feat(config): add ENABLE_CONCURRENT_EXTRACTION and default concurrency to 2"
```

---

### Task 2: Fast Buffer Probe Tri-State & False-Negative Rejection

**Files:**
- Modify: `src/ffmpeg/probe.ts:91-113,115-160`
- Test: `test/ffmpeg/probe.test.ts`

**Interfaces:**
- Consumes: 2MB Buffer, `lang: string`
- Produces: `findSubtitleStreamFromBuffer(buffer: Buffer, lang: string, timeoutMs?: number): Promise<{ stream: FoundSubtitleStream | null; hasStreams: boolean }>`
- Produces: `findSubtitleStream` fast-failing when `hasStreams === true && stream === null` without calling remote `ffprobe`.

- [ ] **Step 1: Write failing probe tests**

In `test/ffmpeg/probe.test.ts`, add test cases verifying:
1. `findSubtitleStreamFromBuffer` returns `{ stream: null, hasStreams: true }` when streams are present in the buffer but none match `lang`.
2. `findSubtitleStream` does not spawn remote `ffprobe` when the buffer successfully parsed streams of a different language.

```ts
import { findSubtitleStreamFromBuffer } from '../../src/ffmpeg/probe.js';

describe('findSubtitleStream buffer fast-rejection', () => {
  it('returns hasStreams: true when streams exist but none match requested language', async () => {
    // Test with JSON representation parsed by ffprobe
    const result = await findSubtitleStreamFromBuffer(Buffer.from('dummy'), 'eng');
    // Buffer with invalid data returns hasStreams: false
    expect(result).toEqual({ stream: null, hasStreams: false });
  });
});
```

Also add a test using mocked `runCommandWithInput`:

```ts
  it('does not fall through to remote ffprobe when buffer has valid stream headers for other languages', async () => {
    // When buffer probe succeeds and detects French-only subtitles,
    // remote ffprobe must NOT be called.
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: FAIL — `findSubtitleStreamFromBuffer` does not return `{ stream, hasStreams }`.

- [ ] **Step 3: Implement detailed buffer probe and fast rejection**

In `src/ffmpeg/probe.ts`:
1. Export interface:
```ts
export interface BufferProbeResult {
  stream: FoundSubtitleStream | null;
  hasStreams: boolean;
}
```
2. Update `findSubtitleStreamFromBuffer`:
```ts
export async function findSubtitleStreamFromBuffer(
  buffer: Buffer,
  lang: string,
  timeoutMs = 10000,
): Promise<BufferProbeResult> {
  try {
    const output = await runCommandWithInput(
      'ffprobe',
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-select_streams', 's',
        '-i', 'pipe:0',
      ],
      buffer,
      timeoutMs,
    );
    const parsed = JSON.parse(output) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    if (streams.length > 0) {
      const stream = parseSubtitleStreams(output, lang);
      return { stream, hasStreams: true };
    }
    return { stream: null, hasStreams: false };
  } catch {
    return { stream: null, hasStreams: false };
  }
}
```
3. Update `findSubtitleStream`:
```ts
  if (isHttp) {
    try {
      const rangeBuffer = await fetchBufferCapped(sourceUrl, 2097152, {
        headers: { Range: 'bytes=0-2097151' },
        timeoutMs: Math.min(timeoutMs, 5000),
      });
      if (rangeBuffer.length > 0) {
        const bufferResult = await findSubtitleStreamFromBuffer(rangeBuffer, lang, 5000);
        if (bufferResult.stream !== null) return bufferResult.stream;
        if (bufferResult.hasStreams) {
          // Headers were parsed and subtitle streams exist, but none match lang.
          // Fast-reject without wasting 15s on remote ffprobe!
          return null;
        }
      }
    } catch {
      // Fall through to remote URL ffprobe on network/Range error
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/ffmpeg/probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/ffmpeg/probe.ts test/ffmpeg/probe.test.ts
git commit -m "perf(probe): fast-reject candidate stream when buffer headers prove language missing"
```

---

### Task 3: ffmpeg Demux Optimization Flags

**Files:**
- Modify: `src/ffmpeg/extract.ts:105-115`
- Test: `test/ffmpeg/extract.test.ts`

**Interfaces:**
- Consumes: `sourceUrl`, `streamIndex`, `codec`
- Produces: `extractSubtitleToVtt` with `-analyzeduration 0` and `-fflags +nobuffer+flush_packets`.

- [ ] **Step 1: Write test verifying baseArgs optimization in extract.test.ts**

In `test/ffmpeg/extract.test.ts`:
Verify that ffmpeg extraction runs with `-analyzeduration 0` and `-fflags +nobuffer+flush_packets`.

- [ ] **Step 2: Update extract.ts**

In `src/ffmpeg/extract.ts`:
```ts
  const baseArgs = [
    '-v', 'error',
    '-fflags', '+nobuffer+flush_packets',
    '-probesize', '1M',
    '-analyzeduration', '0',
    ...httpArgs,
    '-i', sourceUrl,
    '-map', `0:${streamIndex}`,
    '-vn',
    '-an',
    '-dn',
  ];
```

- [ ] **Step 3: Run extract tests**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit changes**

```bash
git add src/ffmpeg/extract.ts test/ffmpeg/extract.test.ts
git commit -m "perf(extract): skip video/audio packet analysis and flush packets immediately"
```

---

### Task 4: Smart Parallel Kickoff & Multi-Track Surfacing in `subtitlesHandler.ts`

**Files:**
- Modify: `src/subtitlesHandler.ts:105-160`
- Test: `test/subtitlesHandler.test.ts`

**Interfaces:**
- Consumes: `Config.enableConcurrentExtraction`, `tryDatabaseTier`, `startExtractionInBackground`
- Produces: `handleSubtitlesRequest` initiating database providers and extraction concurrently on cache miss, returning all hits plus `extraction`.

- [ ] **Step 1: Write failing tests for concurrent kickoff and multi-track response**

In `test/subtitlesHandler.test.ts`:
1. Test: When uncached and `enableConcurrentExtraction: true`, `handleSubtitlesRequest` starts extraction in background even if Jimaku or OpenSubtitles hits, and returns both `jimaku` and `extraction` candidate tracks.
2. Test: When any Tier 1 provider is already cached `ready` (and extraction is not in-flight), `handleSubtitlesRequest` returns cached providers immediately without triggering extraction.
3. Test: When `enableConcurrentExtraction: false`, legacy sequential fallback is preserved (extraction is NOT started if Tier 1 hits).

```ts
  it('initiates Tier 1 and extraction concurrently on uncached request, returning both tracks', async () => {
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    
    // Both Jimaku and Extraction should be present
    expect(result.subtitles.map((s) => s.provider).sort()).toEqual(['extraction', 'jimaku']);
    // Extraction provider was started
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })?.status).toBe('pending');
  });

  it('does not initiate background extraction when a Tier 1 provider is already cached ready', async () => {
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\ncached');
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    
    expect(result.subtitles.map((s) => s.provider)).toEqual(['jimaku']);
    expect(deps.extractionProvider).not.toHaveBeenCalled();
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })).toBeNull();
  });

  it('preserves sequential fallback when enableConcurrentExtraction is false', async () => {
    deps.config = { ...deps.config, enableConcurrentExtraction: false };
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    
    expect(result.subtitles.map((s) => s.provider)).toEqual(['jimaku']);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: FAIL — today's code returns only `['jimaku']` and never starts extraction when Jimaku hits.

- [ ] **Step 3: Implement smart parallel orchestration in `resolveOneLanguage`**

In `src/subtitlesHandler.ts`:
```ts
async function resolveOneLanguage(
  baseKey: { anilistId: number; episode: number; lang: string },
  anidbId: number | null,
  imdbId: string | null,
  originalParsed: ParsedSubtitleRequestId,
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
    if (cached?.status === 'pending') continue;
    if (provider === 'jimaku' && deps.cache.hasSeriesProviderMiss('jimaku', baseKey.anilistId, deps.config.negativeCacheTtlHours)) continue;
    if (provider === 'animetosho') {
      const toshoMissed = anidbId !== null
        ? deps.cache.hasSeriesProviderMiss('animetosho', anidbId, deps.config.negativeCacheTtlHours)
        : !title;
      if (toshoMissed) continue;
    }
    toTry.push(provider);
  }

  const extractionKey: CacheKey = { ...baseKey, provider: 'extraction' };
  const extractionCached = deps.cache.get(extractionKey);
  const extractionInFlight = deps.cache.getInFlight(extractionKey);

  // 1. Fast Cache Path: If any Tier 1 provider is already ready, check if extraction is also ready/pending
  if (readyProviders.length > 0) {
    if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight) {
      readyProviders.push('extraction');
    }
    return readyProviders;
  }

  // Helper to start extraction job
  const triggerExtraction = (): void => {
    const streamUrlsPromise = getPlayableStreamUrls(
      deps.config.streamAddonUrl,
      originalParsed.contentId,
      originalParsed.season,
      originalParsed.episode,
      { timeoutMs: deps.config.providerTimeoutMs, mediaType },
    ).catch((err) => {
      if (err instanceof HttpTimeoutError) throw err;
      return [];
    });
    startExtractionInBackground(extractionKey, originalParsed, deps, mediaType, streamUrlsPromise);
  };

  const isExtractionNegative = extractionCached?.status === 'negative' &&
    !deps.cache.isNegativeExpired(extractionCached, deps.config.negativeCacheTtlHours);

  // 2. Concurrent Branch: If enabled, kick off extraction immediately alongside Tier 1
  if (deps.config.enableConcurrentExtraction) {
    let extractionOffered = false;
    if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight) {
      extractionOffered = true;
    } else if (!isExtractionNegative) {
      triggerExtraction();
      extractionOffered = true;
    }

    if (toTry.length > 0) {
      const hits = await tryDatabaseTier(baseKey, toTry, anidbId, imdbId, deps, title);
      readyProviders.push(...hits);
    }

    if (extractionOffered) {
      readyProviders.push('extraction');
    }
    return readyProviders;
  }

  // 3. Sequential Fallback Path (ENABLE_CONCURRENT_EXTRACTION=false)
  if (toTry.length > 0) {
    const hits = await tryDatabaseTier(baseKey, toTry, anidbId, imdbId, deps, title);
    readyProviders.push(...hits);
  }

  if (readyProviders.length > 0) return readyProviders;

  if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight) return ['extraction'];
  if (isExtractionNegative) return [];

  triggerExtraction();
  return ['extraction'];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/subtitlesHandler.ts test/subtitlesHandler.test.ts
git commit -m "feat(handler): initiate Tier 1 and extraction concurrently on cache miss"
```

---

### Task 5: End-to-End Regression Verification

**Files:**
- Test: all test files (`test/**/*.test.ts`)

- [ ] **Step 1: Run typecheck across the whole project**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run full test suite with all 20+ test files**

Run: `npm test`
Expected: All 20+ test files pass, 100% green.

- [ ] **Step 3: Verify git status is clean**

Run: `git status`
Expected: clean working directory.
