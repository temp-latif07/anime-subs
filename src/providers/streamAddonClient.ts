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

export async function getPlayableStreamUrls(
  streamAddonManifestUrl: string,
  contentId: string,
  season: number,
  episode: number,
  opts: { timeoutMs?: number; maxCandidates?: number } = {},
): Promise<string[]> {
  const base = streamAddonManifestUrl.replace(/\/manifest\.json\/?$/, '').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxCandidates = opts.maxCandidates ?? 5;
  const requestIds = contentId.startsWith('tt')
    ? [`${contentId}:${season}:${episode}`]
    : [`${contentId}:${episode}`, `${contentId}:${season}:${episode}`];

  for (const requestId of requestIds) {
    for (const type of ['series', 'anime']) {
      try {
        const url = `${base}/stream/${type}/${requestId}.json`;
        const response = await fetchJson<StreamResponse>(url, { timeoutMs });
        const streams = Array.isArray(response?.streams) ? response.streams : [];
        const playable = streams
          .filter((s): s is StremioStream & { url: string } => typeof s.url === 'string' && s.url.length > 0)
          .map((s) => s.url);
        if (playable.length > 0) return playable.slice(0, maxCandidates);
      } catch (err) {
        if (err instanceof HttpTimeoutError) throw err;
        // try next endpoint variant
      }
    }
  }
  return [];
}

export async function getBestStreamUrl(
  streamAddonManifestUrl: string,
  contentId: string,
  season: number,
  episode: number,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const urls = await getPlayableStreamUrls(streamAddonManifestUrl, contentId, season, episode, opts);
  return urls[0] ?? null;
}
