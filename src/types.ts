export type CacheStatus = 'pending' | 'ready' | 'negative';
export type CacheProvider = 'jimaku' | 'animetosho' | 'opensubtitles' | 'extraction';

export interface CacheKey {
  anilistId: number;
  episode: number;
  lang: string;
  provider: CacheProvider;
}

export interface CacheEntry {
  status: CacheStatus;
  provider: CacheProvider | null;
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
