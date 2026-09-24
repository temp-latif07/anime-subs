export type CacheStatus = 'pending' | 'ready' | 'negative';

export interface CacheKey {
  anilistId: number;
  episode: number;
  lang: string;
}

export interface CacheEntry {
  status: CacheStatus;
  tier: 1 | 2 | 3 | null;
  filePath: string | null;
  updatedAt: number;
}

export interface ProviderResult {
  found: boolean;
  vttContent?: string;
  seriesNotFound?: boolean;
}

export interface SubtitleCandidate {
  lang: string;
  url: string;
}

export interface ResolvedIds {
  anilistId: number | null;
  anidbId: number | null;
  title?: string | null;
  imdbId?: string | null;
}
