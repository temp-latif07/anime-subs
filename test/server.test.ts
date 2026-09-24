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
import type { Config } from '../src/config.js';

describe('HTTP contract', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let cache: CacheStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-server-'));
    cache = new CacheStore(join(dir, 'cache.db'), join(dir, 'files'));
    const dataset = AnimeDataset.buildFromRaw({
      data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617', 'https://kitsu.app/anime/46474'] }],
    }, new Database(':memory:'));

    const config: Config = {
      port: 0, dataDir: dir, streamAddonUrl: 'https://stream.example.com/manifest.json',
      jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
      extractionConcurrency: 1, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, probeTimeoutMs: 15000, logLevel: 'info',
    };

    const app = createServer({
      dataset: { current: dataset },
      cache,
      queue: new ExtractionQueue(1),
      config,
      buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
      jimakuProvider: async () => ({ found: false }),
      animetoshoProvider: async () => ({ found: false }),
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
    cache.setReady({ anilistId: 154587, episode: 1, lang: 'eng' }, 1, 'WEBVTT\n\n1\ntest');
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:46474:1:1.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subtitles: Array<{ id: string; lang: string; url: string }> };
    expect(body.subtitles).toHaveLength(1);
    expect(body.subtitles[0]).toEqual({
      id: 'eng-1',
      lang: 'eng',
      url: `${baseUrl}/vtt/154587/1/eng.vtt`,
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
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng' }, 2, 'WEBVTT\n\n1\nhello');
    const res = await fetch(`${baseUrl}/vtt/154587/5/eng.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('text/vtt');
    expect(await res.text()).toContain('hello');
  });

  it('serves a placeholder vtt for a pending entry', async () => {
    cache.setPending({ anilistId: 154587, episode: 6, lang: 'eng' });
    const res = await fetch(`${baseUrl}/vtt/154587/6/eng.vtt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Extracting subtitles');
  });

  it('returns 404 with a placeholder vtt body for an entirely unknown key', async () => {
    const res = await fetch(`${baseUrl}/vtt/1/1/eng.vtt`);
    expect(res.status).toBe(404);
  });

  it('awaits in-flight extraction and serves the completed normalized VTT directly', async () => {
    const key = { anilistId: 154587, episode: 7, lang: 'eng' };
    cache.setPending(key);
    let resolveJob!: () => void;
    const inFlightJob = new Promise<any>((resolve) => {
      resolveJob = () => {
        cache.setReady(key, 3, 'WEBVTT\n\n00:01.000 --> 00:03.000\nIn flight complete\n');
        resolve({ found: true, vttContent: 'WEBVTT\n\n00:01.000 --> 00:03.000\nIn flight complete\n' });
      };
    });
    cache.setInFlight(key, inFlightJob);
    setTimeout(() => resolveJob(), 50);

    const res = await fetch(`${baseUrl}/vtt/154587/7/eng.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('public');
    const text = await res.text();
    expect(text).toContain('00:00:01.000 --> 00:00:03.000');
    expect(text).toContain('In flight complete');
  });
});
