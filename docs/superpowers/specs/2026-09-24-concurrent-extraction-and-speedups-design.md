# Concurrent Tier 1 & Tier 2 Extraction with Pipeline Optimizations

## Context

Today, anime-subs evaluates subtitle providers sequentially by tier:
1. **Tier 1 (Database sources)**: Jimaku, AnimeTosho, OpenSubtitles queried concurrently.
2. **Tier 2 (Embedded extraction)**: Streams fetched via stream addon, probed via byte range / ffprobe, and demuxed via ffmpeg.

Currently, Tier 2 is completely suppressed if any Tier 1 provider hits. If Tier 1 misses, Tier 2 extraction only starts after all Tier 1 API calls complete or time out (`PROVIDER_TIMEOUT_MS = 8000ms`). Combined with double-connection probing and container demuxing over HTTP, extraction takes 25–45s from playback start. When the Stremio player fetches `/vtt/.../extraction.vtt`, the server's `vttWaitMs` (20s) hold expires, serving a static placeholder WebVTT cue ("Extracting subtitles -- reselect this track in about a minute").

This design eliminates the serial gate by initiating Tier 1 and Tier 2 concurrently on uncached requests, advertising all found and extracted tracks side-by-side in Stremio's subtitle picker, and optimizing the extraction probe and demuxing pipeline.

## Scope

### In Scope
- **Smart Parallel Orchestration (`src/subtitlesHandler.ts`)**:
  - Fast-path cache check: if any provider is already cached `'ready'`, return immediately (<10ms).
  - Uncached kickoff: start `tryDatabaseTier` and `startExtractionInBackground` in parallel.
  - Multi-track return: surface all Tier 1 hits (`eng (Jimaku)`, `eng (OpenSubtitles)`, etc.) alongside `eng (Extracted)` in Stremio's track list.
- **Probe Optimization (`src/ffmpeg/probe.ts`)**:
  - In `findSubtitleStream()`, check if the 2MB HTTP byte-range buffer successfully parsed valid stream headers. If stream headers were parsed and no streams matched the requested language, immediately reject the candidate instead of falling through to a 10–15s remote `ffprobe` process.
- **Demux Optimization (`src/ffmpeg/extract.ts`)**:
  - Reduce `-analyzeduration` from `500k` to `0` and add `-fflags +nobuffer+flush_packets` for subtitle extraction calls where the stream index and codec are already known, avoiding unneeded video/audio frame decoding over HTTP.
- **Configuration & Queue Management (`src/config.ts`, `src/queue/extractionQueue.ts`)**:
  - Bump default `EXTRACTION_CONCURRENCY` from `1` to `2`.
  - Add `ENABLE_CONCURRENT_EXTRACTION` (default: `true`, env `ENABLE_CONCURRENT_EXTRACTION`) to allow falling back to sequential behavior if desired.

### Out of Scope
- Adding new subtitle providers (SubDL, Subscene, etc.).
- Modifying the underlying SQLite schema (`cache` table already supports `${anilistId}:${episode}:${lang}:${provider}`).
- Automatic pre-fetching of subsequent episodes (e.g. episode N+1).

## Architecture & Data Flow

```
Stremio Client
     │  GET /subtitles/{type}/{id}.json
     ▼
┌──────────────────────────────────────────────────────────┐
│ subtitlesHandler.ts                                      │
│                                                          │
│ 1. Check SQLite Cache:                                   │
│    - If any Tier 1 hit is ready & extraction not running:│
│      Return cached ready tracks immediately (<10ms)      │
│                                                          │
│ 2. If Uncached & ENABLE_CONCURRENT_EXTRACTION=true:      │
│    ┌───────────────────────────┬───────────────────────┐ │
│    │ Concurrent Branch A       │ Concurrent Branch B   │ │
│    │ (Tier 1 Database Checks)  │ (Tier 2 Extraction)   │ │
│    │ - Jimaku                  │ - getPlayableStreamUrls│
│    │ - AnimeTosho              │ - ExtractionQueue     │
│    │ - OpenSubtitles           │ - Probe & Demux       │
│    └─────────────┬─────────────┴───────────┬───────────┘ │
│                  │                         │             │
│                  ▼                         ▼             │
│    Collect database hits           Register in-flight    │
│    (Promise.allSettled)            extractionKey         │
└──────────────────┬─────────────────────────┬─────────────┘
                   │                         │
                   ▼                         ▼
Stremio Receives: [ "eng (Jimaku)", ..., "eng (Extracted)" ]
```

When the user selects `eng (Extracted)` in Stremio:
- Client issues `GET /vtt/:anilistId/:episode/:lang/extraction.vtt`.
- Server checks `cache.getInFlight(key)`. Since extraction began at $t=0$, extraction is either already completed (instant 200 OK) or finishes within `vttWaitMs` (20s).
- Player receives real subtitles with no placeholder.

## Component Specifications

### 1. `src/subtitlesHandler.ts`
- Update `resolveOneLanguage`:
  - Query local cache for `jimaku`, `animetosho`, `opensubtitles`, and `extraction`.
  - If any Tier 1 provider is `'ready'`:
    - If `extraction` is also `'ready'`, include it.
    - Return ready providers immediately.
  - If uncached:
    - If `config.enableConcurrentExtraction` is enabled:
      - Launch `streamUrlsPromise = getPlayableStreamUrls(...)`.
      - Launch `startExtractionInBackground(...)` immediately.
      - Await `tryDatabaseTier(...)`.
      - Return both Tier 1 hits and `'extraction'` (unless extraction was previously marked negative and unexpired).
    - If `enableConcurrentExtraction` is false:
      - Preserve the legacy fallback behavior (only start extraction if Tier 1 yields 0 hits).

### 2. `src/ffmpeg/probe.ts`
- Update `findSubtitleStream`:
  - Enhance `findSubtitleStreamFromBuffer` to return a tri-state result:
    - `{ found: true, stream: FoundSubtitleStream }`: Matched stream found.
    - `{ found: false, hasStreams: true }`: Container streams were parsed, but none matched requested language.
    - `{ found: false, hasStreams: false }`: Buffer could not be parsed (truncated/missing header).
  - If `hasStreams === true`, do **not** fall through to remote `ffprobe`; skip candidate immediately.
  - Only fall through to remote `ffprobe` when `hasStreams === false` (header incomplete in 2MB buffer).

### 3. `src/ffmpeg/extract.ts`
- In `extractSubtitleToVtt`:
  - Change `-analyzeduration` from `500k` to `0`.
  - Add `-fflags +nobuffer+flush_packets` to `baseArgs`.
  - Ensures ffmpeg starts demuxing subtitles without pre-reading and buffering video/audio frames.

### 4. `src/config.ts`
- Add to `Config` interface:
  - `enableConcurrentExtraction: boolean` (env `ENABLE_CONCURRENT_EXTRACTION`, default `true`).
  - `extractionConcurrency: number` (env `EXTRACTION_CONCURRENCY`, default updated from `1` to `2`).
- Helper: `requireBool(env, name, default)`:
  - Parses `'true'`, `'1'`, `'yes'` as `true`; `'false'`, `'0'`, `'no'` as `false`.

## Testing Plan

### Unit & Integration Tests
1. **`test/config.test.ts`**:
   - Verify `ENABLE_CONCURRENT_EXTRACTION` defaults to `true` and respects env override.
   - Verify `EXTRACTION_CONCURRENCY` defaults to `2`.
2. **`test/ffmpeg/probe.test.ts`**:
   - Test buffer probe rejection: when buffer contains streams of a different language, does not fall through to remote probe.
3. **`test/subtitlesHandler.test.ts`**:
   - Verify that when uncached, `handleSubtitlesRequest` initiates both `jimakuProvider`/`opensubtitlesProvider` and `extractionProvider` concurrently.
   - Verify that both Tier 1 hits and `extraction` candidate are returned in `subtitles`.
   - Verify that when `ENABLE_CONCURRENT_EXTRACTION=false`, legacy sequential fallback is preserved.
   - Verify that when a Tier 1 provider is already cached ready, `handleSubtitlesRequest` returns cached providers without triggering background extraction.

### Verification Criteria
- Run full vitest suite (`npm test`) across all 20+ test files with zero regressions.
- Ensure strict typecheck passes (`npm run typecheck`).
