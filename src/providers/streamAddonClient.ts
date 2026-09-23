import { fetchJson, HttpTimeoutError } from '../http/httpClient.js';

interface StremioStream {
  url?: string;
  infoHash?: string;
  name?: string;
  title?: string;
}

interface StreamResponse {
  streams?: StremioStream[];
}

const streamUrlCache = new Map<string, { urls: string[]; expiresAt: number }>();

export function clearStreamUrlCache(): void {
  streamUrlCache.clear();
}

export async function getPlayableStreamUrls(
  streamAddonManifestUrl: string,
  contentId: string,
  season: number,
  episode: number,
  opts: { timeoutMs?: number; maxCandidates?: number; mediaType?: string } = {},
): Promise<string[]> {
  const base = streamAddonManifestUrl.replace(/\/manifest\.json\/?$/, '').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxCandidates = opts.maxCandidates ?? 5;
  const cacheKey = `${base}:${contentId}:${season}:${episode}`;

  const cached = streamUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.urls.slice(0, maxCandidates);
  }

  const types = opts.mediaType === 'anime'
    ? ['anime', 'series']
    : ['series', 'anime'];

  const requestIds = contentId.startsWith('tt')
    ? [`${contentId}:${season}:${episode}`]
    : [`${contentId}:${episode}`, `${contentId}:${season}:${episode}`];

  const candidateUrls: string[] = [];
  for (const type of types) {
    for (const requestId of requestIds) {
      candidateUrls.push(`${base}/stream/${type}/${requestId}.json`);
    }
  }

  const queries = candidateUrls.map(async (url, idx) => {
    try {
      const response = await fetchJson<StreamResponse>(url, { timeoutMs });
      const streams = Array.isArray(response?.streams) ? response.streams : [];
      const playable = streams
        .filter((s): s is StremioStream & { url: string } => typeof s.url === 'string' && s.url.length > 0)
        .map((s) => s.url);
      return { idx, playable, error: null };
    } catch (err) {
      return { idx, playable: [], error: err };
    }
  });

  const results = await Promise.all(queries);
  results.sort((a, b) => a.idx - b.idx);

  for (const res of results) {
    if (res.playable.length > 0) {
      const candidates = res.playable.slice(0, 10);
      streamUrlCache.set(cacheKey, { urls: candidates, expiresAt: Date.now() + 5 * 60 * 1000 });
      return candidates.slice(0, maxCandidates);
    }
  }

  const timeoutErr = results.find((r) => r.error instanceof HttpTimeoutError);
  if (timeoutErr?.error) {
    throw timeoutErr.error;
  }

  return [];
}

export async function getBestStreamUrl(
  streamAddonManifestUrl: string,
  contentId: string,
  season: number,
  episode: number,
  opts: { timeoutMs?: number; mediaType?: string } = {},
): Promise<string | null> {
  const urls = await getPlayableStreamUrls(streamAddonManifestUrl, contentId, season, episode, opts);
  return urls[0] ?? null;
}
