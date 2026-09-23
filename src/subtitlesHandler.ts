import { parseSubtitleRequestId, resolveIds } from './resolver/idResolver.js';
import type { AnimeDataset } from './resolver/animeDataset.js';
import type { CacheStore } from './cache/cacheStore.js';
import type { ExtractionQueue } from './queue/extractionQueue.js';
import type { Config } from './config.js';
import type { CacheKey, ProviderResult, SubtitleCandidate } from './types.js';
import type { ExtractionParams } from './providers/extractionProvider.js';

export interface DatasetHolder {
  current: AnimeDataset;
}

export interface SubtitlesHandlerDeps {
  dataset: DatasetHolder;
  cache: CacheStore;
  queue: ExtractionQueue;
  config: Config;
  buildSubtitleUrl: (key: CacheKey) => string;
  jimakuProvider: (anilistId: number, episode: number, lang: string, apiKey: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>;
  animetoshoProvider: (anidbId: number, episode: number, lang: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>;
  extractionProvider: (params: ExtractionParams) => Promise<ProviderResult>;
}

export async function handleSubtitlesRequest(
  rawId: string,
  deps: SubtitlesHandlerDeps,
): Promise<{ subtitles: SubtitleCandidate[] }> {
  const parsed = parseSubtitleRequestId(rawId);
  const ids = resolveIds(parsed.contentId, deps.dataset.current);
  if (ids.anilistId === null) {
    console.log(`[AnimeSubs] Content ID not resolvable in dataset: ${parsed.contentId}`);
    return { subtitles: [] };
  }
  const anilistId = ids.anilistId;
  console.log(`[AnimeSubs] Resolving subtitles for ${rawId} -> anilist:${anilistId}${ids.anidbId ? `, anidb:${ids.anidbId}` : ''}`);

  const results = await Promise.all(
    deps.config.subtitleLanguages.map(async (lang) => {
      const key: CacheKey = { anilistId, episode: parsed.episode, lang };
      const included = await resolveOneLanguage(key, ids.anidbId, parsed, deps);
      return included ? { lang, url: deps.buildSubtitleUrl(key) } : null;
    }),
  );
  const subtitles = results.filter((s): s is SubtitleCandidate => s !== null);
  return { subtitles };
}

async function resolveOneLanguage(
  key: CacheKey,
  anidbId: number | null,
  parsed: { contentId: string; season: number; episode: number },
  deps: SubtitlesHandlerDeps,
): Promise<boolean> {
  const cached = deps.cache.get(key);
  if (cached?.status === 'ready') {
    console.log(`[Cache] HIT (ready) for anilist:${key.anilistId} ep:${key.episode} (${key.lang})`);
    return true;
  }
  if (cached?.status === 'pending') {
    console.log(`[Cache] HIT (pending extraction) for anilist:${key.anilistId} ep:${key.episode} (${key.lang})`);
    return true;
  }
  if (cached?.status === 'negative' && !deps.cache.isNegativeExpired(cached, deps.config.negativeCacheTtlHours)) {
    console.log(`[Cache] HIT (negative TTL active) for anilist:${key.anilistId} ep:${key.episode} (${key.lang})`);
    return false;
  }

  if (await tryFastTiers(key, anidbId, deps)) return true;

  startExtractionInBackground(key, parsed, deps);
  return true;
}

async function tryFastTiers(key: CacheKey, anidbId: number | null, deps: SubtitlesHandlerDeps): Promise<boolean> {
  const timeoutOpts = { timeoutMs: deps.config.providerTimeoutMs };

  const jimakuPromise = deps
    .jimakuProvider(key.anilistId, key.episode, key.lang, deps.config.jimakuApiKey, timeoutOpts)
    .catch((err) => {
      console.warn(`[Tier 1: Jimaku] Warning: ${(err as Error).message}`);
      return { found: false } as ProviderResult;
    });

  const toshoPromise = anidbId !== null
    ? deps
        .animetoshoProvider(anidbId, key.episode, key.lang, timeoutOpts)
        .catch((err) => {
          console.warn(`[Tier 2: AnimeTosho] Warning: ${(err as Error).message}`);
          return { found: false } as ProviderResult;
        })
    : Promise.resolve({ found: false } as ProviderResult);

  const [jimaku, tosho] = await Promise.all([jimakuPromise, toshoPromise]);

  if (jimaku.found && jimaku.vttContent) {
    console.log(`[Tier 1: Jimaku] HIT for anilist:${key.anilistId} ep:${key.episode} (${key.lang})`);
    deps.cache.setReady(key, 1, jimaku.vttContent);
    return true;
  }

  if (tosho.found && tosho.vttContent) {
    console.log(`[Tier 2: AnimeTosho] HIT for anidb:${anidbId} ep:${key.episode} (${key.lang})`);
    deps.cache.setReady(key, 2, tosho.vttContent);
    return true;
  }

  return false;
}

function startExtractionInBackground(
  key: CacheKey,
  parsed: { contentId: string; season: number; episode: number },
  deps: SubtitlesHandlerDeps,
): void {
  if (deps.cache.getInFlight(key)) return;

  console.log(`[Tier 3: Extraction] Starting background extraction for ${parsed.contentId} ep:${parsed.episode} (${key.lang})`);
  deps.cache.setPending(key);
  const job = deps.extractionProvider({
    streamAddonUrl: deps.config.streamAddonUrl,
    contentId: parsed.contentId,
    season: parsed.season,
    episode: parsed.episode,
    lang: key.lang,
    queue: deps.queue,
    extractionTimeoutMs: deps.config.extractionTimeoutMs,
    providerTimeoutMs: deps.config.providerTimeoutMs,
  })
    .then((result) => {
      if (result.found && result.vttContent) {
        console.log(`[Tier 3: Extraction] SUCCESS: extracted subtitles ready for anilist:${key.anilistId} ep:${key.episode} (${key.lang})`);
        deps.cache.setReady(key, 3, result.vttContent);
      } else {
        console.log(`[Tier 3: Extraction] NOT FOUND: no matching subtitle stream for ${parsed.contentId} ep:${parsed.episode}`);
        deps.cache.setNegative(key);
      }
      return result;
    })
    .catch((err) => {
      console.warn(`[Tier 3: Extraction] Error during extraction: ${(err as Error)?.message ?? err}`);
      deps.cache.setNegative(key);
      return { found: false } as ProviderResult;
    })
    .finally(() => deps.cache.clearInFlight(key));

  deps.cache.setInFlight(key, job);
}
