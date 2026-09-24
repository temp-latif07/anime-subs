# Full-Dialogue Subtitle Enforcement & Forced Track Filtering

## Context

When serving subtitles for dual-audio anime releases (such as `Daemons of the Shadow Realm S01E02`), torrents on AnimeTosho and video containers frequently contain multiple subtitle tracks for the same language (e.g. `eng`):
1. **Forced Subtitles (`[Forced]`, `forced: 1`)**: Intended for English Dub watchers. It intentionally contains **zero character dialogue**, only translating on-screen Japanese signs, titles, and opening/ending theme song lyrics.
2. **Full Subtitles (`forced: 0`, `default: 1`)**: Intended for Japanese audio watchers. Contains complete character dialogue starting from the first spoken line, along with signs and songs.

Currently:
- `src/providers/animetoshoProvider.ts` filters attachments strictly by `type === 'subtitle' && info.lang === lang && info.codec && info.tracknum !== undefined`. It does not check `info.forced`, track names, or default flags, and immediately returns the first attachment. Because forced tracks often have a lower track number than full dialogue tracks (e.g. track 16 vs track 17 in LbE3L release), the forced track is served.
- `isAcceptableSubtitle` accepts the forced track because song lyrics and title signs satisfy the 20 Latin character threshold.
- `src/ffmpeg/probe.ts` filters out stream titles with `sign` and `song`, but does not inspect `disposition.forced` or titles containing `forced`.

On playback, users watching with Japanese audio see no subtitles for spoken lines, while signs appear on time, creating the perception that subtitles are missing or timing is broken.

## Goals

- Completely prevent forced and signs/songs-only subtitle tracks from being selected by `animetoshoProvider` and `probe.ts`.
- Prioritize full dialogue tracks (preferring `default: 1` and larger cue/payload size).
- Ensure existing test suites pass and new regression tests cover forced track filtering.

## Non-Goals

- Multi-track variant routing (`forced` alongside `full`): The user explicitly confirmed they only watch subbed content. Serving both would add complexity and risk Stremio auto-selecting the wrong track.
- Automated release-tag matching via filename: Kept separate for a future release-matching enhancement.

## Design

### 1. `animetoshoProvider.ts` Attachment Filtering & Prioritization

In `findAnimeToshoSubtitle()`:
```typescript
interface ToshoAttachment {
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

Filtering:
1. Exclude any attachment where `a.info.forced === 1`.
2. Exclude any attachment where `(a.info.name ?? '').toLowerCase()` contains:
   - `forced`
   - `sign` (or `signs`)
   - `song` (or `songs`)

Sorting:
1. Sort attachments with `a.info.default === 1` before non-default tracks (`b.info.default === 0`).
2. Secondary sort by `(b.size ?? 0) - (a.size ?? 0)` (descending size: full dialogue tracks with hundreds of cues are significantly larger than sign-only tracks).

Fallback:
If every subtitle attachment for that language was marked forced/signs, return none (`found: false`), allowing Tier 2 (stream extraction) or other providers to provide full subtitles.

### 2. `probe.ts` FFmpeg Stream Parsing Hardening

In `parseSubtitleStreams()`:
```typescript
interface FfprobeStream {
  index: number;
  codec_name?: string;
  disposition?: { forced?: number; default?: number };
  tags?: { language?: string; title?: string };
}
```

Stream selection:
1. When selecting dialogue streams from candidate text streams:
   - Reject any stream where `s.disposition?.forced === 1`.
   - Reject any stream where `(s.tags?.title ?? '').toLowerCase()` matches `forced`, `sign`, or `song`.
2. If multiple dialogue streams remain, sort by `disposition.default === 1` first.
3. Only consider forced streams as a last resort if no non-forced streams exist, or prefer returning null to let other providers resolve.

### 3. Cache Purge

Existing cached entries that contain forced subtitles (e.g. `195600:2:eng:animetosho`) must be invalidated or deleted so that re-requesting the episode fetches the correct full dialogue track.

## Testing & Verification Plan

1. **Unit Tests (`test/providers/animetoshoProvider.test.ts`)**:
   - Add a test case with multiple attachments for the same language: Track 1 (Forced, 6KB) and Track 2 (Full, 35KB). Verify Track 2 is selected.
   - Add a test case where `info.name` contains `CR ASS) English [Forced]` with `info.forced: 0` or missing. Verify it is skipped in favor of the full track.
   - Add a test case verifying `default: 1` prioritization.
2. **Unit Tests (`test/ffmpeg/probe.test.ts`)**:
   - Test that `parseSubtitleStreams` ignores streams with `disposition: { forced: 1 }` or title `English [Forced]`.
3. **End-to-End Test Suite**:
   - Run `npm test` across all 20 test files to verify zero regressions.
