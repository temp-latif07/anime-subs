import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import { isAcceptableSubtitle } from '../ffmpeg/vttUtils.js';
import type { ProviderResult } from '../types.js';

const OS_LANGUAGE_CODES: Record<string, string> = { eng: 'en' };

interface OpenSubtitlesSearchResponse {
  data: { attributes: { files: { file_id: number }[] } }[];
}

interface OpenSubtitlesDownloadResponse {
  link: string;
}

export interface OpenSubtitlesOptions {
  baseUrl?: string;
  timeoutMs?: number;
  hasQuota?: boolean;
}

export async function findOpenSubtitlesSubtitle(
  imdbId: string | null,
  tvdbSeason: number | null,
  tvdbEpisode: number | null,
  lang: string,
  apiKey: string,
  opts: OpenSubtitlesOptions = {},
): Promise<ProviderResult> {
  if (imdbId === null || tvdbSeason === null || tvdbEpisode === null) {
    return { found: false };
  }
  const osLang = OS_LANGUAGE_CODES[lang];
  if (!osLang) return { found: false };

  const baseUrl = (opts.baseUrl ?? 'https://api.opensubtitles.com/api/v1').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;
  const headers: Record<string, string> = {
    'Api-Key': apiKey,
    'User-Agent': 'anime-subs v1.0.0',
    'Content-Type': 'application/json',
  };

  // anime-lists' imdbid attribute is the series-level id, and the OpenSubtitles
  // API requires that as parent_imdb_id (paired with season/episode_number) --
  // imdb_id alone means the individual episode's own imdb id, which anime-lists
  // never provides.
  const numericImdbId = imdbId.replace(/^tt/, '');
  const searchUrl = `${baseUrl}/subtitles?parent_imdb_id=${numericImdbId}&season_number=${tvdbSeason}&episode_number=${tvdbEpisode}&languages=${osLang}`;
  const search = await fetchJson<OpenSubtitlesSearchResponse>(searchUrl, { headers, timeoutMs });

  const fileId = search.data[0]?.attributes.files[0]?.file_id;
  if (fileId === undefined) return { found: false };

  if (opts.hasQuota === false) return { found: false, quotaSkipped: true };

  const download = await fetchJson<OpenSubtitlesDownloadResponse>(`${baseUrl}/download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: fileId }),
    timeoutMs,
  });

  // The server has now spent one quota unit for this download, regardless of
  // whether the steps below succeed -- downloadAttempted must be reported
  // even if they fail, so the caller's local quota counter doesn't drift.
  try {
    const raw = await fetchBuffer(download.link, { timeoutMs });
    const vttContent = await convertToVtt(raw, 'srt', lang);
    if (!isAcceptableSubtitle(vttContent, lang)) return { found: false, downloadAttempted: true };
    return { found: true, vttContent, downloadAttempted: true };
  } catch (err) {
    console.warn(`[OpenSubtitles] Download succeeded but post-processing failed: ${(err as Error).message}`);
    return { found: false, downloadAttempted: true, transient: true };
  }
}
