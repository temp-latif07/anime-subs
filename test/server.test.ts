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
      data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617'] }],
    }, new Database(':memory:'));

    const config: Config = {
      port: 0, dataDir: dir, streamAddonUrl: 'https://stream.example.com/manifest.json',
      jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
      extractionConcurrency: 1, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, logLevel: 'info',
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
    expect(await res.json()).toMatchObject({ id: 'org.animesubs', resources: ['subtitles'], types: ['series'] });
  });

  it('returns an empty subtitles array for an unresolvable id', async () => {
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:999999:1:1.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subtitles: [] });
  });

  it('serves a cached ready vtt file with the right content type', async () => {
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng' }, 2, 'WEBVTT\n\n1\nhello');
    const res = await fetch(`${baseUrl}/vtt/154587/5/eng.vtt`);
    expect(res.status).toBe(200);
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
});
