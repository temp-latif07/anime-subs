# AnimeSubs

A self-hosted Stremio subtitle addon for anime. Tries a community subtitle
archive (Jimaku), then AnimeTosho's already-extracted embedded tracks, then
falls back to extracting the embedded subtitle track directly from your own
stream addon (e.g. AIOStreams) when nothing else has anything. Runs entirely
on your own hardware -- no cloud services required.

## Prerequisites

- Docker and Docker Compose
- A [Jimaku](https://jimaku.cc) account and API key (Account -> API Key)
- An [OpenSubtitles](https://www.opensubtitles.com) account and API key
  (Settings -> API), used as a third subtitle source alongside Jimaku and
  AnimeTosho
- The manifest URL of a Stremio stream addon that returns direct,
  already-resolved playback URLs for the content you watch (e.g. your
  personal AIOStreams instance's manifest URL, with your debrid config
  baked into it)

## Quick start

```bash
git clone <this repo>
cd anime-subs
cp .env.example .env
```

Edit `.env`:

```
STREAM_ADDON_URL=https://your-aiostreams-instance.example.com/your-config-token/manifest.json
JIMAKU_API_KEY=your-jimaku-api-key
OPENSUBTITLES_API_KEY=your-opensubtitles-api-key
```

See `.env.example` for the full list of settings (timeouts, cache TTLs,
OpenSubtitles' daily download quota, etc.) -- everything else has a
working default.

Then:

```bash
docker compose up -d
```

## Installing in Stremio

Open Stremio, go to the addon search/install bar, and enter:

```
http://<your-server-ip>:7000/manifest.json
```

(Or open that URL in a browser on the same network as your Stremio client --
most Stremio builds offer an "Install" button when a manifest URL is opened
directly.)

## Verifying it's working

Check the manifest loads:

```bash
curl http://localhost:7000/manifest.json
```

Check a real request (replace the Kitsu id and episode with a show you
know has subtitles somewhere):

```bash
curl "http://localhost:7000/subtitles/series/kitsu:46474:1:1.json"
```

Watch the logs while doing this to see which tier answered:

```bash
docker compose logs -f animesubs
```

If tiers 1 and 2 came back empty, the first request for that episode starts
a background extraction and returns a placeholder subtitle. Wait roughly a
minute (depends on the episode's file size and your connection to the
stream source), then reselect the subtitle track in Stremio -- it will now
be the real extracted text.

## Troubleshooting

- **Manifest won't load / container won't start**: check
  `docker compose logs animesubs`. A missing or malformed
  `STREAM_ADDON_URL`/`JIMAKU_API_KEY`/`OPENSUBTITLES_API_KEY` fails fast at
  startup with a specific error naming the variable.
- **Every request returns an empty subtitle list**: the incoming content id
  probably isn't resolvable against the bundled anime dataset. This addon
  resolves `kitsu:`, `mal:`, `anidb:`, and `anilist:`-prefixed ids directly,
  and `tt...`-prefixed (IMDb) ids for anime the `anime-lists` project maps
  to an IMDb id -- not every anime has one. Check what id scheme your
  metadata addon is actually serving for the content in question.
- **Tier 3 (extraction) never finds anything**: confirm
  `STREAM_ADDON_URL` actually returns a stream with a direct `url` field
  (not just `infoHash`) for that content -- test it directly:
  `curl "$(cat .env | grep STREAM_ADDON_URL | cut -d= -f2 | sed 's/manifest.json//')stream/series/kitsu:ID:1:1.json"`.
- **Jimaku requests fail with 401**: your `JIMAKU_API_KEY` is wrong or
  expired -- regenerate it from your Jimaku account page.
- **OpenSubtitles requests fail with 401/403, or never seem to run**: your
  `OPENSUBTITLES_API_KEY` is wrong, or you've hit `OPENSUBTITLES_DAILY_QUOTA`
  for the day -- it resets on a rolling 24h window from first use.
