# AnimeTosho Fast-Check & Sequential Extraction Fallback Design

## Context
Previously, `anime-subs` defaulted to running Tier 1 database providers and Tier 2 embedded extraction concurrently (`ENABLE_CONCURRENT_EXTRACTION=true`). This was introduced to minimize user wait times because Tier 2 extraction takes 25–45s and Tier 1 providers were slower or less comprehensive.

Now, OpenSubtitles and Jimaku have been retired, leaving AnimeTosho as the sole Tier 1 provider. AnimeTosho has proven highly reliable. Triggering embedded ffmpeg extraction concurrently on every uncached request creates unnecessary server CPU load, consumes bandwidth probing media streams, and clutters the Stremio subtitle picker with redundant extracted tracks.

This design shifts the default execution to a sequential fallback model:
1. Quickly check AnimeTosho first (bounded by an optimized parallel search and tighter 3.5s timeout).
2. Only initiate embedded extraction if AnimeTosho returns 0 hits (or fails).
3. If extraction was already cached as ready in SQLite from an earlier run, preserve both tracks in Stremio's subtitle picker.

---

## Scope

### In Scope
- **Configuration Defaults (`src/config.ts`)**:
  - Update `ENABLE_CONCURRENT_EXTRACTION` default from `true` to `false`.
  - Update `PROVIDER_TIMEOUT_MS` default from `8000` to `3500`.
- **Fast-Check Optimization in AnimeTosho Provider (`src/providers/animetoshoProvider.ts`)**:
  - Issue episode-filtered AniDB search queries concurrently via `Promise.all` instead of serially.
  - Deduplicate candidate torrents by `id`.
  - Cap candidate torrent detail inspection (top 5 candidates per search) to prevent unbounded HTTP roundtrips.
- **Sequential Orchestration & Fast-Path Returns (`src/subtitlesHandler.ts`)**:
  - On uncached requests with sequential mode: query AnimeTosho first.
  - If AnimeTosho hits: return AnimeTosho; if extraction is already cached ready in SQLite, include it; do not initiate background extraction.
  - If AnimeTosho misses: initiate background extraction and return `extraction` (unless extraction is negative-cached).
  - Retain opt-in `ENABLE_CONCURRENT_EXTRACTION=true` capability for backward compatibility.
- **Automated Tests**:
  - Update unit and integration tests across `test/config.test.ts`, `test/providers/animetoshoProvider.test.ts`, and `test/subtitlesHandler.test.ts`.

### Out of Scope
- Adding new subtitle providers.
- Changing ffmpeg extraction internals (probe, demux, xz decompression).
- Modifying SQLite schema or cache retention rules.

---

## Architecture & Data Flow

```
Stremio Client
     │  GET /subtitles/{type}/{id}.json
     ▼
┌───────────────────────────────────────────────────────────────┐
│ subtitlesHandler.ts                                           │
│                                                               │
│ 1. Fast Cache Check:                                          │
│    - If AnimeTosho is cached 'ready':                         │
│      - If Extraction is cached 'ready', return [tosho, extr]  │
│      - Else return [tosho] (No extraction queued)             │
│                                                               │
│ 2. Uncached Request (ENABLE_CONCURRENT_EXTRACTION=false):     │
│    ┌─────────────────────────────────────────────────────┐    │
│    │ AnimeTosho Fast Check (Timeout: 3500ms)             │    │
│    │ - Parallel AniDB queries (padded & unpadded ep)     │    │
│    │ - Deduplicated & capped candidates (max 5)          │    │
│    └──────────────────────────┬──────────────────────────┘    │
│                               │                               │
│              ┌────────────────┴────────────────┐              │
│              ▼                                 ▼              │
│      [AnimeTosho Hit]                  [AnimeTosho Miss]      │
│      - Cache AnimeTosho                - Check/Start Tier 2:  │
│      - If Extraction is 'ready',         startExtractionInBackground
│        include it                      - Return ['extraction']│
│      - Return [AnimeTosho]                                    │
└───────────────────────────────────────────────────────────────┘
```

---

## Detailed Component Specifications

### 1. `src/config.ts`
- Change `enableConcurrentExtraction` default to `false`:
  ```ts
  enableConcurrentExtraction: requireBool(env, 'ENABLE_CONCURRENT_EXTRACTION', false),
  ```
- Change `providerTimeoutMs` default to `3500`:
  ```ts
  providerTimeoutMs: requireInt(env, 'PROVIDER_TIMEOUT_MS', 3500),
  ```

### 2. `src/providers/animetoshoProvider.ts`
- **Concurrent AniDB Queries**:
  ```ts
  if (anidbId !== null) {
    const searchPromises = epQueries.map((q) =>
      fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${q}&limit=50`,
        { timeoutMs },
      ).catch(() => [] as ToshoSearchResult[])
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

    // Fall back to broad search if episode queries yielded no candidates/matches
    const broadResults = await fetchJson<ToshoSearchResult[]>(
      `${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`,
      { timeoutMs },
    ).catch(() => [] as ToshoSearchResult[]);
    if (broadResults.length > 0) {
      const match = await resolveSubtitleFromCandidates(broadResults.slice(0, 5), episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs);
      if (match) return match;
    }
  }
  ```
- **Title Fallback**:
  - Run title searches across `epQueries` in parallel if `anidbId` is absent.
  - Limit candidate resolution to top 5 candidates.

### 3. `src/subtitlesHandler.ts`
- **`resolveOneLanguage` sequential flow**:
  - Fast-path check:
    ```ts
    if (readyProviders.length > 0) {
      if (toTry.length > 0) {
        const hits = await tryDatabaseTier(baseKey, toTry, anidbId, deps, title);
        readyProviders.push(...hits);
      }
      if (extractionCached?.status === 'ready') {
        readyProviders.push('extraction');
      }
      return readyProviders;
    }
    ```
  - Sequential path (when `deps.config.enableConcurrentExtraction` is false):
    ```ts
    if (toTry.length > 0) {
      const hits = await tryDatabaseTier(baseKey, toTry, anidbId, deps, title);
      readyProviders.push(...hits);
    }

    if (readyProviders.length > 0) {
      if (extractionCached?.status === 'ready') {
        readyProviders.push('extraction');
      }
      return readyProviders;
    }

    if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight) {
      return ['extraction'];
    }
    if (isExtractionNegative) return [];

    triggerExtraction();
    return ['extraction'];
    ```
  - Concurrent path (when `deps.config.enableConcurrentExtraction` is true):
    - Retained as-is for explicit opt-in.

---

## Testing Strategy

### 1. `test/config.test.ts`
- Verify `ENABLE_CONCURRENT_EXTRACTION` defaults to `false` and respects env override.
- Verify `PROVIDER_TIMEOUT_MS` defaults to `3500` and respects env override.

### 2. `test/providers/animetoshoProvider.test.ts`
- Test that `findAnimeToshoSubtitle` sends search requests in parallel for episode queries.
- Test that candidates are deduplicated and capped to 5 before detail inspection.
- Test that broad search is only queried when episode queries yield no match.

### 3. `test/subtitlesHandler.test.ts`
- Update existing tests expecting concurrent extraction by default:
  - Verify that under default settings (`enableConcurrentExtraction: false`), an AnimeTosho hit returns only `animetosho` and does NOT call `extractionProvider`.
  - Verify that when extraction is already cached `'ready'`, an AnimeTosho hit returns both `animetosho` and `extraction`.
  - Verify that when AnimeTosho returns `{ found: false }` or throws, extraction is triggered and returned.
  - Verify that when `enableConcurrentExtraction: true`, concurrent extraction starts immediately alongside AnimeTosho.

### 4. Regression Verification
- Run `npm test` across all 19 test files.
- Run `npm run typecheck`.
