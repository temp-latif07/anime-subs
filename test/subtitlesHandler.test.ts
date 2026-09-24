import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { EpisodeMapping } from '../src/resolver/episodeMapping.js';
import { CacheStore } from '../src/cache/cacheStore.js';
import { ExtractionQueue } from '../src/queue/extractionQueue.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from '../src/subtitlesHandler.js';
import { HttpTimeoutError } from '../src/http/httpClient.js';
import type { Config } from '../src/config.js';
import type { ProviderResult } from '../src/types.js';
import type { ExtractionParams } from '../src/providers/extractionProvider.js';

const episodeMapping = EpisodeMapping.buildFromXml('<?xml version="1.0"?><anime-list></anime-list>', new Database(':memory:'));
const dataset = AnimeDataset.buildFromRaw({
  data: [
    {
      title: 'Sousou no Frieren',
      sources: ['https://anidb.net/anime/17617', 'https://anilist.co/anime/154587', 'https://kitsu.app/anime/46474'],
    },
    {
      title: 'No AniDB Anime',
      sources: ['https://anilist.co/anime/200001', 'https://kitsu.app/anime/200001'],
    },
    {
      sources: ['https://anilist.co/anime/300001', 'https://kitsu.app/anime/300001'],
    },
  ],
}, new Database(':memory:'), episodeMapping);

const baseConfig: Config = {
  port: 7000, dataDir: '/tmp', streamAddonUrl: 'https://stream.example.com/manifest.json',
  jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
  extractionConcurrency: 2, enableConcurrentExtraction: true, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, probeTimeoutMs: 15000, logLevel: 'info',
  openSubtitlesApiKey: 'test-key', openSubtitlesDailyQuota: 100, vttWaitMs: 500,
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
      episodeMapping,
      cache,
      queue: new ExtractionQueue(1),
      config: baseConfig,
      buildSubtitleUrl: (key) => `https://addon.example.com/vtt/${key.anilistId}/${key.episode}/${key.lang}/${key.provider}.vtt`,
      jimakuProvider: vi.fn(async () => ({ found: false })),
      animetoshoProvider: vi.fn(async () => ({ found: false })),
      opensubtitlesProvider: vi.fn(async () => ({ found: false })),
      extractionProvider: vi.fn(async () => ({ found: false })),
    };
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces one subtitle track per Tier-1 provider that finds a match, not just one', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(2);
    expect(result.subtitles.map((s) => s.provider).sort()).toEqual(['animetosho', 'jimaku']);
  });

  it('initiates Tier 1 and extraction concurrently on uncached request, returning both tracks', async () => {
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>(() => {}));
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);

    // Both Jimaku and Extraction should be present
    expect(result.subtitles.map((s) => s.provider).sort()).toEqual(['extraction', 'jimaku']);
    // Extraction provider was started
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })?.status).toBe('pending');
  });

  it('does not initiate background extraction when a Tier 1 provider is already cached ready', async () => {
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' }, 'WEBVTT\n\n1\ncached');
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);

    expect(result.subtitles.map((s) => s.provider)).toEqual(['jimaku']);
    expect(deps.extractionProvider).not.toHaveBeenCalled();
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })).toBeNull();
  });

  it('preserves sequential fallback when enableConcurrentExtraction is false', async () => {
    deps.config = { ...deps.config, enableConcurrentExtraction: false };
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);

    expect(result.subtitles.map((s) => s.provider)).toEqual(['jimaku']);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })).toBeNull();
  });

  it('does not double-charge the OpenSubtitles quota or double-call a provider for two concurrent requests of the same episode', async () => {
    let jimakuCallCount = 0;
    let osCallCount = 0;
    deps.jimakuProvider = vi.fn(() => {
      jimakuCallCount++;
      return new Promise<ProviderResult>((resolve) => setTimeout(() => resolve({ found: true, vttContent: 'WEBVTT\n\n1\nx' }), 20));
    });
    deps.opensubtitlesProvider = vi.fn(() => {
      osCallCount++;
      return new Promise<ProviderResult>((resolve) => setTimeout(() => resolve({ found: true, vttContent: 'WEBVTT\n\n1\nos', downloadAttempted: true }), 20));
    });
    await Promise.all([
      handleSubtitlesRequest('kitsu:46474:1:5', deps),
      handleSubtitlesRequest('kitsu:46474:1:5', deps),
    ]);
    expect(jimakuCallCount).toBe(1);
    expect(osCallCount).toBe(1);
    expect(cache.getRemainingQuota('opensubtitles', deps.config.openSubtitlesDailyQuota)).toBe(deps.config.openSubtitlesDailyQuota - 1);
  });

  it('records OpenSubtitles quota usage whenever a download was attempted, even if the file is rejected afterward as low quality', async () => {
    deps.opensubtitlesProvider = vi.fn(async () => ({ found: false, downloadAttempted: true }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(cache.getRemainingQuota('opensubtitles', deps.config.openSubtitlesDailyQuota)).toBe(deps.config.openSubtitlesDailyQuota - 1);
  });

  it('does not set the negative cache for OpenSubtitles when the result is quota-skipped', async () => {
    deps.opensubtitlesProvider = vi.fn(async () => ({ found: false, quotaSkipped: true }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' as const };
    expect(cache.get(key)).toBeNull(); // not negative -- must remain retryable once quota resets
  });

  it('sets the negative cache for OpenSubtitles on a genuine miss (not quota-skipped)', async () => {
    deps.opensubtitlesProvider = vi.fn(async () => ({ found: false }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' as const };
    expect(cache.get(key)?.status).toBe('negative');
  });

  it('does not negative-cache a Tier-1 provider miss caused by a thrown error, unlike a genuine found:false miss', async () => {
    deps.jimakuProvider = vi.fn(async () => { throw new Error('jimaku 503 Service Unavailable'); });
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' as const };
    expect(cache.get(key)).toBeNull(); // not negative -- must remain retryable, this was never a real miss
  });

  it('does not negative-cache OpenSubtitles when the provider throws (e.g. a transient HTTP error)', async () => {
    deps.opensubtitlesProvider = vi.fn(async () => { throw new Error('opensubtitles 500 Internal Server Error'); });
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' as const };
    expect(cache.get(key)).toBeNull();
  });

  it('does not negative-cache the extraction key when cache.setReady throws after a successful extraction', async () => {
    const writeFailure = new Error('ENOSPC: no space left on device');
    vi.spyOn(cache, 'setReady').mockImplementationOnce(() => { throw writeFailure; });
    deps.extractionProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\nextracted' }));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await new Promise((r) => setTimeout(r, 20));
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' as const };
    expect(cache.get(key)?.status).not.toBe('negative');
  });

  it('does not negative-cache extraction when the stream-addon prefetch times out (HttpTimeoutError)', async () => {
    deps.extractionProvider = vi.fn(async () => { throw new HttpTimeoutError('stream addon timed out'); });
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await new Promise((r) => setTimeout(r, 20));
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' as const };
    expect(cache.get(key)).toBeNull();
  });

  it('resolves a tt-prefixed request via reverse imdb lookup and translates season/episode to the internal anidb-relative episode number', async () => {
    const ttXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="1001" tvdbid="5000" defaulttvdbseason="2" episodeoffset="12" imdbid="tt9999999">
    <name>Show S2</name>
  </anime>
</anime-list>`;
    const localMapping = EpisodeMapping.buildFromXml(ttXml, new Database(':memory:'));
    const localDataset = AnimeDataset.buildFromRaw({
      data: [{ sources: ['https://anidb.net/anime/1001', 'https://anilist.co/anime/2001'] }],
    }, new Database(':memory:'), localMapping);

    const localDeps: SubtitlesHandlerDeps = {
      ...deps,
      config: { ...baseConfig, enableConcurrentExtraction: false },
      dataset: { current: localDataset },
      episodeMapping: localMapping,
      jimakuProvider: vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\nmatch' })),
    };

    const result = await handleSubtitlesRequest('tt9999999:2:15', localDeps);
    expect(localDeps.jimakuProvider).toHaveBeenCalledWith(
      2001,
      3,
      'eng',
      localDeps.config.jimakuApiKey,
      expect.any(Object),
    );
    expect(result.subtitles).toEqual([
      {
        lang: 'eng',
        provider: 'jimaku',
        url: 'https://addon.example.com/vtt/2001/3/eng/jimaku.vtt',
      },
    ]);
  });

  it('passes the original tt-prefixed season/episode (not the anidb-relative one) to the extraction provider when Tier 1 misses', async () => {
    const ttXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="1001" tvdbid="5000" defaulttvdbseason="2" episodeoffset="12" imdbid="tt9999999">
    <name>Show S2</name>
  </anime>
</anime-list>`;
    const localMapping = EpisodeMapping.buildFromXml(ttXml, new Database(':memory:'));
    const localDataset = AnimeDataset.buildFromRaw({
      data: [{ sources: ['https://anidb.net/anime/1001', 'https://anilist.co/anime/2001'] }],
    }, new Database(':memory:'), localMapping);

    let passedParams: ExtractionParams | null = null;
    const localDeps: SubtitlesHandlerDeps = {
      ...deps,
      dataset: { current: localDataset },
      episodeMapping: localMapping,
      extractionProvider: vi.fn(async (params) => {
        passedParams = params;
        return { found: false };
      }),
    };

    // tt9999999:2:15 -> anidb-relative episode 15-12=3 (used for the cache key
    // and Tier 1), but the stream addon still numbers this video tt9999999 S2E15.
    await handleSubtitlesRequest('tt9999999:2:15', localDeps);
    await new Promise((r) => setTimeout(r, 20));

    expect(passedParams).not.toBeNull();
    expect(passedParams!.contentId).toBe('tt9999999');
    expect(passedParams!.season).toBe(2);
    expect(passedParams!.episode).toBe(15);

    // the cache key itself must still use the anidb-relative episode, so it's
    // shared correctly with kitsu/anilist-numbered requests for the same episode.
    const key = { anilistId: 2001, episode: 3, lang: 'eng', provider: 'extraction' as const };
    expect(cache.get(key)).not.toBeNull();
  });

  it('returns an empty list for an unresolvable content id', async () => {
    expect((await handleSubtitlesRequest('tt99999:1:1', deps)).subtitles).toEqual([]);
  });

  it('returns a tier-1 (Jimaku) hit and caches it', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', provider: 'jimaku', url: 'https://addon.example.com/vtt/154587/5/eng/jimaku.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' })?.status).toBe('ready');
  });

  it('returns AnimeTosho hit when Jimaku finds nothing', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', provider: 'animetosho', url: 'https://addon.example.com/vtt/154587/5/eng/animetosho.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'animetosho' })?.status).toBe('ready');
  });

  it('starts a background extraction and returns a placeholder entry when Tier 1 finds nothing', async () => {
    let resolveExtraction!: (r: ProviderResult) => void;
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>((resolve) => { resolveExtraction = resolve; }));

    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', provider: 'extraction', url: 'https://addon.example.com/vtt/154587/5/eng/extraction.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })?.status).toBe('pending');

    resolveExtraction({ found: true, vttContent: 'WEBVTT\n\n1\nextracted' });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })?.status).toBe('ready');
  });

  it('does not start a second extraction job while one is already in flight', async () => {
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>(() => {}));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(deps.extractionProvider).toHaveBeenCalledTimes(1);
  });

  it('skips a request whose negative cache entries have not expired', async () => {
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' });
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'animetosho' });
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' });
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' });
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([]);
    expect(deps.jimakuProvider).not.toHaveBeenCalled();
    expect(deps.animetoshoProvider).not.toHaveBeenCalled();
    expect(deps.opensubtitlesProvider).not.toHaveBeenCalled();
    expect(deps.extractionProvider).not.toHaveBeenCalled();
  });

  it('retries providers if negative cache has expired', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' as const };
    cache.setNegative(key);
    // Artificially age the entry past 24 hours
    const oldTime = Date.now() - 25 * 60 * 60 * 1000;
    (cache as unknown as { db: Database.Database }).db
      .prepare('UPDATE cache SET updated_at = ? WHERE key = ?')
      .run(oldTime, '154587:5:eng:jimaku');

    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku retry' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', provider: 'jimaku', url: 'https://addon.example.com/vtt/154587/5/eng/jimaku.vtt' }]);
    expect(deps.jimakuProvider).toHaveBeenCalledTimes(1);
    expect(cache.get(key)?.status).toBe('ready');
  });

  it('surfaces AnimeTosho match when Jimaku throws an error', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.jimakuProvider = vi.fn(async () => {
      throw new Error('Jimaku timeout');
    });
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho fallback' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', provider: 'animetosho', url: 'https://addon.example.com/vtt/154587/5/eng/animetosho.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'animetosho' })?.status).toBe('ready');
    expect(deps.animetoshoProvider).toHaveBeenCalledWith(
      17617,
      5,
      'eng',
      expect.objectContaining({
        timeoutMs: deps.config.providerTimeoutMs,
      }),
    );
  });

  it('sets negative cache when extraction provider resolves with found: false', async () => {
    deps.extractionProvider = vi.fn(async () => ({ found: false }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })?.status).toBe('negative');
  });

  it('sets negative cache when extraction provider rejects with general error', async () => {
    deps.extractionProvider = vi.fn(async () => {
      throw new Error('ffmpeg failed');
    });
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'extraction' })?.status).toBe('negative');
  });

  it('returns cached ready subtitle immediately without invoking providers', async () => {
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' as const };
    cache.setReady(key, 'WEBVTT\n\n1\nready');
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'animetosho' });
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng', provider: 'opensubtitles' });
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', provider: 'jimaku', url: 'https://addon.example.com/vtt/154587/5/eng/jimaku.vtt' }]);
    expect(deps.jimakuProvider).not.toHaveBeenCalled();
    expect(deps.animetoshoProvider).not.toHaveBeenCalled();
    expect(deps.opensubtitlesProvider).not.toHaveBeenCalled();
    expect(deps.extractionProvider).not.toHaveBeenCalled();
  });

  it('queries uncached tier-1 providers and merges hits even if another tier-1 provider is cached as ready', async () => {
    const key = { anilistId: 154587, episode: 5, lang: 'eng', provider: 'jimaku' as const };
    cache.setReady(key, 'WEBVTT\n\n1\nready');
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    deps.opensubtitlesProvider = vi.fn(async () => ({ found: false }));

    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(2);
    expect(result.subtitles.map((s) => s.provider).sort()).toEqual(['animetosho', 'jimaku']);
    expect(deps.jimakuProvider).not.toHaveBeenCalled();
    expect(deps.animetoshoProvider).toHaveBeenCalledTimes(1);
    expect(deps.opensubtitlesProvider).toHaveBeenCalledTimes(1);
    expect(deps.extractionProvider).not.toHaveBeenCalled();
  });

  it('handles multiple configured languages', async () => {
    deps.config = { ...baseConfig, subtitleLanguages: ['eng', 'spa'], enableConcurrentExtraction: false };
    deps.jimakuProvider = vi.fn(async (_anilistId, _episode, lang) => {
      if (lang === 'eng') return { found: true, vttContent: 'WEBVTT\n\n1\neng' };
      return { found: false };
    });
    deps.animetoshoProvider = vi.fn(async () => ({ found: false }));
    deps.extractionProvider = vi.fn(() => new Promise<ProviderResult>(() => {}));

    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(2);
    expect(result.subtitles).toEqual([
      { lang: 'eng', provider: 'jimaku', url: 'https://addon.example.com/vtt/154587/5/eng/jimaku.vtt' },
      { lang: 'spa', provider: 'extraction', url: 'https://addon.example.com/vtt/154587/5/spa/extraction.vtt' },
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

  it('skips Jimaku and AnimeTosho for subsequent episodes when series-level miss is recorded', async () => {
    deps.jimakuProvider = vi.fn(async () => ({ found: false, seriesNotFound: true }));
    deps.animetoshoProvider = vi.fn(async () => ({ found: false, seriesNotFound: true }));
    deps.extractionProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\nextracted' }));

    // Episode 5 query
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(deps.jimakuProvider).toHaveBeenCalledTimes(1);
    expect(deps.animetoshoProvider).toHaveBeenCalledTimes(1);

    // Episode 6 query
    await handleSubtitlesRequest('kitsu:46474:1:6', deps);
    expect(deps.jimakuProvider).toHaveBeenCalledTimes(1);
    expect(deps.animetoshoProvider).toHaveBeenCalledTimes(1);
  });

  it('passes pre-fetched streamUrls promise to extractionProvider on tier 3 fallback', async () => {
    let passedParams: ExtractionParams | null = null;
    deps.extractionProvider = vi.fn(async (params) => {
      passedParams = params;
      return { found: true, vttContent: 'WEBVTT\n\n1\nprefetched' };
    });

    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(passedParams).not.toBeNull();
    expect(passedParams!.streamUrls).toBeDefined();
    expect(passedParams!.streamUrls instanceof Promise).toBe(true);
    expect(passedParams!.probeTimeoutMs).toBe(deps.config.probeTimeoutMs);
  });

  it('passes resolved anime title to animetoshoProvider for fallback searching', async () => {
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(deps.animetoshoProvider).toHaveBeenCalledWith(
      17617,
      5,
      'eng',
      expect.objectContaining({ title: 'Sousou no Frieren' }),
    );
  });

  it('runs animetoshoProvider when anidbId is null but title is present', async () => {
    deps.config = { ...baseConfig, enableConcurrentExtraction: false };
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho title hit' }));
    const result = await handleSubtitlesRequest('kitsu:200001:1:1', deps);
    expect(deps.animetoshoProvider).toHaveBeenCalledWith(
      null,
      1,
      'eng',
      expect.objectContaining({ title: 'No AniDB Anime' }),
    );
    expect(result.subtitles).toHaveLength(1);
    expect(cache.get({ anilistId: 200001, episode: 1, lang: 'eng', provider: 'animetosho' })?.status).toBe('ready');
  });

  it('skips animetoshoProvider when anidbId is null and title is absent', async () => {
    await handleSubtitlesRequest('kitsu:300001:1:1', deps);
    expect(deps.animetoshoProvider).not.toHaveBeenCalled();
  });

  it('does not record series-level miss for animetosho when anidbId is null and provider reports seriesNotFound', async () => {
    deps.animetoshoProvider = vi.fn(async () => ({ found: false, seriesNotFound: true }));
    const spySetMiss = vi.spyOn(cache, 'setSeriesProviderMiss');
    await handleSubtitlesRequest('kitsu:200001:1:1', deps);
    expect(deps.animetoshoProvider).toHaveBeenCalled();
    const toshoMissCalls = spySetMiss.mock.calls.filter((call) => call[0] === 'animetosho');
    expect(toshoMissCalls).toHaveLength(0);
  });
});
