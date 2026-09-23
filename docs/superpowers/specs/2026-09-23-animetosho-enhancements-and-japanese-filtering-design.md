# AnimeTosho Enhancements and Japanese Subtitle Filtering Design

Status: approved
Date: 2026-09-23

## Problem
In practical usage, AnimeSubs frequently misses Tier 1 (Jimaku) and Tier 2 (AnimeTosho) lookups, causing unnecessary 20+ second Tier 3 extractions. Furthermore, when subtitles are found or extracted, some contain Japanese text (Kanji/Kana) and song lyrics (Kanji & Romaji) alongside English dialogue. This causes subtitle renderers (like Stremio and ExoPlayer) to stack multiple lines that constantly appear and disappear, causing the subtitles to violently bounce up and down during playback.

### Confirmed Root Causes
1. **AnimeTosho query restrictions**:
   - AnimeTosho is queried only with `?aid=${anidbId}&limit=50`. If AnimeTosho has not yet matched the AniDB ID (common for newer anime seasons like Grand Blue S3 or Mushoku Tensei S3), the search returns 0 results.
   - Batch torrents are completely excluded by `r.num_files === 1`, even though AnimeTosho extracts subtitle attachments for every episode in a batch. Once an anime season finishes, single-episode torrents are often superseded by batches.
   - The reverse-chronological 50-result limit buries early episodes (e.g., episode 1–6) behind later episode releases from multiple encoder groups.
   - AnimeTosho sets `seriesNotFound: true` when `aid` returns 0 results, blacklisting the anime in SQLite for 24 hours.
2. **Japanese text and song lyrics in English subtitles**:
   - Jimaku is predominantly a Japanese subtitle archive; mislabeled uploads or dual-sub uploads contain Japanese text.
   - Fansub and scene ASS files contain Opening/Ending song lyrics (both Kanji and Romaji), signs, and dual-language dialogue lines.
   - The ASS to VTT converter preserves all dialogue lines, including Japanese lyrics and signs, without filtering Japanese scripts or song styles, leading to stacked multi-line cues and bouncing subtitles.

## Goals
1. Increase Tier 2 (AnimeTosho) hit rate:
   - Support batch torrents (`num_files > 1`) by searching `detail.files` for the matching episode.
   - Target the episode in the AniDB query (`&q=${episode}`).
   - Fall back to title-based search (`?q=${title}+${episode}`) when `aid` returns no results or `anidbId` is null.
   - Broaden episode number regex to handle common formats (`[Group] Show 06 [1080p]`, `Episode 06`, `06v2`).
   - Only set `seriesNotFound` when both `aid` and title fallback searches return 0 results.
2. Eliminate bouncing and Japanese text in English subtitles:
   - Detect and discard Opening/Ending song lyrics (both Kanji and Romaji) based on ASS style names (`/^(op|ed|song|karaoke|lyrics|insert|music)/i`) and karaoke tags (`{\k}`).
   - Strip Japanese script characters (Hiragana `\u3040-\u309F`, Katakana `\u30A0-\u30FF`, Kanji `\u4E00-\u9FFF`, CJK symbols `\u3000-\u303F\uFF00-\uFFEF`) from multi-line cues.
   - Discard cues that contain only Japanese text or become empty after stripping.
   - Verify that generated VTT for English requests actually contains Latin/English dialogue and is not predominantly Japanese.

## Non-Goals
- Adding external API dependencies requiring user credentials (e.g. OpenSubtitles API keys).
- Modifying non-English target languages when non-English is explicitly configured (filtering applies when language is `eng`).
- Complex word-by-word timing synchronization of lyrics.

## Architecture & Data Flow

```
Stremio Client
     │  GET /subtitles/series/{id}:{season}:{episode}.json
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ Subtitles Handler                                               │
│  1. ID Resolver: Resolve Kitsu/MAL/AniList ID to:              │
│     - anilistId & anidbId                                       │
│     - anime canonical title (for title fallback)                │
│                                                                 │
│  2. Cache Check: SQLite hit (ready/pending/negative)            │
│                                                                 │
│  3. Tier 1: Jimaku Provider (AniList ID)                       │
│     - Fetch candidate files                                     │
│     - Language verify & sanitize: reject if predominantly JP    │
│                                                                 │
│  4. Tier 2: AnimeTosho Provider                                 │
│     - Primary search: ?aid={anidbId}&q={episode}&limit=50       │
│     - Fallback search (if aid empty/null): ?q={title}+{episode} │
│     - Inspect candidate torrents:                               │
│       * Single-file (num_files === 1) matching episode          │
│       * Batch torrent (num_files > 1) matching file in files[]  │
│     - Download attachment & decompress XZ                       │
│     - Sanitize ASS: strip OP/ED songs & Japanese lines          │
│     - Convert to clean English WebVTT                           │
│                                                                 │
│  5. Tier 3: Extraction Fallback (background stream copy)       │
│     - Extract from remote stream if fast tiers miss             │
│     - Sanitize extracted VTT before caching                     │
└─────────────────────────────────────────────────────────────────┘
```

## Detailed Component Specifications

### 1. Title Resolution (`src/resolver/animeDataset.ts` and `src/resolver/idResolver.ts`)
- In `animeDataset.ts`, include `title TEXT` in the `anime_ids` SQLite schema:
  ```sql
  CREATE TABLE anime_ids (
    anilist_id INTEGER,
    anidb_id INTEGER,
    kitsu_id INTEGER,
    mal_id INTEGER,
    title TEXT
  );
  ```
- Store `entry.title` (from `RawDatasetEntry`) during dataset insertion.
- Update `ResolvedIds` interface:
  ```typescript
  export interface ResolvedIds {
    anilistId: number | null;
    anidbId: number | null;
    title?: string | null;
  }
  ```
- `dataset.findByAnilistId(id)` and `dataset.findByScheme(scheme, id)` return `title`.

### 2. AnimeTosho Provider Overhaul (`src/providers/animetoshoProvider.ts`)
- Interface update:
  ```typescript
  export interface AnimeToshoOptions {
    title?: string | null;
    feedBaseUrl?: string;
    storageBaseUrl?: string;
    timeoutMs?: number;
  }
  ```
- **Broadened Episode Regex (`EPISODE_PATTERNS`)**:
  ```typescript
  const EPISODE_PATTERNS = [
    /S\d{1,2}E(\d{1,4})/i,
    /-\s*(\d{1,4})\s*\(/,
    /-\s*(\d{1,4})\s*\[/,
    /\s+(\d{1,4})\s*\[/i,
    /\b(?:ep|episode)\s*(\d{1,4})\b/i,
    /-\s*(\d{1,4})v\d\b/i,
    /-\s*(\d{1,4})(?:\.[a-z0-9]+)?\s*$/i,
  ];
  ```
- **Primary Search**:
  If `anidbId !== null`, query:
  `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${episode}&limit=50`
- **Fallback Search**:
  If primary search yields 0 candidates (or `anidbId === null`) and `opts.title` is provided:
  Sanitize title (strip punctuation/season markers like `Season \d+` or special chars if needed) and query:
  `${feedBaseUrl}/json?t=search&q=${encodeURIComponent(`${cleanTitle} ${episode}`)}&limit=50`
- **Batch Torrent Traversal**:
  Filter search results with `r.status === 'complete'`.
  For each candidate:
  - If `r.num_files === 1` and `parseEpisodeNumber(r.title) === episode`:
    Fetch detail and find matching attachment in `detail.files[0]`.
  - If `r.num_files > 1` (batch):
    Fetch detail and iterate through `detail.files`. Find the file where `parseEpisodeNumber(file.filename) === episode`. Check its `attachments`.
- **Negative Caching**:
  Return `seriesNotFound: true` only if both `aid` query and fallback search returned 0 torrent results.

### 3. Subtitle Sanitization (`src/ffmpeg/assUtils.ts` and `src/ffmpeg/vttUtils.ts`)
- **Song & Karaoke Detection in ASS**:
  - Skip any event where the style name matches `/^(op|ed|song|karaoke|lyrics|insert|music)/i` or contains `kanji` or `romaji`.
  - Skip any event whose text contains karaoke tags: `/\{[^}]*\\k[f|o]?[0-9]+[^}]*\}/i`.
- **Japanese Script Filter**:
  - Regex: `const JAPANESE_CHAR_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF]/;`
  - In multi-line cues (dual subs / signs): filter out lines matching `JAPANESE_CHAR_REGEX`.
  - If a cue has no remaining text lines or is purely Japanese, discard the cue.
- **VTT Normalizer (`vttUtils.ts`)**:
  - In `finalizeCue`, filter out any line containing Japanese characters if the target language is English (`lang === 'eng'`).
  - Strip cues that become empty.
- **Language Sanity Check**:
  - In `jimakuProvider.ts` and `animetoshoProvider.ts`:
    Before accepting a converted VTT for `lang === 'eng'`, test:
    - Count of Latin alphabetic letters `/[a-zA-Z]/g`.
    - Count of Japanese script characters `JAPANESE_CHAR_REGEX`.
    - If Latin count < 20 or Japanese characters > 30% of total text, reject as `{ found: false }`.

## Testing Strategy
- Unit tests in `test/resolver/animeDataset.test.ts` & `test/resolver/idResolver.test.ts`:
  - Assert dataset stores and returns `title`.
- Unit tests in `test/providers/animetoshoProvider.test.ts`:
  - Test batch torrent candidate parsing (`num_files > 1`).
  - Test targeted `&q=${episode}` query.
  - Test fallback title search when `aid` returns empty.
  - Test new episode patterns (`[Group] Show 06 [1080p]`, `Episode 06`, `06v2`).
- Unit tests in `test/ffmpeg/assUtils.test.ts` & `test/ffmpeg/vttUtils.test.ts`:
  - Test stripping Japanese script lines (Kanji/Kana) while preserving English lines.
  - Test stripping pure Japanese cues.
  - Test dropping OP/ED song styles (`OP-Kanji`, `ED-Romaji`, `Song`) and karaoke tags `{\k}`.
  - Test elimination of stacked bouncing cues.
- Unit tests in `test/providers/jimakuProvider.test.ts`:
  - Test rejection of mislabeled predominantly Japanese subtitle files.
