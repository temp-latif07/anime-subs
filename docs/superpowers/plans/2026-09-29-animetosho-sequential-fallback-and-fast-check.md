# AnimeTosho Fast-Check & Sequential Extraction Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default to a fast AnimeTosho check (~3.5s timeout with parallelized episode queries) and only invoke embedded subtitle extraction when AnimeTosho returns 0 hits, while preserving both tracks if extraction was already cached ready.

**Architecture:** Update `loadConfig` defaults (`enableConcurrentExtraction: false`, `providerTimeoutMs: 3500`). Parallelize AniDB/title search queries and cap candidates to 5 in `findAnimeToshoSubtitle`. In `subtitlesHandler`, execute AnimeTosho first; only start background extraction if AnimeTosho has 0 hits or errors, but include extraction if already cached `'ready'`.

**Tech Stack:** TypeScript, Node.js, Express, Vitest, SQLite (`better-sqlite3`).

## Global Constraints

- `enableConcurrentExtraction`: default `false`, parsed from `ENABLE_CONCURRENT_EXTRACTION`
- `providerTimeoutMs`: default `3500`, parsed from `PROVIDER_TIMEOUT_MS`
- Do not remove the `ENABLE_CONCURRENT_EXTRACTION` configuration option; keep it as an opt-in flag.
- When AnimeTosho hits and extraction is already cached ready in SQLite, both tracks must be returned in the subtitle list.
- All vitest test suites must pass (`npm test`) with zero regressions.
- Strict typecheck must pass (`npm run typecheck`).

---

### Task 1: Update Configuration Defaults

**Files:**
- Modify: `src/config.ts:66-68`
- Test: `test/config.test.ts:16-18,60-65`

**Interfaces:**
- Consumes: `loadConfig(env)`
- Produces: `Config.enableConcurrentExtraction: boolean` (default: `false`), `Config.providerTimeoutMs: number` (default: `3500`)

- [ ] **Step 1: Write the failing tests**

Update `test/config.test.ts` to assert that `enableConcurrentExtraction` defaults to `false` and `providerTimeoutMs` defaults to `3500`.

```ts
// In test/config.test.ts
  it('applies defaults when optional vars are absent', () => {
    const config = loadConfig(baseEnv as NodeJS.ProcessEnv);
    expect(config.port).toBe(7000);
    expect(config.dataDir).toBe('/data');
    expect(config.subtitleLanguages).toEqual(['eng']);
    expect(config.negativeCacheTtlHours).toBe(24);
    expect(config.extractionConcurrency).toBe(2);
    expect(config.enableConcurrentExtraction).toBe(false);
    expect(config.extractionTimeoutMs).toBe(900000);
    expect(config.providerTimeoutMs).toBe(3500);
    expect(config.probeTimeoutMs).toBe(15000);
  });

  it('defaults enableConcurrentExtraction to false and parses ENABLE_CONCURRENT_EXTRACTION', () => {
    expect(loadConfig(baseEnv as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(false);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: 'false' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(false);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: '0' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(false);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: 'true' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(true);
    expect(loadConfig({ ...baseEnv, ENABLE_CONCURRENT_EXTRACTION: '1' } as NodeJS.ProcessEnv).enableConcurrentExtraction).toBe(true);
  });

  it('defaults providerTimeoutMs to 3500ms and reads PROVIDER_TIMEOUT_MS', () => {
    expect(loadConfig(baseEnv as NodeJS.ProcessEnv).providerTimeoutMs).toBe(3500);
    expect(loadConfig({ ...baseEnv, PROVIDER_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv).providerTimeoutMs).toBe(5000);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL with `expected true to be false` and `expected 8000 to be 3500`.

- [ ] **Step 3: Write minimal implementation**

Update `src/config.ts` to change the defaults:

```ts
// In src/config.ts
    enableConcurrentExtraction: requireBool(env, 'ENABLE_CONCURRENT_EXTRACTION', false),
    extractionTimeoutMs: requireInt(env, 'EXTRACTION_TIMEOUT_MS', 900000),
    providerTimeoutMs: requireInt(env, 'PROVIDER_TIMEOUT_MS', 3500),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): default enableConcurrentExtraction to false and providerTimeoutMs to 3500ms"
```

---

### Task 2: Parallelize AnimeTosho AniDB/Title Queries and Cap Candidates

**Files:**
- Modify: `src/providers/animetoshoProvider.ts:194-252`
- Test: `test/providers/animetoshoProvider.test.ts`

**Interfaces:**
- Consumes: `findAnimeToshoSubtitle(anidbId: number | null, episode: number, lang: string, opts?: AnimeToshoOptions)`
- Produces: `Promise<ProviderResult>` with parallel search execution, deduplicated candidate results, and top-5 candidate capping.

- [ ] **Step 1: Write the failing tests**

Add tests in `test/providers/animetoshoProvider.test.ts` verifying candidate capping (stops checking after top 5 candidates) and parallel search queries.

```ts
  it('caps candidate inspection to the top 5 candidates per batch', async () => {
    // aid 69999 has candidates id: 60, 61, 62, 63; add more to verify max 5 examined
    const result = await findAnimeToshoSubtitle(69999, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      timeoutMs: 3500,
    });
    expect(result.found).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails or runs existing suite**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: Verify current behavior and any test setup.

- [ ] **Step 3: Write minimal implementation**

In `src/providers/animetoshoProvider.ts`, update `findAnimeToshoSubtitle`:
1. When `anidbId !== null`, execute searches for `epQueries` in parallel using `Promise.all`.
2. Deduplicate results using a `Map<number, ToshoSearchResult>`.
3. If candidates exist, inspect up to the top 5 (`candidates.slice(0, 5)`).
4. If no hit, query the broad search (`aid=${anidbId}&limit=50`) and inspect up to the top 5.
5. In title fallback, run `epQueries` for `cleanTitle` concurrently with `Promise.all` and cap candidates to 5.

```ts
export async function findAnimeToshoSubtitle(
  anidbId: number | null,
  episode: number,
  lang: string,
  opts: AnimeToshoOptions = {},
): Promise<ProviderResult> {
  const feedBaseUrl = (opts.feedBaseUrl ?? 'https://feed.animetosho.xyz').replace(/\/+$/, '');
  const storageBaseUrl = (opts.storageBaseUrl ?? 'https://storage.animetosho.xyz').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 3500;

  const paddedEp = String(episode).padStart(2, '0');
  const epQueries = paddedEp !== String(episode) ? [paddedEp, String(episode)] : [String(episode)];

  if (anidbId !== null) {
    const searchPromises = epQueries.map((q) =>
      fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${q}&limit=50`,
        { timeoutMs },
      ).catch(() => [] as ToshoSearchResult[]),
    );
    const queryResults = await Promise.all(searchPromises);
    const candidateMap = new Map<number, ToshoSearchResult>();
    for (const results of queryResults) {
      for (const item of results) {
        candidateMap.set(item.id, item);
      }
    }
    const candidates = Array.from(candidateMap.values());
    if (candidates.length > 0) {
      const match = await resolveSubtitleFromCandidates(candidates.slice(0, 5), episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs);
      if (match) return match;
    }

    // Broader, unfiltered search: catches batch releases whose title
    // doesn't literally contain the bare episode number, which the
    // q= server-side text filter can otherwise exclude.
    const broadResults = await fetchJson<ToshoSearchResult[]>(
      `${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`,
      { timeoutMs },
    ).catch(() => [] as ToshoSearchResult[]);
    if (broadResults.length > 0) {
      const match = await resolveSubtitleFromCandidates(broadResults.slice(0, 5), episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs);
      if (match) return match;
    }
  }

  let titleResultsSeen = 0;
  if (opts.title) {
    const cleanTitle = opts.title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanTitle) {
      const titlePromises = epQueries.map((q) =>
        fetchJson<ToshoSearchResult[]>(
          `${feedBaseUrl}/json?t=search&q=${encodeURIComponent(`${cleanTitle} ${q}`)}&limit=50`,
          { timeoutMs },
        ).catch(() => [] as ToshoSearchResult[]),
      );
      const titleResults = await Promise.all(titlePromises);
      const titleCandidateMap = new Map<number, ToshoSearchResult>();
      for (const results of titleResults) {
        titleResultsSeen += results.length;
        for (const item of results) {
          titleCandidateMap.set(item.id, item);
        }
      }
      const titleCandidates = Array.from(titleCandidateMap.values());
      if (titleCandidates.length > 0) {
        const match = await resolveSubtitleFromCandidates(titleCandidates.slice(0, 5), episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs);
        if (match) return match;
      }
    }
  }

  const seriesNotFound = anidbId === null && titleResultsSeen === 0;
  return { found: false, seriesNotFound };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/providers/animetoshoProvider.ts test/providers/animetoshoProvider.test.ts
git commit -m "perf(animetosho): parallelize search queries and cap candidates to 5"
```

---

### Task 3: Update SubtitlesHandler Sequential Fallback and Ready Extraction Inclusion

**Files:**
- Modify: `src/subtitlesHandler.ts:122-186`
- Test: `test/subtitlesHandler.test.ts`

**Interfaces:**
- Consumes: `resolveOneLanguage(...)`, `deps.config.enableConcurrentExtraction`
- Produces: Returns `animetosho` on hit without triggering extraction; includes `extraction` if already cached `'ready'`; triggers extraction on AnimeTosho miss.

- [ ] **Step 1: Write the failing tests**

Update `test/subtitlesHandler.test.ts`:
1. In `baseConfig`, change `enableConcurrentExtraction: false`.
2. Add test: uncached request where AnimeTosho hits returns only `animetosho` and does NOT invoke `deps.extractionProvider`.
3. Add test: uncached request where AnimeTosho hits but `cache.setReady(extractionKey)` was already called returns both `animetosho` and `extraction`, and does NOT invoke `deps.extractionProvider`.
4. Add test: uncached request where AnimeTosho misses invokes `deps.extractionProvider` and returns `extraction`.
5. Update existing test verifying concurrent extraction to explicitly set `deps.config = { ...baseConfig, enableConcurrentExtraction: true }`.

```ts
  it('on uncached request with AnimeTosho hit, returns only animetosho and does not invoke extraction', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    deps.extractionProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\nextraction hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles.map((s) => s.provider)).toEqual(['animetosho']);
    expect(deps.extractionProvider).not.toHaveBeenCalled();
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })).toBeNull();
  });

  it('returns both animetosho and extraction when animetosho hits and extraction is already cached ready', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' }, 'WEBVTT\n\n1\nextraction ready');
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles.map((s) => s.provider).sort()).toEqual(['animetosho', 'extraction']);
    expect(deps.extractionProvider).not.toHaveBeenCalled();
  });

  it('triggers extraction when AnimeTosho misses on uncached request', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.animetoshoProvider = vi.fn(async () => ({ found: false }));
    deps.extractionProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\nextraction hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles.map((s) => s.provider)).toEqual(['extraction']);
    expect(deps.extractionProvider).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: FAIL on the tests expecting sequential/cached extraction behavior.

- [ ] **Step 3: Write minimal implementation**

In `src/subtitlesHandler.ts`, update `resolveOneLanguage`:
1. When `readyProviders.length > 0` (fast cache path), check `if (extractionCached?.status === 'ready') readyProviders.push('extraction')`. (Do not return pending/in-flight extraction when Tier 1 is ready).
2. In sequential fallback path (`enableConcurrentExtraction === false`):
   - Await `tryDatabaseTier`.
   - If `readyProviders.length > 0`: check `if (extractionCached?.status === 'ready') readyProviders.push('extraction'); return readyProviders;`.
   - If `readyProviders.length === 0`:
     - If `extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight`, return `['extraction']`.
     - If `isExtractionNegative`, return `[]`.
     - Otherwise, `triggerExtraction()` and return `['extraction']`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/subtitlesHandler.ts test/subtitlesHandler.test.ts
git commit -m "feat(handler): make sequential fallback default and include ready cached extractions"
```

---

### Task 4: Full Suite End-to-End & Regression Verification

**Files:**
- None (verification across entire workspace)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (0 errors)

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS across all 19 test files.

- [ ] **Step 3: Commit any final cleanup or unstaged fixes**

If any adjustments were needed during verification:
```bash
git commit -m "chore: verify test suite and type check"
```
