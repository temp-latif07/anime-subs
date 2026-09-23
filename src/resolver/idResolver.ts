import type { ResolvedIds } from '../types.js';
import type { AnimeDataset } from './animeDataset.js';

export interface ParsedSubtitleRequestId {
  contentId: string;
  season: number;
  episode: number;
}

export function parseSubtitleRequestId(raw: string): ParsedSubtitleRequestId {
  const parts = raw.split(':');
  if (parts.length < 2) throw new Error(`Malformed subtitle request id: ${raw}`);

  if (parts.length === 3) {
    if (parts[0].startsWith('tt')) {
      const episode = parseInt(parts[2], 10);
      const season = parseInt(parts[1], 10);
      const contentId = parts[0];
      if (Number.isNaN(episode) || Number.isNaN(season)) {
        throw new Error(`Malformed subtitle request id: ${raw}`);
      }
      return { contentId, season, episode };
    } else {
      const contentId = `${parts[0]}:${parts[1]}`;
      const season = 1;
      const episode = parseInt(parts[2], 10);
      if (Number.isNaN(episode)) {
        throw new Error(`Malformed subtitle request id: ${raw}`);
      }
      return { contentId, season, episode };
    }
  }

  if (parts.length >= 4) {
    const episode = parseInt(parts.pop()!, 10);
    const season = parseInt(parts.pop()!, 10);
    const contentId = parts.join(':');
    if (Number.isNaN(episode) || Number.isNaN(season) || contentId === '') {
      throw new Error(`Malformed subtitle request id: ${raw}`);
    }
    return { contentId, season, episode };
  }

  throw new Error(`Malformed subtitle request id: ${raw}`);
}

export function resolveIds(contentId: string, dataset: AnimeDataset): ResolvedIds {
  const empty: ResolvedIds = { anilistId: null, anidbId: null };

  if (contentId.startsWith('tt')) {
    return empty; // no IMDb mapping in the dataset -- v1 scope limitation, see spec
  }

  const [scheme, valueStr] = contentId.split(':');
  const value = parseInt(valueStr, 10);
  if (Number.isNaN(value)) return empty;

  let row: ResolvedIds | null = null;
  if (scheme === 'anilist') row = dataset.findByAnilistId(value);
  else if (scheme === 'kitsu' || scheme === 'mal' || scheme === 'anidb') row = dataset.findByScheme(scheme, value);

  return row ?? empty;
}
