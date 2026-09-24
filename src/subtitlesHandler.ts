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
  jimakuProvider: (anilistId: number, episode: number, lang: string, apiKey: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>;
  animetoshoProvider: (anidbId: number | null, episode: number, lang: string, opts?: { timeoutMs?: number; title?: string | null }) => Promise<ProviderResult>;
  opensubtitlesProvider: (imdbId: string | null, tvdbSeason: number | null, tvdbEpisode: number | null, lang: string, apiKey: string, opts?: { timeoutMs?: number; hasQuota?: boolean }) => Promise<ProviderResult>;
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
  imdbId: string | null,
  deps: SubtitlesHandlerDeps,
  title: string | null,
): Promise<ProviderResult> {
  if (provider === 'jimaku') {
    return deps
      .jimakuProvider(baseKey.anilistId, baseKey.episode, baseKey.lang, deps.config.jimakuApiKey, { timeoutMs: deps.config.providerTimeoutMs })
      .catch((err) => { console.warn(`[Jimaku] ${(err as Error).message}`); return { found: false } as ProviderResult; });
  }
  if (provider === 'animetosho') {
    return deps
      .animetoshoProvider(anidbId, baseKey.episode, baseKey.lang, { timeoutMs: deps.config.providerTimeoutMs, title })
      .catch((err) => { console.warn(`[AnimeTosho] ${(err as Error).message}`); return { found: false } as ProviderResult; });
  }
  const tvdb = anidbId !== null ? deps.episodeMapping.mapAnidbToTvdbEpisode(anidbId, baseKey.episode) : null;
  const hasQuota = deps.cache.getRemainingQuota('opensubtitles', deps.config.openSubtitlesDailyQuota) > 0;
  return deps
    .opensubtitlesProvider(imdbId, tvdb?.season ?? null, tvdb?.episode ?? null, baseKey.lang, deps.config.openSubtitlesApiKey, { timeoutMs: deps.config.providerTimeoutMs, hasQuota })
    .catch((err) => { console.warn(`[OpenSubtitles] ${(err as Error).message}`); return { found: false } as ProviderResult; });
}

async function tryDatabaseTier(
  baseKey: { anilistId: number; episode: number; lang: string },
  providersToTry: CacheProvider[],
  anidbId: number | null,
  imdbId: string | null,
  deps: SubtitlesHandlerDeps,
  title: string | null,
): Promise<CacheProvider[]> {
  const hits: CacheProvider[] = [];

  await Promise.allSettled(providersToTry.map(async (provider) => {
    const key: CacheKey = { ...baseKey, provider };
    const existing = deps.cache.getInFlight(key);
    const job = existing ?? runProvider(provider, baseKey, anidbId, imdbId, deps, title);
    if (!existing) deps.cache.setInFlight(key, job);

    try {
      const result = await job;
      if (result.found && result.vttContent) {
        deps.cache.setReady(key, result.vttContent);
        if (!existing && provider === 'opensubtitles') deps.cache.recordDownloadUsed('opensubtitles');
        hits.push(provider);
        return;
      }
      if ((provider === 'jimaku' || provider === 'animetosho') && result.seriesNotFound) {
        const seriesId = provider === 'jimaku' ? baseKey.anilistId : anidbId;
        if (seriesId !== null) deps.cache.setSeriesProviderMiss(provider, seriesId);
      }
      if (!result.quotaSkipped) deps.cache.setNegative(key);
    } finally {
      if (!existing) deps.cache.clearInFlight(key);
    }
  }));

  return hits;
}

async function resolveOneLanguage(
  baseKey: { anilistId: number; episode: number; lang: string },
  anidbId: number | null,
  imdbId: string | null,
  parsed: ParsedSubtitleRequestId & { episode: number },
  deps: SubtitlesHandlerDeps,
  mediaType: string | undefined,
  title: string | null,
): Promise<CacheProvider[]> {
  const tier1Providers: CacheProvider[] = ['jimaku', 'animetosho', 'opensubtitles'];
  const readyProviders: CacheProvider[] = [];
  const toTry: CacheProvider[] = [];

  for (const provider of tier1Providers) {
    const key: CacheKey = { ...baseKey, provider };
    const cached = deps.cache.get(key);
    if (cached?.status === 'ready') { readyProviders.push(provider); continue; }
    if (cached?.status === 'negative' && !deps.cache.isNegativeExpired(cached, deps.config.negativeCacheTtlHours)) continue;
    if (cached?.status === 'pending') continue; // in-flight elsewhere; skip, don't duplicate
    if (provider === 'jimaku' && deps.cache.hasSeriesProviderMiss('jimaku', baseKey.anilistId, deps.config.negativeCacheTtlHours)) continue;
    if (provider === 'animetosho') {
      const toshoMissed = anidbId !== null
        ? deps.cache.hasSeriesProviderMiss('animetosho', anidbId, deps.config.negativeCacheTtlHours)
        : !title;
      if (toshoMissed) continue;
    }
    toTry.push(provider);
  }

  if (toTry.length > 0) {
    const hits = await tryDatabaseTier(baseKey, toTry, anidbId, imdbId, deps, title);
    readyProviders.push(...hits);
  }

  if (readyProviders.length > 0) return readyProviders;

  const extractionKey: CacheKey = { ...baseKey, provider: 'extraction' };
  const extractionCached = deps.cache.get(extractionKey);
  if (extractionCached?.status === 'ready' || extractionCached?.status === 'pending') return ['extraction'];
  if (extractionCached?.status === 'negative' && !deps.cache.isNegativeExpired(extractionCached, deps.config.negativeCacheTtlHours)) return [];

  const streamUrlsPromise = getPlayableStreamUrls(
    deps.config.streamAddonUrl,
    parsed.contentId,
    parsed.season,
    parsed.episode,
    { timeoutMs: deps.config.providerTimeoutMs, mediaType },
  ).catch((err) => {
    if (err instanceof HttpTimeoutError) throw err;
    return [];
  });

  startExtractionInBackground(extractionKey, parsed, deps, mediaType, streamUrlsPromise);
  return ['extraction'];
}

function startExtractionInBackground(
  extractionKey: CacheKey,
  parsed: ParsedSubtitleRequestId & { episode: number },
  deps: SubtitlesHandlerDeps,
  mediaType: string | undefined,
  streamUrls: Promise<string[]>,
): void {
  if (deps.cache.getInFlight(extractionKey)) return;

  console.log(`[Tier 2: Extraction] Starting background extraction for ${parsed.contentId} ep:${parsed.episode} (${extractionKey.lang})`);
  deps.cache.setPending(extractionKey);
  const job = deps.extractionProvider({
    streamAddonUrl: deps.config.streamAddonUrl,
    contentId: parsed.contentId,
    season: parsed.season,
    episode: parsed.episode,
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
        console.log(`[Tier 2: Extraction] NOT FOUND for ${parsed.contentId} ep:${parsed.episode}`);
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
  const effectiveParsed = { ...parsed, episode };
  console.log(`[AnimeSubs] Resolving subtitles for ${rawId} -> anilist:${anilistId}${ids.anidbId ? `, anidb:${ids.anidbId}` : ''}`);

  const results = await Promise.all(
    deps.config.subtitleLanguages.map(async (lang) => {
      const baseKey = { anilistId, episode, lang };
      const hitProviders = await resolveOneLanguage(baseKey, ids.anidbId, ids.imdbId ?? null, effectiveParsed, deps, mediaType, ids.title ?? null);
      return hitProviders.map((provider): SubtitleCandidate => ({
        lang,
        provider,
        url: deps.buildSubtitleUrl({ ...baseKey, provider }),
      }));
    }),
  );
  return { subtitles: results.flat() };
}
