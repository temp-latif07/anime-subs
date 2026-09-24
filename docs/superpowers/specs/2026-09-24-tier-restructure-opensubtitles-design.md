# Tier Restructure, OpenSubtitles Provider, and IMDB/Episode-Number Resolution

Status: draft (pending user review)
Date: 2026-09-24

## Problem

1. **Terminology doesn't match behavior.** Jimaku and AnimeTosho are already queried concurrently (`Promise.all` in `tryFastTiers`), yet are labeled "Tier 1" and "Tier 2" as if sequential. There's no real reason they're numbered differently.
2. **Structurally capped at one subtitle.** `CacheKey` (`anilistId`, `episode`, `lang`) has no source dimension, so only one subtitle URL is ever built per language regardless of how many providers actually have a match (code review finding #1). The TV only ever shows one English track.
3. **No IMDB-keyed source.** The user runs a separate `opensubtitlesv3-pro` Stremio addon, but it gets fed a `kitsuId` by their metadata chain and OpenSubtitles' API needs an `imdb_id` — so it returns zero results today. This addon already resolves `kitsuId`/`anilistId`/`malId`/`anidbId` via the manami-project dataset and is positioned to close that gap.
4. **Existing unresolvable case.** `idResolver.ts:50-52` already special-cases and gives up on `tt`-prefixed (IMDB-style) content IDs with the comment "no IMDb mapping in the dataset -- v1 scope limitation, see spec." When Stremio calls this addon with an IMDB-based content ID directly (common when the catalog/metadata chain is TMDB/Cinemeta-based rather than Kitsu-based), it returns zero subtitles unconditionally today. This is a real, currently-silent gap, not hypothetical.
5. **Season/episode numbering mismatch risk.** Anime is tracked by AniDB/AniList using per-entry (often per-cour) episode numbers. IMDB/TVDB split the same run into "seasons" that don't always align with AniDB/AniList entry boundaries. Naively querying OpenSubtitles with `season=1, episode=N` will silently miss matches whenever a show's IMDB/TVDB season boundaries don't match its AniDB/AniList entry boundaries.

## Goals

1. Restructure into two tiers that reflect what actually happens:
   - **Tier 1 — Database checks**: Jimaku, AnimeTosho, OpenSubtitles (via resolved IMDB ID), queried concurrently.
   - **Tier 2 — Embedded extraction**: today's ffmpeg pipeline, used only when Tier 1 finds nothing.
2. Add OpenSubtitles as a third Tier-1 provider, keyed by IMDB ID resolved from the anime's AniDB ID.
3. Fix the season/episode mismatch properly (not with a heuristic) by integrating the `Anime-Lists/anime-lists` community mapping dataset, which exists specifically to convert between AniDB episode numbers and TVDB (proxy for IMDB) season/episode numbers, including season-split and offset rules.
4. Respect OpenSubtitles' free-tier download quota (5/day) without corrupting the existing negative-cache semantics — a quota skip must never be recorded as "this series has no subtitles on OpenSubtitles."
5. Fix the structural single-subtitle cap: surface one subtitle track per provider that has a match, not one per language.
6. Close the existing `tt`-prefixed content ID gap using the same new mapping infrastructure, in reverse.

## Non-Goals

- Adding a fourth external subtitle provider beyond OpenSubtitles (Subscene, SubDL, etc.) — out of scope for this round.
- A TheTVDB API integration. `anime-lists` already carries a direct `imdbid` attribute for many entries (confirmed: ~15% of ~10,767 entries in the current dataset), and for TV entries without a direct IMDB id, TVDB season/episode numbers are used as an accepted proxy for IMDB's — no need for a second bridge/API/key.
- Handling AniDB "specials" (`anidbseason="0"` in `anime-lists`) with full correctness. This design assumes main-series episodes (`anidbseason="1"`) for the forward direction; specials are out of scope and simply won't get an OpenSubtitles match, same as today.
- Movie-type AniDB entries (`tvdbid="movie"` in `anime-lists`). This addon's data model is entirely episode-based; movie handling is left for a future round if needed.
- Extending manami-project's dataset with an IMDB regex — verified empirically that manami-project's `sources` arrays do not contain `imdb.com` URLs at all (checked a live sample: 0 occurrences across anilist/anidb/kitsu/mal/anime-planet/anisearch/simkl/animecountdown sources). `anime-lists` is the sole IMDB source for this design.

## Architecture & Data Flow

```
Stremio Client
     │  GET /subtitles/{type}/{id}.json   (id may be anilist:/kitsu:/mal:/anidb:/tt-prefixed)
     ▼
┌───────────────────────────────────────────────────────────────────────┐
│ ID Resolution (idResolver.ts)                                         │
│  - anilist:/kitsu:/mal:/anidb: → anime_ids table lookup (existing)    │
│  - tt-prefixed (NEW) → anime_ids reverse lookup by imdb_id            │
│    → candidate anidbId(s) → episode_mapping reverse lookup            │
│    (tvdb season/episode → anidb episode) → anilistId + episode        │
└───────────────────────────────────────────────────────────────────────┘
     │  anilistId, anidbId, episode (AniDB/AniList-relative)
     ▼
┌───────────────────────────────────────────────────────────────────────┐
│ TIER 1 — Database checks (concurrent, Promise.allSettled)             │
│                                                                         │
│  Jimaku            AnimeTosho          OpenSubtitles (NEW)             │
│  (anilistId)       (anidbId)           imdbId = episode_mapping        │
│                                          .findByAnidbId(anidbId).imdbId│
│                                         season/ep = episode_mapping     │
│                                          .mapAnidbToTvdb(anidbId, ep)  │
│                                         quota-gated /download           │
│                                                                         │
│  Each hit → separate cache row + separate subtitle track               │
│  (CacheKey now includes `provider`)                                    │
└───────────────────────────────────────────────────────────────────────┘
     │  zero Tier-1 hits
     ▼
┌───────────────────────────────────────────────────────────────────────┐
│ TIER 2 — Embedded extraction (ffmpeg, background, was Tier 3)         │
└───────────────────────────────────────────────────────────────────────┘
```

## Detailed Component Specifications

### 1. `src/resolver/episodeMapping.ts` (new)

Downloads and caches `https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml` (verified reachable; ~10.8k `<anime>` entries) on the same refresh cadence as the existing anime dataset. Parses into a SQLite table:

```sql
CREATE TABLE episode_mapping (
  anidb_id INTEGER PRIMARY KEY,
  tvdb_id TEXT,              -- numeric TVDB id, or 'movie', or NULL
  imdb_id TEXT,               -- direct imdbid attribute, when present
  default_tvdb_season INTEGER,
  episode_offset INTEGER,     -- whole-series offset, when present
  mapping_rules TEXT          -- JSON-encoded list of {anidbSeason, tvdbSeason, ranges: [{start,end,offset}], explicit: [{from,to}]}
);
CREATE INDEX idx_episode_mapping_tvdb ON episode_mapping(tvdb_id);
```

Exposes:
- `findByAnidbId(anidbId): MappingRow | null`
- `mapAnidbToTvdbEpisode(anidbId, anidbEpisode, anidbSeason = 1): { season: number; episode: number } | null` — applies explicit-list rules first (exact episode override), then range+offset rules, then falls back to `default_tvdb_season` with no offset when there's no `mapping-list` at all (the common case).
- `mapTvdbToAnidbEpisode(tvdbId, tvdbSeason, tvdbEpisode): { anidbId: number; anidbEpisode: number } | null` — reverse of the above, for resolving `tt`-prefixed Stremio requests. Scans candidate rows via `idx_episode_mapping_tvdb`, inverts whichever rule matched.
- `imdbId` from a row is used directly for the OpenSubtitles provider when present; when absent, that anime simply has no OpenSubtitles tier (clean miss, same shape as a title with no Jimaku/AnimeTosho match).

### 2. `src/resolver/idResolver.ts` (modified)

- `resolveIds` gains a reverse-lookup path for `tt`-prefixed content IDs: look up `imdb_id` in `anime_ids` (requires adding an `imdb_id` column there too, populated from `episode_mapping` join during dataset build — see below) to get candidate `anidbId`s, then use `episodeMapping.mapTvdbToAnidbEpisode` with the parsed `season`/`episode` to get the AniDB-relative episode number and confirm which candidate entry it falls in.
- This removes the existing "v1 scope limitation" early-return and fixes a real, currently-silent zero-results case for any catalog that feeds this addon Cinemeta/TMDB-style IDs.
- If no match is found (anime-lists doesn't cover that title, or the season/episode falls outside any mapped range), return the existing `empty` result — same graceful-miss behavior as today, not a new failure mode.

### 3. `src/resolver/animeDataset.ts` (modified)

- `anime_ids` gains an `imdb_id TEXT` column + index, populated by joining each row's `anidb_id` against `episode_mapping.imdb_id` during `buildFromRaw` (requires `episode_mapping` to be built first, or backfilled in a second pass after both datasets are loaded — sequencing detail for the implementation plan).
- This is the forward lookup: given `anilistId`/`anidbId`, get `imdbId` for the OpenSubtitles provider.

### 4. `src/providers/opensubtitlesProvider.ts` (new)

Same shape as `jimakuProvider`/`animetoshoProvider` — takes resolved IDs, `lang`, an API key, timeout opts; returns `ProviderResult`.

- If no `imdbId` resolved for this anime: return `{ found: false }` immediately (no API call).
- Search `/subtitles` (OpenSubtitles REST API v1) by `imdb_id` + `season_number`/`episode_number` (from `episodeMapping.mapAnidbToTvdbEpisode`) + `languages=en`. Exact query parameter names to be confirmed against current OpenSubtitles API docs at implementation time — the docs site is a JS-rendered SPA that couldn't be scraped for this spec; this is a verification step, not a design risk, since the search shape (IMDB id + season + episode) is stable REST API v1 behavior.
- Search calls are not quota-gated (informational only).
- Before calling `/download`: check remaining daily quota via the new `CacheStore` quota tracker (below). If exhausted, return `{ found: false, quotaSkipped: true }` — **do not** call `/download`.
- On a successful download: return `{ found: true, vttContent }` (or SRT→VTT conversion if OpenSubtitles returns SRT, matching the existing `extract.ts` conversion pattern) and record quota usage.
- On a genuine zero-results search: return `{ found: false }` (safe to negative-cache, same as Jimaku/AnimeTosho misses).

### 5. `src/cache/cacheStore.ts` (modified)

**Quota tracking (new):**
```sql
CREATE TABLE provider_quota (
  provider TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
```
- `getRemainingQuota(provider, dailyLimit): number` — resets `count` to 0 and `window_start` to now if the existing window is >24h old, then returns `dailyLimit - count`.
- `recordDownloadUsed(provider): void` — increments `count` in the current window.

**`ProviderResult.quotaSkipped` handling (critical correctness point, subtitlesHandler.ts):** when a provider result has `quotaSkipped: true`, the negative-cache / `setSeriesProviderMiss` path must be skipped entirely for that provider on that call — this is the fix for the pitfall identified during design (a quota-exhausted day must not get recorded as "OpenSubtitles has no subtitles for this series," which would incorrectly suppress retries for the full 24h negative-cache TTL even after quota resets).

**`CacheKey` gains a `provider` dimension:**
```ts
export interface CacheKey {
  anilistId: number;
  episode: number;
  lang: string;
  provider: 'jimaku' | 'animetosho' | 'opensubtitles' | 'extraction';
}
```
- `keyId()` includes `provider` in the composite key string.
- `CacheEntry.tier: 1 | 2 | 3 | null` is replaced by deriving a display tier from `provider` (`extraction` → 2, everything else → 1) rather than storing a redundant numeric field.
- **Migration**: existing `cache` rows have no `provider` column but do have the old `tier` value, which maps 1:1 to a provider (`1` → `jimaku`, `2` → `animetosho`, `3` → `extraction`). A one-time migration backfills `provider` from `tier` on existing rows rather than invalidating the whole cache (avoids re-paying for every previously-completed 30s extraction).

### 6. `src/subtitlesHandler.ts` (modified)

- `tryFastTiers` renamed to reflect the new model (e.g. `tryDatabaseTier`), extended to run all three providers via `Promise.allSettled` (already effectively true for 2 of 3 today via per-provider `.catch`; formalizing this for 3).
- Instead of returning a single boolean, collects **all** providers that found a match and builds one `CacheKey`/URL per provider that hit — this is the fix for finding #1 and the mechanism for surfacing multiple tracks.
- `handleSubtitlesRequest`'s `subtitles` array now contains up to 3 entries per language when multiple Tier-1 providers hit (e.g. `{ lang: 'eng', url: '.../jimaku.vtt' }`, `{ lang: 'eng', url: '.../opensubtitles.vtt' }`). Tier 2 (extraction) still contributes at most one entry, only when Tier 1 found zero matches across all three providers.
- Distinguishing tracks in the Stremio subtitle picker: Stremio's subtitle object is `{ id, url, lang }` with no dedicated "source" field; the common convention among existing multi-source subtitle addons is to put the human-readable distinguisher directly in `lang` (e.g. `"eng (Jimaku)"`) since clients generally just display that string. This needs a quick manual check on the actual Samsung TV Stremio client during implementation, since picker rendering can vary by platform — flagged for the plan's testing section, not assumed here.

### 7. `src/server.ts` (modified)

- `/vtt` route path gains the provider segment: `/vtt/:anilistId/:episode/:lang/:provider.vtt`.

## Relationship to the existing code-review findings (`docs/code-review-2026-09-24.md`)

Resolved as a natural consequence of this redesign:
- **#1** (single subtitle structurally capped) — directly fixed by the `provider`-dimensioned `CacheKey`.

Not addressed by this design, remain separate fixes in the implementation plan:
- All other findings (#2–#22), including the negative-cache-blocks-everything bug (#10), Jimaku fallback-file bug (#6), AnimeTosho per-candidate try/catch (#8), ASS filtering gaps (#13–#15), the dataset-refresh transaction bug (#18), and the rest. These touch the same files this design touches in several cases (`subtitlesHandler.ts`, `cacheStore.ts`, `animeDataset.ts`), so the implementation plan should sequence them together to avoid rework, but they are logically independent bug fixes, not part of this architecture change.

## Testing

- Unit tests for `episodeMapping.ts`: explicit-list rules, range+offset rules, no-mapping-list passthrough, both mapping directions, using fixture XML fragments (not the live dataset).
- Unit tests for the quota tracker: window reset after 24h, `quotaSkipped` never triggers `setSeriesProviderMiss`.
- Provider tests for `opensubtitlesProvider.ts` mocked the same way `jimakuProvider`/`animetoshoProvider` are today (mock HTTP client, no live API calls in CI).
- Integration test: a title with no `anime-lists` entry at all still resolves cleanly via Jimaku/AnimeTosho with OpenSubtitles simply absent from the results (no crash, no spurious negative cache).
- Manual: verify multi-track display on the actual Samsung TV Stremio client once implemented — noted above as unverified picker UX behavior.

## Open Risks (accepted)

- `anime-lists` coverage is community-maintained and not exhaustive — brand-new or very obscure titles may have no entry, in which case OpenSubtitles/tt-id-resolution simply doesn't apply for that title (graceful miss, not a regression from today).
- TVDB season boundaries are used as a proxy for IMDB season boundaries when a direct `imdbid` isn't present in `anime-lists`. This is the same assumption the wider `*arr` ecosystem (Sonarr/Bazarr/FileBot) relies on for this exact problem; it is occasionally wrong but far smaller a risk than the original naive `season=1` assumption.
- OpenSubtitles free-tier quota (5 downloads/24h) means this provider will realistically contribute a handful of episodes per day — it's a supplementary Tier-1 source, not expected to match Jimaku/AnimeTosho's hit volume.
