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
  if (ids.anilistId === null) return { subtitles: [] };
  const anilistId = ids.anilistId;

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
  if (cached?.status === 'ready' || cached?.status === 'pending') return true;
  if (cached?.status === 'negative' && !deps.cache.isNegativeExpired(cached, deps.config.negativeCacheTtlHours)) {
    return false;
  }

  if (await tryFastTiers(key, anidbId, deps)) return true;

  startExtractionInBackground(key, parsed, deps);
  return true;
}

async function tryFastTiers(key: CacheKey, anidbId: number | null, deps: SubtitlesHandlerDeps): Promise<boolean> {
  const timeoutOpts = { timeoutMs: deps.config.providerTimeoutMs };
  try {
    const jimaku = await deps.jimakuProvider(key.anilistId, key.episode, key.lang, deps.config.jimakuApiKey, timeoutOpts);
    if (jimaku.found && jimaku.vttContent) {
      deps.cache.setReady(key, 1, jimaku.vttContent);
      return true;
    }
  } catch {
    // isolated failure -- fall through to the next tier
  }

  if (anidbId !== null) {
    try {
      const tosho = await deps.animetoshoProvider(anidbId, key.episode, key.lang, timeoutOpts);
      if (tosho.found && tosho.vttContent) {
        deps.cache.setReady(key, 2, tosho.vttContent);
        return true;
      }
    } catch {
      // isolated failure -- fall through to the next tier
    }
  }

  return false;
}

function startExtractionInBackground(
  key: CacheKey,
  parsed: { contentId: string; season: number; episode: number },
  deps: SubtitlesHandlerDeps,
): void {
  if (deps.cache.getInFlight(key)) return;

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
        deps.cache.setReady(key, 3, result.vttContent);
      } else {
        deps.cache.setNegative(key);
      }
      return result;
    })
    .catch(() => {
      deps.cache.setNegative(key);
      return { found: false } as ProviderResult;
    })
    .finally(() => deps.cache.clearInFlight(key));

  deps.cache.setInFlight(key, job);
}
