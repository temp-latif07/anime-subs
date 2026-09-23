# Tier 3 Subtitle Extraction Performance Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accelerate Tier 3 subtitle extraction on cache misses from ~20s down to ~4–6s by optimizing ffmpeg HTTP socket buffers and stream copying, probing containers in-memory via HTTP byte ranges, parallelizing stream addon queries, adding series-level negative caching for fast tiers, and overlapping stream resolution.

**Architecture:**
1. In `src/ffmpeg/probe.ts`, add an in-memory buffer probe using a 2MB HTTP byte-range request piped to `ffprobe -i pipe:0`, returning both stream `index` and `codec`.
2. In `src/ffmpeg/extract.ts`, configure ffmpeg HTTP socket options (`-buffer_size 4M`, `-multiple_requests 1`), remove `-fflags +fastseek`, and perform codec-aware stream copy (`-c:s copy`) for ASS and SRT before falling back to transcoding.
3. In `src/providers/streamAddonClient.ts`, accept Stremio's media `type` (`series` vs `anime`) and evaluate candidate endpoints concurrently rather than serially.
4. In `src/cache/cacheStore.ts`, store series-level negative cache hits for Jimaku and AnimeTosho to bypass fast tiers for episodes 2+ of unindexed anime.
5. In `src/subtitlesHandler.ts`, pre-fetch playable stream URLs concurrently while fast tiers are running, so stream URLs are ready immediately on fast tier miss.

**Tech Stack:** TypeScript, Node.js (`child_process`, `node:http`), Express, SQLite (`better-sqlite3`), Vitest, ffmpeg / ffprobe.

## Global Constraints
- Single-tenant, self-hosted Docker compatibility.
- Zero regression on existing 16 test suites (118 tests).
- All changes must adhere strictly to TDD (test-first, confirm failure, implement, confirm pass).
- Avoid unnecessary external dependencies; use native Node.js APIs and existing libraries (`better-sqlite3`).

---

### Task 1: ffmpeg HTTP Options, Codec Detection, and Stream Copy

**Files:**
- Modify: `src/ffmpeg/probe.ts`
- Modify: `src/ffmpeg/extract.ts`
- Modify: `src/providers/extractionProvider.ts`
- Test: `test/ffmpeg/extract.test.ts`

**Interfaces:**
- Consumes: `ffprobe` JSON stream metadata
- Produces: `findSubtitleStream(sourceUrl, lang, timeoutMs)` returning `Promise<{ index: number; codec: string } | null>`
- Produces: `extractSubtitleToVtt(sourceUrl, streamIndex, codec, timeoutMs)` returning `Promise<string>` (with backward compatibility if `codec` is omitted)

- [ ] **Step 1: Write failing test for `findSubtitleStream` returning index and codec**

Add tests in `test/ffmpeg/extract.test.ts` asserting that `findSubtitleStream` returns `{ index: 1, codec: 'subrip' }` (or `ass`) for the test fixture, and that `extractSubtitleToVtt` with stream copy succeeds.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: FAIL (function or property not defined).

- [ ] **Step 3: Update `probe.ts` to capture codec and export `findSubtitleStream`**

In `src/ffmpeg/probe.ts`:
1. Update `FfprobeStream` interface:
   ```typescript
   interface FfprobeStream {
     index: number;
     codec_name?: string;
     tags?: { language?: string; title?: string };
   }
   ```
2. Implement `findSubtitleStream(sourceUrl: string, lang: string, timeoutMs?: number): Promise<{ index: number; codec: string } | null>`.
3. Retain `findSubtitleStreamIndex` as a wrapper for backward compatibility.
4. Add `-buffer_size 4194304`, `-multiple_requests 1` to ffprobe's `httpArgs`.

- [ ] **Step 4: Update `extract.ts` with tuned HTTP flags and codec-aware stream copy**

In `src/ffmpeg/extract.ts`:
1. In `httpArgs`, add:
   ```typescript
   '-buffer_size', '4194304',
   '-multiple_requests', '1',
   ```
2. Remove `-fflags +fastseek`.
3. In `extractSubtitleToVtt(sourceUrl: string, streamIndex: number, codec?: string, timeoutMs?: number)`:
   - If `codec === 'ass' || codec === 'ssa'`: extract with `-c:s copy -y outAssPath`, then `convertAssToVtt`.
   - If `codec === 'subrip' || codec === 'srt'`: extract with `-c:s copy -y outSrtPath`, then `convertToVtt(readFileSync(outSrtPath), 'srt')`.
   - If copy fails or codec unknown: fall back to `-c:s webvtt -y outVttPath` and `normalizeVtt`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/ffmpeg/extract.test.ts test/providers/extractionProvider.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit changes**

```bash
git add src/ffmpeg/probe.ts src/ffmpeg/extract.ts src/providers/extractionProvider.ts test/ffmpeg/extract.test.ts
git commit -m "perf(ffmpeg): tune HTTP buffer size and add codec-aware stream copy"
```

---

### Task 2: In-Memory 2MB Buffer Probe via HTTP Range Request

**Files:**
- Modify: `src/ffmpeg/probe.ts`
- Test: `test/ffmpeg/extract.test.ts`
- Test: `test/providers/extractionProvider.test.ts`

**Interfaces:**
- Consumes: `fetchBuffer` with `Range: bytes=0-2097151`
- Produces: `findSubtitleStream` that attempts an in-memory buffer probe before falling back to remote URL probe.

- [ ] **Step 1: Write test verifying buffer probe functionality**

In `test/ffmpeg/extract.test.ts`, test that `findSubtitleStreamFromBuffer(buffer, lang)` correctly parses subtitles from a 2MB buffer slice of an MKV file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: FAIL with `findSubtitleStreamFromBuffer is not defined`.

- [ ] **Step 3: Implement buffer probe in `src/ffmpeg/probe.ts`**

1. Implement `runCommandWithInput(command: string, args: string[], input: Buffer, timeoutMs: number): Promise<string>`.
2. Implement `findSubtitleStreamFromBuffer(buffer: Buffer, lang: string, timeoutMs?: number): Promise<{ index: number; codec: string } | null>`.
   Run `ffprobe -v quiet -print_format json -show_streams -select_streams s -i pipe:0`.
3. In `findSubtitleStream(sourceUrl, lang, timeoutMs)`:
   If `sourceUrl` starts with `http://` or `https://`:
   Attempt `fetchBuffer(sourceUrl, { headers: { Range: 'bytes=0-2097151' }, timeoutMs: 5000 })`.
   If successful and buffer length > 0:
     Try `findSubtitleStreamFromBuffer(buffer, lang)`. If a stream is found, return it immediately!
   If buffer probe throws or finds no stream: fall back to remote URL probe.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit changes**

```bash
git add src/ffmpeg/probe.ts test/ffmpeg/extract.test.ts
git commit -m "perf(probe): implement fast in-memory 2MB buffer probe via HTTP Range"
```

---

### Task 3: Stream Addon Query Parallelization & Type-Awareness

**Files:**
- Modify: `src/providers/streamAddonClient.ts`
- Modify: `src/providers/extractionProvider.ts`
- Modify: `src/subtitlesHandler.ts`
- Modify: `src/server.ts`
- Test: `test/providers/streamAddonClient.test.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `mediaType?: string` (`'series'` | `'anime'`) from Stremio request route
- Produces: `getPlayableStreamUrls` executing prioritized candidate requests concurrently.

- [ ] **Step 1: Write failing test for type-prioritized and concurrent stream URL resolution**

In `test/providers/streamAddonClient.test.ts`, add a test verifying that when `mediaType: 'anime'` is provided, `anime` endpoints are queried first without waiting through failed `series` queries, and candidate endpoints are queried concurrently.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/streamAddonClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement parallel and type-aware candidate resolution**

In `src/providers/streamAddonClient.ts`:
1. Accept `mediaType?: string` in `opts`.
2. Order `types`: if `mediaType` is `'anime'`, `['anime', 'series']`; otherwise `['series', 'anime']`.
3. Construct list of target URLs in priority order.
4. Concurrently query target URLs in priority batches or with `Promise.any`, returning as soon as playable streams are found.
5. In `src/server.ts`, pass `req.params.type` to `handleSubtitlesRequest(rawId, deps, req.params.type)`.
6. Forward `mediaType` through `subtitlesHandler.ts` and `extractionProvider.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/providers/streamAddonClient.test.ts test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit changes**

```bash
git add src/providers/streamAddonClient.ts src/providers/extractionProvider.ts src/subtitlesHandler.ts src/server.ts test/providers/streamAddonClient.test.ts test/server.test.ts
git commit -m "perf(streamAddon): query candidate stream URLs concurrently with media type prioritization"
```

---

### Task 4: Series-Level Negative Caching for Fast Tiers

**Files:**
- Modify: `src/cache/cacheStore.ts`
- Modify: `src/subtitlesHandler.ts`
- Modify: `src/providers/jimakuProvider.ts`
- Modify: `src/providers/animetoshoProvider.ts`
- Test: `test/cache/cacheStore.test.ts`
- Test: `test/subtitlesHandler.test.ts`

**Interfaces:**
- Consumes: Provider miss events for `anilistId` (Jimaku) or `anidbId` (AnimeTosho)
- Produces: `cache.hasProviderMiss(provider, seriesId, ttlHours)` and `cache.setProviderMiss(provider, seriesId)`

- [ ] **Step 1: Write failing tests for series-level provider negative cache**

In `test/cache/cacheStore.test.ts`, write tests for `setProviderMiss` and `hasProviderMiss` with TTL expiration.
In `test/subtitlesHandler.test.ts`, write a test asserting that if Jimaku or AnimeTosho returned a series-level miss on episode 1, episode 2 skips calling that provider entirely.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cache/cacheStore.test.ts test/subtitlesHandler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement series provider cache in `CacheStore`**

In `src/cache/cacheStore.ts`:
1. Add table:
   ```sql
   CREATE TABLE IF NOT EXISTS series_provider_cache (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     series_id INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ```
2. Add methods:
   - `setSeriesProviderMiss(provider: 'jimaku' | 'animetosho', seriesId: number): void`
   - `hasSeriesProviderMiss(provider: 'jimaku' | 'animetosho', seriesId: number, ttlHours: number): boolean`

- [ ] **Step 4: Integrate series negative caching into providers and `subtitlesHandler.ts`**

1. When `jimakuProvider` finds no entry matching the anime, return a flag or signal to mark `setSeriesProviderMiss('jimaku', anilistId)`.
2. When `animetoshoProvider` finds no search results for `anidbId`, mark `setSeriesProviderMiss('animetosho', anidbId)`.
3. In `tryFastTiers`, skip Jimaku if `cache.hasSeriesProviderMiss('jimaku', key.anilistId, ttlHours)` is true, and skip AnimeTosho if `cache.hasSeriesProviderMiss('animetosho', anidbId, ttlHours)` is true.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/cache/cacheStore.test.ts test/subtitlesHandler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit changes**

```bash
git add src/cache/cacheStore.ts src/subtitlesHandler.ts test/cache/cacheStore.test.ts test/subtitlesHandler.test.ts
git commit -m "perf(cache): add series-level negative caching for Jimaku and AnimeTosho"
```

---

### Task 5: Overlapped Stream Resolution on Cache Miss

**Files:**
- Modify: `src/subtitlesHandler.ts`
- Test: `test/subtitlesHandler.test.ts`

**Interfaces:**
- Consumes: Cache miss event
- Produces: Concurrent pre-fetching of playable stream URLs while `tryFastTiers` is evaluated.

- [ ] **Step 1: Write test for concurrent stream URL pre-fetching**

In `test/subtitlesHandler.test.ts`, assert that when a cache miss occurs, `getPlayableStreamUrls` (or stream resolution) is initiated immediately without waiting for `tryFastTiers` to finish.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement concurrent pre-fetching in `resolveOneLanguage`**

In `src/subtitlesHandler.ts`:
1. When checking a cache miss, immediately initiate `streamUrlsPromise = getPlayableStreamUrls(...)`.
2. Await `tryFastTiers(key, anidbId, deps)`.
3. If `tryFastTiers` hits, ignore `streamUrlsPromise`.
4. If `tryFastTiers` misses, pass `streamUrlsPromise` directly into `startExtractionInBackground` so extraction starts immediately with the already-resolved stream URLs!

- [ ] **Step 4: Run all tests to verify full regression test passes**

Run: `npm test`
Expected: All tests pass across the entire repository.

- [ ] **Step 5: Commit changes**

```bash
git add src/subtitlesHandler.ts test/subtitlesHandler.test.ts
git commit -m "perf(subtitlesHandler): overlap stream URL resolution with fast tiers check"
```

---

### Task 6: End-to-End Verification & Benchmark Verification

**Files:**
- Test: `test/providers/extractionProvider.test.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Run full test suite with coverage**
Run: `npm test`
Expected: 16 test files pass, 100% tests green.

- [ ] **Step 2: Verify git status is clean and documentation is updated**
Verify no leftover artifacts or temporary files.
Update `README.md` or design documentation if relevant.
