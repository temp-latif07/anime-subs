# AnimeSubs — Tiered Anime Subtitle Addon for Stremio

Status: approved for planning
Date: 2026-09-23

## Problem

Anime fansub releases are distributed as MKV files with subtitles muxed in
as an embedded track, not as standalone SRT/ASS files. General subtitle
databases (OpenSubtitles, SubDL, SubSource) are therefore sparse-to-empty
for anime — there's usually nothing external to find. Two further,
independently confirmed issues compound this for the user's specific
setup:

1. **ID mismatch.** Some subtitle addons (e.g. SubSense, manifest
   `idPrefixes: ["tt"]`) are only ever queried by Stremio when the content
   carries an IMDb id. Anime metadata addons commonly serve Kitsu/MAL/AniDB
   ids instead, so the subtitle addon is silently never invoked.
2. **No source exists anywhere.** For at least one confirmed example
   ("Love Unseen Beneath the Clear Night Sky"), no fansub/scene release
   exists on Nyaa or AnimeTosho at all (verified directly against both
   APIs, with a known-covered show used as a control). Whatever stream
   addon found for playback is sourced some other way, and any subtitle
   track that exists lives only inside that one file.
3. **TV rendering.** Independent of the above, several Stremio TV builds
   (Tizen, Android TV) have documented bugs failing to render embedded
   subtitle tracks even when present, while addon-*delivered* subtitles
   render fine (Stremio draws those itself in software).

A key protocol constraint: the Stremio subtitles resource is never told
the actual stream URL being played (only a hash/size/filename and the
content id) — so no ordinary subtitle addon can reach into whatever exact
file the user is currently playing.

## Goals

- Resolve subtitles (English by default, configurable) for anime that:
  - exist in a community anime subtitle archive, regardless of ID scheme
    quirks in the user's other addons
  - exist only as an embedded track inside *some* available stream, with
    no external source anywhere
- Work as a single, standard Stremio `subtitles`-resource addon — no
  changes to the user's existing stream addon setup required
- Self-hostable by anyone via Docker, single-tenant, no ongoing external
  paid dependency
- Built test-first (TDD)

## Non-goals

- Multi-tenant / shared public hosting (no per-user config tokens, no
  SSRF hardening against arbitrary third-party input) — out of scope for
  v1; noted as a possible future direction, not built now
- Perfect frame-accurate sync to the *exact* release the user is
  streaming — tiers 1–2 already don't guarantee this; tier 3 picks its
  own canonical stream rather than the user's specific pick
- Non-English languages beyond making the target language configurable
  (default `eng`)
- Complex AniDB season-splitting for long-running series (out of scope
  for v1; the motivating case is a standard single-cour show)

## Architecture

A single Node.js/TypeScript HTTP server implementing only the Stremio
`subtitles` resource, packaged as a Docker image, self-hosted (home
server or any Docker host). Configuration via environment variables only.

Rather than wrapping/proxying the user's stream addon to attach subtitles
directly to stream objects (which would require replacing their existing
AIOStreams install and duplicating its stream list), the fallback tier
calls the user's configured stream addon server-side itself, picks a
stream, and extracts from that — keeping this a normal, standalone
subtitle addon that installs alongside everything the user already has.

```
Stremio client
     │  GET /subtitles/series/{id}:{season}:{episode}.json
     ▼
┌─────────────────────────────────────────────────────────┐
│ HTTP server (Express)                                    │
│  1. ID resolver: {id} → anilistId, anidbId                │
│  2. Cache lookup (SQLite + filesystem)                    │
│     hit  → return cached result                           │
│     miss → tier chain:                                    │
│       Tier 1: Jimaku provider                              │
│       Tier 2: AnimeTosho provider                           │
│       Tier 3: Extraction fallback (background, cached)      │
└─────────────────────────────────────────────────────────┘
```

## Components

### ID resolver
Normalizes whatever id Stremio sends (`kitsu:`, `mal:`, `anidb:`, etc.)
into an AniList id (for Jimaku) and an AniDB id (for AnimeTosho). Backed
by a periodically-refreshed local copy of
`manami-project/anime-offline-database` (~41k anime, each entry's
`sources[]` array containing per-scheme URLs like
`anilist.co/anime/{id}`, `anidb.net/anime/{id}`, `kitsu.app/anime/{id}`,
`myanimelist.net/anime/{id}`), parsed once into a SQLite lookup table
indexed by each id scheme — no live network dependency on the request
path.

**Confirmed scope limitation:** this dataset has no IMDb mapping at all.
A bare `tt…` id with no dataset match is unresolvable in v1 — the
handler returns an empty subtitle list rather than erroring. This is
expected to be uncommon in practice: an IMDb-only anime setup is exactly
the "poor anime coverage" problem this project exists to work around, so
anime-focused metadata addons (like AIOMetadata configured for anime)
typically surface Kitsu/MAL ids instead.

### Jimaku provider (tier 1)
Queries the Jimaku API for the resolved AniList id + episode number,
filtered to the configured target language(s) by filename heuristic (see
API reference below — Jimaku has no structured language field). Requires
a user-supplied Jimaku API key (env var).

**Caveat, confirmed against Jimaku's live OpenAPI spec:** Jimaku is
primarily a Japanese-subtitle archive for language learners. Entries and
files carry no language field at all — English (or other non-Japanese)
files exist but are the minority, identifiable only by filename
convention. Expect a low hit rate for English specifically; it's kept as
tier 1 because it's fast and free when it does hit, not because it's
expected to be the main source of coverage.

### AnimeTosho provider (tier 2)
Searches AnimeTosho's JSON feed by AniDB anime id, finds a matching
episode release, and resolves its already-extracted subtitle attachment
to a direct (redirect-following) download URL. This is the primary
source of English coverage for anime that had any scene/simulcast
release at all — see API reference below for the fully verified request/
response shapes and URL construction, confirmed end-to-end against a
live example.

### Extraction fallback (tier 3)
Runs only when tiers 1–2 return nothing:
1. Calls the user's configured stream addon (`STREAM_ADDON_URL`, e.g.
   their AIOStreams manifest URL) for this content id, and takes the
   first **directly playable** stream in its response (a `url` field —
   the normal shape for a debrid-resolved stream) — respecting whatever
   ranking the upstream addon already applied. Entries that only carry
   an `infoHash` (a raw, not-yet-resolved torrent/magnet) are skipped,
   since resolving one ourselves is out of scope; this is expected to be
   rare for a debrid-backed setup, where AIOStreams already hands back
   direct HTTP links.
2. Runs `ffprobe` against the stream URL to find a subtitle stream
   matching the target language. If none exists, cache a negative result
   and stop.
3. Runs `ffmpeg` to extract just that subtitle stream, converted to
   WebVTT, direct from the remote URL (ffmpeg reads HTTP natively — no
   separate download step).
4. Because this is a long-lived process, not a serverless function,
   there's no execution-time limit to design around — it just runs for
   as long as the source takes to stream through. A self-imposed
   `EXTRACTION_TIMEOUT_MS` (default 15 min) kills runaway/broken streams.
5. Runs as a background task, queued against `EXTRACTION_CONCURRENCY`
   (default 1) — a request that would exceed the cap waits for a free
   slot rather than spawning an extra ffmpeg process.

Because extraction can't finish within a single HTTP response in general,
the first request for a tier-3 episode returns a subtitle entry pointing
at a status URL: that endpoint serves the finished VTT once ready, or a
small placeholder VTT ("Extracting subtitles, reselect in about a
minute") while pending. Once cached, every subsequent request (including
the user reselecting the subtitle track) is instant.

### Cache
SQLite table keyed by `(anilistId, episode, lang)` storing tier used,
status (`pending` / `ready` / `negative`), and a path to the cached
`.vtt` file on disk (Docker volume). Negative results expire after
`NEGATIVE_CACHE_TTL_HOURS` (default 24h) so an episode with no subtitle
available yet gets retried later without hammering providers on every
single request. Positive results are cached indefinitely.

A `pending` row doubles as an in-flight lock: it's paired with an
in-memory map of `(anilistId, episode, lang)` → in-progress promise, so a
second request arriving while a lookup/extraction is already running
attaches to that same in-flight work instead of starting a duplicate
provider call or a duplicate ffmpeg process.

## Performance & resource efficiency

This runs unattended, 24/7, on the user's own home server — it must not
waste CPU, bandwidth, or disk beyond what a given request actually needs.

- **Cache-first, always.** Tiers 1–3 only run on a cache miss; a `ready`
  or still-fresh `negative` entry short-circuits the whole chain before
  any provider is called.
- **In-flight de-duplication** (see Cache above) — no duplicate concurrent
  work for the same key.
- **Bounded extraction concurrency**, enforced as a real queue
  (`EXTRACTION_CONCURRENCY`), not a soft/advisory limit.
- **Subtitle-only extraction.** The ffmpeg command maps and copies only
  the matched subtitle stream (`-map 0:s:<idx> -c:s webvtt`) — it never
  transcodes video or audio, so CPU cost stays minimal regardless of the
  source's resolution or codec. (Network cost of reading through the
  container is inherent to how MKV interleaves tracks and isn't avoidable
  without an upstream that indexes subtitle-only byte ranges, which
  general anime releases don't provide.)
- **Bounded HTTP calls.** Every outbound call (Jimaku, AnimeTosho, the
  stream addon) has an explicit timeout (`PROVIDER_TIMEOUT_MS`, default
  8s) so a slow or hanging upstream can't tie up a request or an
  extraction slot indefinitely.
- **No client-side polling.** The placeholder-VTT-then-reselect flow means
  the server never polls its own background jobs on the client's behalf —
  the next fetch only happens when the user (or Stremio) naturally
  re-requests.

## Configuration (env vars)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `7000` | HTTP listen port |
| `DATA_DIR` | no | `/data` | SQLite db + cached subtitle files |
| `STREAM_ADDON_URL` | yes | — | Manifest URL of the stream addon used for tier 3 (e.g. personal AIOStreams URL) |
| `JIMAKU_API_KEY` | yes | — | Jimaku API key |
| `SUBTITLE_LANGUAGES` | no | `eng` | Comma-separated target language(s) |
| `NEGATIVE_CACHE_TTL_HOURS` | no | `24` | How long a "nothing found" result is trusted before retrying |
| `EXTRACTION_CONCURRENCY` | no | `1` | Max parallel ffmpeg extraction jobs (queued, not dropped, beyond this) |
| `EXTRACTION_TIMEOUT_MS` | no | `900000` | Kill a stuck extraction after this long |
| `PROVIDER_TIMEOUT_MS` | no | `8000` | Timeout for each outbound Jimaku/AnimeTosho/stream-addon HTTP call |
| `LOG_LEVEL` | no | `info` | Logging verbosity |

## Error handling

- Each provider tier is isolated: a failure in one (API down, malformed
  response) logs and falls through to the next tier rather than failing
  the whole request.
- ffmpeg/ffprobe are invoked via array-form `spawn` (no shell
  interpolation of the stream URL).
- All configured URLs (`STREAM_ADDON_URL`) are validated as well-formed
  at startup; the process fails fast with a clear error rather than
  failing silently on first request.

## Testing strategy (TDD)

- **ID resolver**: unit tests against a small fixture cross-reference
  dataset — known id → correct anilist/anidb id, unknown id → explicit
  "unresolvable" result.
- **Jimaku / AnimeTosho providers**: unit tests with HTTP calls mocked
  against recorded fixture responses, covering found / empty / malformed
  / error cases.
- **Cache**: unit tests for hit/miss/negative-cache-expiry using a
  temp SQLite file per test.
- **Extraction**: integration test that runs real `ffprobe`/`ffmpeg`
  against a small checked-in sample MKV with a known embedded subtitle
  track (fixture file, no network access needed), asserting correct
  WebVTT output and correct behavior when no matching-language track
  exists.
- **HTTP contract**: tests asserting `/manifest.json` and
  `/subtitles/...json` responses match the shapes Stremio expects.

## Deployment & getting started (deliverable)

A `README.md` covering:
1. Prerequisites (Docker, a Jimaku API key, your stream addon's manifest
   URL).
2. `docker-compose up` quick start with an annotated `.env.example`.
3. Installing the resulting addon in Stremio
   (`http://<host>:<port>/manifest.json`).
4. Verifying it's working (a curl example against `/subtitles/...`, what
   the logs look like on a tier-1/2/3 hit).
5. Troubleshooting (Jimaku key invalid, stream addon unreachable, ffmpeg
   missing language track).

A `Dockerfile` installing Node.js + ffmpeg, and a `docker-compose.yml`
with a persistent volume for `DATA_DIR` and env var passthrough.

## Security

Single-tenant scope removes most of the risk surface that would apply to
a shared public instance (no arbitrary third-party-supplied URLs, no
per-user quota/rate-limiting needed). What's still in scope regardless:
no secrets in source, ffmpeg/ffprobe invoked without shell
interpolation, configured URLs validated at startup, and the HTTP
surface limited to the documented manifest/subtitles endpoints (this is
not built as a general-purpose URL-fetching proxy).

## External API reference (verified live)

### Jimaku (`https://jimaku.cc`)

Confirmed against the live OpenAPI spec at `/api/openapi.json`. Auth: all
requests carry an `Authorization: <JIMAKU_API_KEY>` header.

- `GET /api/entries/search?anilist_id={id}` → `Entry[]`:
  `{ id: number, name: string, english_name: string|null,
  anilist_id: number|null, flags: { anime, movie, adult, external,
  unverified: boolean }, ... }`. Pick the first entry where
  `flags.anime` is true and `flags.adult` is false.
- `GET /api/entries/{entryId}/files?episode={n}` → `FileEntry[]`:
  `{ name: string, size: number, url: string, last_modified: string }`.
  No language field — filter `name` case-insensitively: accept files
  whose name contains `english` or a bracketed/standalone `en`/`eng`
  token (e.g. `/\b(eng(lish)?)\b/i` or `\[en\]`), and whose extension is
  `.srt`, `.ass`, or `.vtt`; reject names containing `japanese`, `jpn`,
  or `jp` tokens. `url` is a direct, ready-to-fetch download link.

### AnimeTosho (`https://feed.animetosho.org`, `https://animetosho.org`)

Confirmed live end-to-end (search → torrent detail → attachment
download → decompressed content) against a real release.

- `GET https://feed.animetosho.org/json?t=search&aid={anidbAid}&limit=50`
  → array of torrent summaries:
  `{ id: number, title: string, status: "complete"|"skipped"|..,
  anidb_aid: number, anidb_eid: number|null, num_files: number, ... }`.
  Keep `status === "complete"`; parse the episode number out of `title`
  (anime release titles commonly encode it as `- NN`, `SxxEyy`, or
  `Season N ... - NN`); prefer `num_files === 1` (a single-episode
  release, not a batch) matching the target episode.
- `GET https://feed.animetosho.org/json?show=torrent&id={torrentId}` →
  torrent detail with `files[].attachments[]`, each:
  `{ id: number, type: "subtitle"|"font"|"tags"|"other",
  info: { codec: string, lang: string, name: string, tracknum: number,
  ... }, size: number }`. Find the attachment where `type === "subtitle"`
  and `info.lang` matches the target language (ISO 639-2, e.g. `"eng"`).
- Download URL (verified, 301-redirects, response body is XZ-compressed
  text — decompress before use):
  `https://animetosho.org/storage/attach/{id8}/{encodeURIComponent(videoFilenameWithoutExt)}_track{attachment.info.tracknum}.{attachment.info.lang}.{attachment.info.codec.toLowerCase()}.xz`
  where `id8` is the attachment's numeric `id` formatted as 8-digit
  lowercase hex (`id.toString(16).padStart(8, '0')`), and
  `videoFilenameWithoutExt` is the parent file's `filename` field with
  its extension stripped. `attachment.info.codec` for a `.ass` track is
  the literal string `"ASS"` (lowercased to `ass` for the URL).
