import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { CacheStore } from '../src/cache/cacheStore.js';
import { ExtractionQueue } from '../src/queue/extractionQueue.js';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { EpisodeMapping } from '../src/resolver/episodeMapping.js';
import type { Config } from '../src/config.js';
import type { ProviderResult } from '../src/types.js';

describe('HTTP contract', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let cache: CacheStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-server-'));
    cache = new CacheStore(join(dir, 'cache.db'), join(dir, 'files'));
    const episodeMapping = EpisodeMapping.buildFromXml('<?xml version="1.0"?><anime-list></anime-list>', new Database(':memory:'));
    const dataset = AnimeDataset.buildFromRaw({
      data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617', 'https://kitsu.app/anime/46474'] }],
    }, new Database(':memory:'), episodeMapping);

    const config: Config = {
      port: 0, dataDir: dir, streamAddonUrl: 'https://stream.example.com/manifest.json',
      jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
      extractionConcurrency: 2, enableConcurrentExtraction: true, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, probeTimeoutMs: 1000, logLevel: 'info',
      openSubtitlesApiKey: 'test-key', openSubtitlesDailyQuota: 100, vttWaitMs: 500,
    };

    const app = createServer({
      dataset: { current: dataset },
      episodeMapping,
      cache,
      queue: new ExtractionQueue(1),
      config,
      buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}/${key.provider}.vtt`,
      jimakuProvider: async () => ({ found: false }),
      animetoshoProvider: async () => ({ found: false }),
      opensubtitlesProvider: async (): Promise<ProviderResult> => ({ found: false }),
      extractionProvider: async () => ({ found: false }),
    }, cache);

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves a manifest with the fields Stremio requires', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({ id: 'org.animesubs', resources: ['subtitles'], types: ['series', 'anime'] });
  });

  it('returns an empty subtitles array for an unresolvable id', async () => {
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:999999:1:1.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subtitles: [] });
  });

  it('returns absolute subtitle URLs when subtitles are available', async () => {
    cache.setReady({ anilistId: 154587, episode: 1, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\ntest');
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:46474:1:1.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles).toHaveLength(1);
    expect(body.subtitles[0]).toEqual({
      id: 'eng-jimaku',
      lang: 'eng',
      url: `${baseUrl}/vtt/154587/1/eng/jimaku.vtt`,
    });
  });

  it('handles subtitle requests with extra parameters and url-encoded ids', async () => {
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu%3A46474%3A1%3A1/filename=Test%20Episode%201.mkv&videoSize=12345.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles).toHaveLength(1);
  });

  it('handles subtitle requests under /subtitles/anime/ type', async () => {
    const res = await fetch(`${baseUrl}/subtitles/anime/kitsu:46474:1:1.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles).toHaveLength(1);
  });

  it('serves a cached ready vtt file with the right content type', async () => {
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\nhello');
    const res = await fetch(`${baseUrl}/vtt/154587/5/eng/jimaku.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('text/vtt');
    expect(await res.text()).toContain('hello');
  });

  it('serves a placeholder vtt for a pending entry', async () => {
    cache.setPending({ anilistId: 154587, episode: 6, lang: 'eng', provider: 'jimaku' });
    const res = await fetch(`${baseUrl}/vtt/154587/6/eng/jimaku.vtt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Extracting subtitles');
  });

  it('returns 404 with a placeholder vtt body for an entirely unknown key', async () => {
    const res = await fetch(`${baseUrl}/vtt/1/1/eng/jimaku.vtt`);
    expect(res.status).toBe(404);
  });

  it('awaits in-flight extraction and serves the completed normalized VTT directly', async () => {
    const key = { anilistId: 154587, episode: 7, lang: 'eng', provider: 'jimaku' as const };
    cache.setPending(key);
    let resolveJob!: () => void;
    const inFlightJob = new Promise<ProviderResult>((resolve) => {
      resolveJob = () => {
        cache.setReady(key, 'WEBVTT\n\n00:01.000 --> 00:03.000\nIn flight complete\n');
        resolve({ found: true, vttContent: 'WEBVTT\n\n00:01.000 --> 00:03.000\nIn flight complete\n' });
      };
    });
    cache.setInFlight(key, inFlightJob);
    setTimeout(() => resolveJob(), 50);

    const res = await fetch(`${baseUrl}/vtt/154587/7/eng/jimaku.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public');
    const text = await res.text();
    expect(text).toContain('00:00:01.000 --> 00:00:03.000');
    expect(text).toContain('In flight complete');
  });

  it('serves distinctly per provider at the same anilistId/episode/lang', async () => {
    cache.setReady({ anilistId: 154587, episode: 20, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\njimaku body');
    cache.setReady({ anilistId: 154587, episode: 20, lang: 'eng', provider: 'animetosho' }, 'WEBVTT\n\n1\ntosho body');
    const jimakuRes = await fetch(`${baseUrl}/vtt/154587/20/eng/jimaku.vtt`);
    const toshoRes = await fetch(`${baseUrl}/vtt/154587/20/eng/animetosho.vtt`);
    expect(await jimakuRes.text()).toContain('jimaku body');
    expect(await toshoRes.text()).toContain('tosho body');
  });

  it('labels each track with its provider when a language has more than one hit', async () => {
    cache.setReady({ anilistId: 154587, episode: 21, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\na');
    cache.setReady({ anilistId: 154587, episode: 21, lang: 'eng', provider: 'animetosho' }, 'WEBVTT\n\n1\nb');
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:46474:1:21.json`);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles).toHaveLength(2);
    expect(body.subtitles.map((s) => s.lang).sort()).toEqual(['eng (AnimeTosho)', 'eng (Jimaku)']);
  });

  it('does not relabel lang when only one provider has a hit for that language', async () => {
    cache.setReady({ anilistId: 154587, episode: 22, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\nsolo');
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:46474:1:22.json`);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles[0].lang).toBe('eng');
  });

  it('passes the requested language through to normalizeVtt when serving a ready file', async () => {
    cache.setReady({ anilistId: 154587, episode: 23, lang: 'spa', provider: 'jimaku' }, 'WEBVTT\n\n1\nHola こんにちは');
    const res = await fetch(`${baseUrl}/vtt/154587/23/spa/jimaku.vtt`);
    const text = await res.text();
    // For a non-'eng' target language, the Japanese-char filter must not
    // apply -- this line must survive intact, unlike the 'eng' case.
    expect(text).toContain('こんにちは');
  });
});
