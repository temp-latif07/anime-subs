# Code Review — 2026-09-24

Whole-repository architecture/quality review (not a diff review — git status was clean at review time). Scope: this is a Stremio addon that fetches English anime subtitles for a Samsung TV. At review time it surfaces only one subtitle per episode, tier-3 (ffmpeg extraction) fallback takes ~30s to appear on the TV, and tiers 1 (Jimaku) and 2 (AnimeTosho) have low hit rates.

22 findings, ranked most-severe first within each group below. All findings were verified against the source (either by the reviewing agent directly, or independently re-verified in this session); two are explicitly marked `PLAUSIBLE` where live-API behavior couldn't be confirmed statically.

## Suggested fix priority

1. `animeDataset.ts:48` — dataset refresh can silently empty the whole lookup table for up to 24h (highest blast radius)
2. `subtitlesHandler.ts:67` — negative cache blocks tier 1/2 retries, not just tier 3
3. `jimakuProvider.ts:22` — no fallback when the first matching file fails
4. `subtitlesHandler.ts:129` — fast-tier result delayed by the slowest sibling tier
5. `assUtils.ts:44` — song-style regex misses `OP1`/`Opening`/etc.

---

## Why only one subtitle ever shows

### 1. Single subtitle marked available before extraction confirms
**`src/subtitlesHandler.ts:82`**

Only one subtitle URL is ever surfaced per language, and it's marked "available" the instant tier-3 extraction *starts*, not once a subtitle is actually found.

CacheKey has no source/variant dimension, and `resolveOneLanguage` builds one `buildSubtitleUrl(key)` per language. When tiers 1/2 miss, `startExtractionInBackground` fires and the function unconditionally returns `true` before extraction has produced anything. This structurally caps the client-visible subtitle list at one entry per episode, regardless of which tier eventually answers — this is the root mechanism behind "only one subtitle ever surfaces."

---

## Why tier-3 extraction takes ~30s

### 2. Fast tier result delayed by slowest sibling tier
**`src/subtitlesHandler.ts:129`**

`tryFastTiers`' `Promise.all` waits for AnimeTosho's unbounded sequential candidate walk even when Jimaku already hit, blocking both the `/subtitles` JSON response and the start of tier-3 extraction.

Jimaku can resolve in 200ms with a hit, but AnimeTosho may be mid-way through a sequential per-candidate walk that takes several seconds for a popular series with many torrents. `Promise.all` doesn't return until both settle, so an already-successful result — and the start of tier-3 extraction on a fast-tier miss — is delayed by AnimeTosho's slowest case.

### 3. Single stalled extraction can block all other requests
**`src/providers/extractionProvider.ts:35`** — `PLAUSIBLE`

The fast in-memory probe's remote-ffprobe fallback and the full extraction inherit the same `extractionTimeoutMs` (default 900000ms), and with default `EXTRACTION_CONCURRENCY=1`, a single slow/stalled stream can occupy the sole queue slot for many minutes, serializing every other pending tier-3 request behind it.

The 5s fast probe (`probe.ts`) falling back to remote ffprobe inherits the full 900000ms timeout. With concurrency=1, a stalled debrid/stream source can occupy the queue for up to ~15 min per candidate across up to 5 candidates, starving every other request in the FIFO queue. Plausible explanation for tier-3 latency that is sometimes ~30s and sometimes far worse — confirm via extraction duration logs.

### 4. Tier-3 wait can outlast client timeout, serving a placeholder
**`src/server.ts:64`**

The `/vtt` route blocks up to 35s waiting on in-flight tier-3 extraction; if the TV client's own timeout is shorter, extraction can succeed server-side while the client never sees it, and the fallback is a static placeholder cue served as if it were the real subtitle.

If the client aborts before 35s, extraction may finish moments later but the client already gave up. If the wait expires first, the client is served literal cue text ("Extracting subtitles — reselect this track in about a minute."). The README documents manually reselecting the track as the required workaround, confirming this is a known, unresolved limitation.

### 5. Range probe has no byte cap on non-Range hosts
**`src/ffmpeg/probe.ts:142`** (`fetchBuffer` in `src/http/httpClient.ts`)

The fast in-memory buffer probe sends a `Range` header but `fetchBuffer` only checks `res.ok` (true for any 2xx, including a plain 200 from a host that ignores Range and returns the whole file), with no byte cap on `res.arrayBuffer()`.

Against a Range-ignoring host, this can pull a large fraction of a multi-GB file into memory before the 5s timeout aborts it — once per candidate stream (up to 5 per extraction attempt) — wasting both latency and memory on the tier-3 hot path, and it still falls through to the slower ffprobe path afterward anyway.

---

## Why tiers 1/2 have low hit rates

### 6. Jimaku language match too strict, no fallback file
**`src/providers/jimakuProvider.ts:22`**

`matchesLanguage` requires an explicit `english`/`eng`/`[en]` filename token, and `findJimakuSubtitle` only tries the first matching file via `files.find`, never falling back if that file fails the acceptability check.

A Jimaku entry hosting one untagged file per episode ("Show Name - 05.srt", no language token) fails `matchesLanguage` for every file, so tier 1 reports not-found even though the correct file is present. Separately, if two English-tagged files exist and the first picked fails `isAcceptableSubtitle`, the function gives up instead of trying the second — both directly explain tier 1's low hit rate.

### 7. Empty episode search caches a 24h series-wide miss
**`src/providers/animetoshoProvider.ts:83`** — `PLAUSIBLE`

An episode-scoped search returning zero results is treated as `seriesNotFound`, setting a 24h SERIES-level negative cache that blocks tier 2 for every future episode of that show.

The `aid`+`q` search for episode 5 returns 0 results (just aired, not yet indexed, or query text doesn't match). `seriesNotFound=true` sets a 24h series miss. Episode 6, released the next day and fully indexed, never gets queried because the whole series is marked missed. Plausibly triggers routinely for newly-airing shows.

### 8. One failing candidate aborts entire AnimeTosho search
**`src/providers/animetoshoProvider.ts:104`**

`findAnimeToshoSubtitle`'s candidate loop has no try/catch around per-candidate I/O, so one failing fetch/download/decompress/convert throws and aborts the whole search instead of trying remaining candidates.

With 5 "complete" torrent candidates, candidate #2's `fetchJson` throwing (transient 500, timeout, stale id) propagates out entirely, skipping candidates #3-#5 which might have had the correct subtitle. The outer `.catch` turns this into a plain "not found," directly reducing tier-2's measured hit rate.

### 9. `q=` episode filter may exclude batch torrent titles
**`src/providers/animetoshoProvider.ts:82`** — `PLAUSIBLE`, unverified against live API

The `q=${episode}` parameter added alongside `aid=` for targeted per-episode search may cause AnimeTosho's server-side text search to exclude batch-torrent titles that don't literally contain the bare episode number as a token.

A batch release titled `[Group] Show (01-12) [1080p]` has no standalone "5" token, so `q=5` could exclude it from the result set — undermining the same codebase's own batch-torrent (`num_files > 1`) matching logic, since those releases would never appear in the `q`-filtered results to begin with. The test suite's mock server ignores `q` for aid-matched requests, so this real-API behavior was never exercised by tests. Would need a live API check against a known batch release to confirm.

### 10. 24h negative cache blocks tier 1/2 retries too
**`src/subtitlesHandler.ts:67`**

The negative-cache check runs before `tryFastTiers` is ever called, so a single transient tier-3 failure sets a 24h negative cache that also blocks tiers 1 and 2 from being retried during the window, even if Jimaku/AnimeTosho would succeed shortly after.

Tiers 1/2 miss, tier-3 fails (transient network blip) and `setNegative` is called. 10 minutes later the correct subtitle is uploaded to Jimaku, but the next request hits the negative-cache short-circuit before `jimakuProvider` is ever invoked again — no subtitle reported for up to 24h despite tier 1 now having the answer.

### 11. Stream-addon timeout mistaken for "no stream," cached 24h
**`src/subtitlesHandler.ts:78`**

The pre-fetched `streamUrlsPromise`'s `.catch(() => [])` swallows the `HttpTimeoutError` that `streamAddonClient` deliberately throws to distinguish "stream addon is slow/down" from "no stream exists," collapsing both into "not found" with the same 24h negative-cache path.

`streamAddonClient` explicitly rethrows `HttpTimeoutError` when every candidate query timed out. `subtitlesHandler`'s `.catch(() => [])` erases that signal before `runExtractionTier` sees it, so a transient outage of the user's own stream addon is treated identically to "this episode genuinely has no stream," and both are cached negative for 24h.

### 12. Tiers 1/2 have no in-flight request de-duplication
**`src/subtitlesHandler.ts:99`**

Only tier 3 has an in-flight de-duplication guard (`cache.getInFlight`/`setInFlight`); tiers 1 and 2 have none, so concurrent requests for the same uncached episode each independently hit Jimaku/AnimeTosho.

Two near-simultaneous requests for the same uncached `(anilistId, episode, lang)` each independently call `jimakuProvider`/`animetoshoProvider`, doubling upstream API load and risking Jimaku rate-limit (429) responses that surface as additional false tier-1 misses — directly feeding the reported low tier-1 hit rate.

---

## Extraction quality bugs (bad or empty subtitles served)

### 13. ASS extraction skips English-only filtering, no quality gate
**`src/ffmpeg/extract.ts:78`**

The ASS stream-copy path calls `convertAssToVtt` with no `targetLang`, so tier-3 ASS extractions skip all song/karaoke/Japanese-line filtering — and `extractionProvider.ts` never calls `isAcceptableSubtitle`, so garbage/empty results can be cached as "ready" and served for 24h.

`targetLang` stays `undefined` (no default), so eng-only filter regexes never fire. A fansub ASS track with OP/ED lyrics or Japanese-only signs is extracted verbatim into the "English" subtitle. A fully Japanese or empty extraction is written via `cache.setReady` and served with `max-age=86400`.

### 14. Japanese regex also matches fullwidth Latin/punctuation
**`src/ffmpeg/assUtils.ts:43`**

`JAPANESE_CHAR_REGEX` includes the Halfwidth/Fullwidth Forms block (`＀-￯`) and CJK Symbols/Punctuation (`　-〿`), not just Japanese script, so it over-deletes or mis-scores non-Japanese lines.

An English subtitle line containing a fullwidth punctuation character (fullwidth `!`, `~`, ideographic space, or fullwidth Latin letters — not rare in officially-styled or copy-pasted ASS releases) matches this "Japanese" regex and is silently deleted by `finalizeCue` / the ASS line filter, or skews the `isAcceptableSubtitle` Latin/Japanese ratio, causing an otherwise-valid English line or file to be dropped.

### 15. Song-style regex misses OP1/Opening/ED2 style names
**`src/ffmpeg/assUtils.ts:44`**

`SONG_STYLE_REGEX`'s `\b` word-boundary requirement means extremely common ASS style names like "OP1", "ED2", "Opening", "Ending", and "OPJP" never match, so the song-lyric filter is silently skipped for them.

Verified via direct regex test: `/^(op|ed|song|karaoke|lyrics|insert|music)\b|kanji|romaji/i.test('OP1')` and `.test('Opening')` both return `false`, since `p`→`1` and `p`→`e` are word-to-word transitions with no boundary. Only bare "OP"/"ED" or separator-delimited forms like "OP - 1" match. A style literally named "OP1" or "Opening" — among the most common fansub naming conventions — bypasses the song-lyric filter entirely; if the line also lacks a `\k` karaoke tag and uses romanized lyrics, it renders unfiltered into the "English" output.

### 16. Stream selection ignores codec, may pick bitmap track
**`src/ffmpeg/probe.ts:93`**

`parseSubtitleStreams` matches any subtitle stream with the requested language tag regardless of codec, so it can pick a bitmap subtitle (PGS/VobSub) over a text track in the same file; when the later webvtt transcode of a bitmap codec fails, extraction moves to the next candidate URL rather than the next stream in the same file.

A file with both an ASS text track and a PGS bitmap track tagged English: `matching.find` has no codec preference and may select PGS first. `extract.ts`'s codec branches only special-case ass/ssa/subrip/srt; PGS falls to the default webvtt transcode, which ffmpeg cannot do for image-based subtitles and errors. The per-URL try/catch then discards the whole candidate and moves to the next URL, even though the same file's ASS track would have worked.

### 17. English-only filter always applied regardless of language
**`src/cache/cacheStore.ts:55`**

`normalizeVtt` is invoked without forwarding the entry's actual language at both write time (`setReady`) and serve time (`server.ts`'s `/vtt` route), so the English-specific Japanese-character/song-line stripping always runs by default regardless of which language was actually requested.

Both call sites omit the second `targetLang` argument, so `normalizeVtt`'s default `targetLang='eng'` always applies — if `SUBTITLE_LANGUAGES` is ever configured with a non-English language, that language's cues are still silently run through the eng-only Japanese-character filter on every write and serve, potentially stripping legitimate lines.

---

## Reliability / operational risk

### 18. Dataset refresh can leave `anime_ids` empty for 24h
**`src/resolver/animeDataset.ts:48`** + **`src/index.ts:20-24`** — highest severity in this review

A single malformed entry during the 24h dataset refresh can leave the live `anime_ids` table permanently empty until the next successful refresh, breaking every subtitle lookup.

`index.ts` reuses the same `datasetDb` connection across every refresh. `AnimeDataset.buildFromRaw` runs a bare `db.exec('DROP TABLE IF EXISTS anime_ids; CREATE TABLE ...')` outside any transaction, which SQLite auto-commits immediately, then runs `insertMany` wrapped in `db.transaction`. If any entry in the freshly-downloaded JSON throws during insertion (e.g. `extractIds` iterating a null/missing `sources` field), better-sqlite3 rolls back only the insert transaction — the DROP+CREATE already committed. `index.ts`'s `setInterval` catch just logs the error and leaves `datasetHolder.current` pointing at the same `AnimeDataset`/connection, whose table is now empty. Every subtitle request in that window logs "Content ID not resolvable" and returns zero subtitles for every anime, for up to 24h.

### 19. Dataset download failure crash-loops with no DB fallback
**`src/index.ts:21`**

`downloadDataset()` at startup has no timeout and no fallback to the already-populated `anime-dataset.db` on the persistent volume; any failure is fatal via `main().catch(() => process.exit(1))`.

GitHub is briefly unreachable or rate-limited when the container starts (routine after a host reboot or transient network blip under Docker's restart policy). The process exits, Docker restarts it, `downloadDataset()` fails again — an infinite crash-loop — even though a valid `anime_ids` table from the previous successful run already sits in the mounted sqlite file and could have kept serving.

### 20. Pending extraction stuck forever after a restart
**`src/cache/cacheStore.ts:14`**

A `status='pending'` row is never re-driven after a process restart: the in-memory `inFlight` Map is wiped, but the persisted SQLite row stays `pending` forever, with no SIGTERM/shutdown handling to avoid or repair this on redeploy.

Container is redeployed/OOM-killed mid-extraction. `inFlight` (in-memory) is lost, but `cache.db` still has `status='pending'`. On restart, `resolveOneLanguage` sees pending and returns "available" without restarting extraction; `server.ts`'s `getInFlight` is undefined so it serves the placeholder text forever. That episode/lang is permanently broken until an operator manually clears the row.

### 21. Stale cache entry advertises a subtitle that always 404s
**`src/subtitlesHandler.ts:58`**

A cached "ready" entry is trusted and returned as available without checking its backing file still exists, unlike the `/vtt` route which does check `existsSync` — if the file is ever removed, the subtitle is listed as permanently available yet always 404s, with no self-healing.

`cache.db` retains a `status='ready'` row for a key whose file under `/data/subtitles` was deleted (manual cleanup, partial volume restore, disk issue). `resolveOneLanguage` returns `true` unconditionally on `cached.status === 'ready'`, so the endpoint keeps advertising that language indefinitely while every actual `/vtt` fetch 404s — neither path ever clears or re-derives the stale row.

### 22. Disk write failure discards a successful extraction
**`src/subtitlesHandler.ts:172`**

A throw inside the tier-3 background job's success branch (e.g. `cache.setReady`'s `writeFileSync` failing on a full or read-only disk) falls into the surrounding `.catch`, which calls `setNegative` — discarding a genuinely successful extraction and caching it negative for 24h.

`runExtractionTier` resolves with `found:true` + `vttContent`. `cache.setReady` throws because `writeFileSync` fails (disk full, permission issue on the `/data` volume). The chained `.catch` calls `setNegative` — a real, already-extracted subtitle is thrown away and the episode marked negative for up to 24h even though extraction succeeded.

---

## Methodology

Whole-repository architecture/quality review. Read every `src/` file directly, cross-checked against every test file, the README, and design/implementation plan docs. Ran 7 parallel finder-agent forks covering: line-by-line correctness, invariant/state-consistency, cross-file tracing, JS/TS pitfalls, wrapper/adapter correctness, reuse/simplification, and efficiency/altitude. All 7 forks reported in. Findings marked `PLAUSIBLE` could not be confirmed without a live-API check or production log data; everything else was confirmed by direct source inspection (in several cases independently re-verified in this session, including a live regex test for finding #15).
