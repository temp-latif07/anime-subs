import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { CacheStore } from '../src/cache/cacheStore.js';
import { ExtractionQueue } from '../src/queue/extractionQueue.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from '../src/subtitlesHandler.js';
import type { Config } from '../src/config.js';
import type { ProviderResult } from '../src/types.js';

const dataset = AnimeDataset.buildFromRaw({
  data: [{ sources: ['https://anidb.net/anime/17617', 'https://anilist.co/anime/154587', 'https://kitsu.app/anime/46474'] }],
}, new Database(':memory:'));

const baseConfig: Config = {
  port: 7000, dataDir: '/tmp', streamAddonUrl: 'https://stream.example.com/manifest.json',
  jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
  extractionConcurrency: 1, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, logLevel: 'info',
};

describe('handleSubtitlesRequest', () => {
  let dir: string;
  let cache: CacheStore;
  let deps: SubtitlesHandlerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-handler-'));
    cache = new CacheStore(join(dir, 'cache.db'), join(dir, 'files'));
    deps = {
      dataset: { current: dataset },
      cache,
      queue: new ExtractionQueue(1),
      config: baseConfig,
      buildSubtitleUrl: (key) => `https://addon.example.com/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
      jimakuProvider: vi.fn(async () => ({ found: false })),
      animetoshoProvider: vi.fn(async () => ({ found: false })),
      extractionProvider: vi.fn(async () => ({ found: false })),
    };
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty list for an unresolvable content id', async () => {
    expect((await handleSubtitlesRequest('tt99999:1:1', deps)).subtitles).toEqual([]);
  });

  it('returns a tier-1 (Jimaku) hit and caches it', async () => {
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', url: 'https://addon.example.com/vtt/154587/5/eng.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('ready');
  });

  it('falls through to tier 2 (AnimeTosho) when tier 1 finds nothing', async () => {
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.tier).toBe(2);
  });

  it('starts a background extraction and returns a placeholder entry when tiers 1-2 find nothing', async () => {
    let resolveExtraction!: (r: ProviderResult) => void;
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>((resolve) => { resolveExtraction = resolve; }));

    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('pending');

    resolveExtraction({ found: true, vttContent: 'WEBVTT\n\n1\nextracted' });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('ready');
  });

  it('does not start a second extraction job while one is already in flight', async () => {
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>(() => {}));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(deps.extractionProvider).toHaveBeenCalledTimes(1);
  });

  it('skips a request whose negative cache entry has not expired', async () => {
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng' });
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([]);
    expect(deps.jimakuProvider).not.toHaveBeenCalled();
  });

  it('retries providers if negative cache has expired', async () => {
    const key = { anilistId: 154587, episode: 5, lang: 'eng' };
    cache.setNegative(key);
    // Artificially age the entry past 24 hours
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    (cache as unknown as { db: Database.Database }).db
      .prepare('UPDATE cache SET updated_at = ? WHERE key = ?')
      .run(oldTime, '154587:5:eng');

    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku retry' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', url: 'https://addon.example.com/vtt/154587/5/eng.vtt' }]);
    expect(deps.jimakuProvider).toHaveBeenCalledTimes(1);
    expect(cache.get(key)?.status).toBe('ready');
  });

  it('falls through tier 1 to tier 2 when tier 1 throws an error', async () => {
    deps.jimakuProvider = vi.fn(async () => {
      throw new Error('Jimaku timeout');
    });
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho fallback' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', url: 'https://addon.example.com/vtt/154587/5/eng.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.tier).toBe(2);
  });

  it('sets negative cache when extraction provider resolves with found: false', async () => {
    deps.extractionProvider = vi.fn(async () => ({ found: false }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('negative');
  });

  it('sets negative cache when extraction provider rejects', async () => {
    deps.extractionProvider = vi.fn(async () => {
      throw new Error('ffmpeg failed');
    });
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('negative');
  });

  it('returns cached ready subtitle immediately without invoking providers', async () => {
    const key = { anilistId: 154587, episode: 5, lang: 'eng' };
    cache.setReady(key, 1, 'WEBVTT\n\n1\nready');
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', url: 'https://addon.example.com/vtt/154587/5/eng.vtt' }]);
    expect(deps.jimakuProvider).not.toHaveBeenCalled();
    expect(deps.animetoshoProvider).not.toHaveBeenCalled();
    expect(deps.extractionProvider).not.toHaveBeenCalled();
  });

  it('handles multiple configured languages', async () => {
    deps.config = { ...baseConfig, subtitleLanguages: ['eng', 'spa'] };
    deps.jimakuProvider = vi.fn(async (_anilistId, _episode, lang) => {
      if (lang === 'eng') return { found: true, vttContent: 'WEBVTT\n\n1\neng' };
      return { found: false };
    });
    deps.animetoshoProvider = vi.fn(async () => ({ found: false }));
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>(() => {}));

    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(2);
    expect(result.subtitles).toEqual([
      { lang: 'eng', url: 'https://addon.example.com/vtt/154587/5/eng.vtt' },
      { lang: 'spa', url: 'https://addon.example.com/vtt/154587/5/spa.vtt' },
    ]);
  });

  it('processes multiple configured languages concurrently', async () => {
    deps.config = { ...baseConfig, subtitleLanguages: ['eng', 'spa'] };
    const started: string[] = [];
    deps.jimakuProvider = vi.fn((_anilistId, _episode, lang) => {
      started.push(lang);
      return new Promise<ProviderResult>((resolve) => setTimeout(() => resolve({ found: false }), 20));
    });
    deps.animetoshoProvider = vi.fn(async () => ({ found: false }));
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>(() => {}));

    const promise = handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(started).toEqual(['eng', 'spa']);
    await promise;
  });
});
