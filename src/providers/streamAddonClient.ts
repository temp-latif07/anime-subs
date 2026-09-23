import { fetchJson } from '../http/httpClient.js';

interface StremioStream {
  url?: string;
  infoHash?: string;
  name?: string;
  title?: string;
}

interface StreamResponse {
  streams?: StremioStream[];
}

function buildStreamRequestUrl(manifestUrl: string, requestId: string): string {
  const base = manifestUrl.replace(/\/manifest\.json\/?$/, '').replace(/\/+$/, '');
  return `${base}/stream/series/${requestId}.json`;
}

export async function getBestStreamUrl(
  streamAddonManifestUrl: string,
  contentId: string,
  season: number,
  episode: number,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const requestId = `${contentId}:${season}:${episode}`;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const response = await fetchJson<StreamResponse>(
    buildStreamRequestUrl(streamAddonManifestUrl, requestId),
    { timeoutMs },
  );
  const streams = Array.isArray(response?.streams) ? response.streams : [];
  const playable = streams.find((s) => typeof s.url === 'string' && s.url.length > 0);
  return playable?.url ?? null;
}
