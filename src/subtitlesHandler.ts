import { parseSubtitleRequestId, resolveIds, type ParsedSubtitleRequestId } from './resolver/idResolver.js';
import { getPlayableStreamUrls } from './providers/streamAddonClient.js';
import { HttpTimeoutError } from './http/httpClient.js';
import type { AnimeDataset } from './resolver/animeDataset.js';
import type { EpisodeMapping } from './resolver/episodeMapping.js';
import type { CacheStore } from './cache/cacheStore.js';
import type { ExtractionQueue } from './queue/extractionQueue.js';
import type { Config } from './config.js';
import type { CacheKey, CacheProvider, ProviderResult, SubtitleCandidate } from './types.js';
import type { ExtractionParams } from './providers/extractionProvider.js';

export interface DatasetHolder {
  current: AnimeDataset;
}

export interface SubtitlesHandlerDeps {
  dataset: DatasetHolder;
  episodeMapping: EpisodeMapping;
  cache: CacheStore;
  queue: ExtractionQueue;
  config: Config;
  buildSubtitleUrl: (key: CacheKey) => string;
  animetoshoProvider: (anidbId: number | null, episode: number, lang: string, opts?: { timeoutMs?: number; title?: string | null; feedBaseUrl?: string; storageBaseUrl?: string }) => Promise<ProviderResult>;
  extractionProvider: (params: ExtractionParams) => Promise<ProviderResult>;
}

function resolveEffectiveEpisode(
  parsed: ParsedSubtitleRequestId,
  anidbId: number | null,
  episodeMapping: EpisodeMapping,
): number {
  if (!parsed.contentId.startsWith('tt') || anidbId === null) return parsed.episode;
  const tvdbId = episodeMapping.findByAnidbId(anidbId)?.tvdbId ?? null;
  if (!tvdbId) return parsed.episode;
  const reversed = episodeMapping.mapTvdbToAnidbEpisode(tvdbId, parsed.season, parsed.episode);
  return reversed?.anidbEpisode ?? parsed.episode;
}

function runProvider(
  provider: CacheProvider,
  baseKey: { anilistId: number; episode: number; lang: string },
  anidbId: number | null,
  deps: SubtitlesHandlerDeps,
  title: string | null,
): Promise<ProviderResult> {
  if (provider === 'animetosho') {
    return deps
      .animetoshoProvider(anidbId, baseKey.episode, baseKey.lang, {
        timeoutMs: deps.config.providerTimeoutMs,
        title,
      })
      .catch((err) => { console.warn(`[AnimeTosho] ${(err as Error).message}`); return { found: false, transient: true } as ProviderResult; });
  }
  return Promise.resolve({ found: false });
}

async function tryDatabaseTier(
  baseKey: { anilistId: number; episode: number; lang: string },
  providersToTry: CacheProvider[],
  anidbId: number | null,
  deps: SubtitlesHandlerDeps,
  title: string | null,
): Promise<CacheProvider[]> {
  const hits: CacheProvider[] = [];

  await Promise.allSettled(providersToTry.map(async (provider) => {
    const key: CacheKey = { ...baseKey, provider };
    const existing = deps.cache.getInFlight(key);
    const job = existing ?? runProvider(provider, baseKey, anidbId, deps, title);
    if (!existing) deps.cache.setInFlight(key, job);

    try {
      const result = await job;
      if (result.found && result.vttContent) {
        deps.cache.setReady(key, result.vttContent);
        hits.push(provider);
        return;
      }
      if (provider === 'animetosho' && result.seriesNotFound) {
        if (anidbId !== null) deps.cache.setSeriesProviderMiss(provider, anidbId);
      }
      if (!result.transient) deps.cache.setNegative(key);
    } finally {
      if (!existing) deps.cache.clearInFlight(key);
    }
  }));

  return hits;
}

async function resolveOneLanguage(
  baseKey: { anilistId: number; episode: number; lang: string },
  anidbId: number | null,
  originalParsed: ParsedSubtitleRequestId,
  deps: SubtitlesHandlerDeps,
  mediaType: string | undefined,
  title: string | null,
): Promise<CacheProvider[]> {
  const tier1Providers: CacheProvider[] = ['animetosho'];
  const readyProviders: CacheProvider[] = [];
  const toTry: CacheProvider[] = [];

  for (const provider of tier1Providers) {
    const key: CacheKey = { ...baseKey, provider };
    const cached = deps.cache.get(key);
    if (cached?.status === 'ready') { readyProviders.push(provider); continue; }
    if (cached?.status === 'negative' && !deps.cache.isNegativeExpired(cached, deps.config.negativeCacheTtlHours)) continue;
    if (cached?.status === 'pending') continue; // in-flight elsewhere; skip, don't duplicate
    if (provider === 'animetosho') {
      const toshoMissed = anidbId !== null
        ? deps.cache.hasSeriesProviderMiss('animetosho', anidbId, deps.config.negativeCacheTtlHours)
        : !title;
      if (toshoMissed) continue;
    }
    toTry.push(provider);
  }

  const extractionKey: CacheKey = { ...baseKey, provider: 'extraction' };
  const extractionCached = deps.cache.get(extractionKey);
  const extractionInFlight = deps.cache.getInFlight(extractionKey);

  // 1. Fast Cache Path: If any Tier 1 provider is already ready, check if extraction is also ready
  if (readyProviders.length > 0) {
    if (toTry.length > 0) {
      const hits = await tryDatabaseTier(baseKey, toTry, anidbId, deps, title);
      readyProviders.push(...hits);
    }
    if (extractionCached?.status === 'ready') {
      readyProviders.push('extraction');
    }
    return readyProviders;
  }

  // Helper to start extraction job
  const triggerExtraction = (): void => {
    const streamUrlsPromise = getPlayableStreamUrls(
      deps.config.streamAddonUrl,
      originalParsed.contentId,
      originalParsed.season,
      originalParsed.episode,
      { timeoutMs: deps.config.providerTimeoutMs, mediaType },
    ).catch((err) => {
      if (err instanceof HttpTimeoutError) throw err;
      return [];
    });
    startExtractionInBackground(extractionKey, originalParsed, deps, mediaType, streamUrlsPromise);
  };

  const isExtractionNegative = extractionCached?.status === 'negative' &&
    !deps.cache.isNegativeExpired(extractionCached, deps.config.negativeCacheTtlHours);

  // 2. Concurrent Branch: If enabled, kick off extraction immediately alongside Tier 1
  if (deps.config.enableConcurrentExtraction) {
    let extractionOffered = false;
    if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight) {
      extractionOffered = true;
    } else if (!isExtractionNegative) {
      triggerExtraction();
      extractionOffered = true;
    }

    if (toTry.length > 0) {
      const hits = await tryDatabaseTier(baseKey, toTry, anidbId, deps, title);
      readyProviders.push(...hits);
    }

    if (extractionOffered) {
      readyProviders.push('extraction');
    }
    return readyProviders;
  }

  // 3. Sequential Fallback Path (ENABLE_CONCURRENT_EXTRACTION=false)
  if (toTry.length > 0) {
    const hits = await tryDatabaseTier(baseKey, toTry, anidbId, deps, title);
    readyProviders.push(...hits);
  }

  if (readyProviders.length > 0) {
    if (extractionCached?.status === 'ready') {
      readyProviders.push('extraction');
    }
    return readyProviders;
  }

  if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending' || extractionInFlight) return ['extraction'];
  if (isExtractionNegative) return [];

  triggerExtraction();
  return ['extraction'];
}

function startExtractionInBackground(
  extractionKey: CacheKey,
  originalParsed: ParsedSubtitleRequestId,
  deps: SubtitlesHandlerDeps,
  mediaType: string | undefined,
  streamUrls: Promise<string[]>,
): void {
  if (deps.cache.getInFlight(extractionKey)) return;

  console.log(`[Tier 2: Extraction] Starting background extraction for ${originalParsed.contentId} ep:${originalParsed.episode} (${extractionKey.lang})`);
  deps.cache.setPending(extractionKey);
  const job = deps.extractionProvider({
    streamAddonUrl: deps.config.streamAddonUrl,
    contentId: originalParsed.contentId,
    season: originalParsed.season,
    episode: originalParsed.episode,
    lang: extractionKey.lang,
    queue: deps.queue,
    extractionTimeoutMs: deps.config.extractionTimeoutMs,
    providerTimeoutMs: deps.config.providerTimeoutMs,
    probeTimeoutMs: deps.config.probeTimeoutMs,
    mediaType,
    streamUrls,
  })
    .then((result) => {
      if (result.found && result.vttContent) {
        try {
          deps.cache.setReady(extractionKey, result.vttContent);
          console.log(`[Tier 2: Extraction] SUCCESS for anilist:${extractionKey.anilistId} ep:${extractionKey.episode} (${extractionKey.lang})`);
        } catch (err) {
          console.warn(`[Tier 2: Extraction] Extraction succeeded but failed to persist: ${(err as Error).message}`);
        }
      } else {
        console.log(`[Tier 2: Extraction] NOT FOUND for ${originalParsed.contentId} ep:${originalParsed.episode}`);
        deps.cache.setNegative(extractionKey);
      }
      return result;
    })
    .catch((err) => {
      console.warn(`[Tier 2: Extraction] Error during extraction: ${(err as Error)?.message ?? err}`);
      if (!(err instanceof HttpTimeoutError)) {
        deps.cache.setNegative(extractionKey);
      } else {
        deps.cache.delete(extractionKey);
      }
      return { found: false } as ProviderResult;
    })
    .finally(() => deps.cache.clearInFlight(extractionKey));

  deps.cache.setInFlight(extractionKey, job);
}

export async function handleSubtitlesRequest(
  rawId: string,
  deps: SubtitlesHandlerDeps,
  mediaType?: string,
): Promise<{ subtitles: SubtitleCandidate[] }> {
  const parsed = parseSubtitleRequestId(rawId);
  const ids = resolveIds(parsed.contentId, deps.dataset.current, deps.episodeMapping, parsed.season, parsed.episode);
  if (ids.anilistId === null) {
    console.log(`[AnimeSubs] Content ID not resolvable in dataset: ${parsed.contentId}`);
    return { subtitles: [] };
  }
  const anilistId = ids.anilistId;
  const episode = resolveEffectiveEpisode(parsed, ids.anidbId, deps.episodeMapping);
  console.log(`[AnimeSubs] Resolving subtitles for ${rawId} -> anilist:${anilistId}${ids.anidbId ? `, anidb:${ids.anidbId}` : ''}`);

  const results = await Promise.all(
    deps.config.subtitleLanguages.map(async (lang) => {
      const baseKey = { anilistId, episode, lang };
      const hitProviders = await resolveOneLanguage(baseKey, ids.anidbId, parsed, deps, mediaType, ids.title ?? null);
      return hitProviders.map((provider): SubtitleCandidate => ({
        lang,
        provider,
        url: deps.buildSubtitleUrl({ ...baseKey, provider }),
      }));
    }),
  );
  return { subtitles: results.flat() };
}
