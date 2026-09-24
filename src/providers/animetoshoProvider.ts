import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { decompressXz } from '../ffmpeg/xz.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import { isAcceptableSubtitle } from '../ffmpeg/vttUtils.js';
import type { ProviderResult } from '../types.js';

interface ToshoSearchResult {
  id: number;
  title: string;
  status: string;
  num_files: number;
}

export interface ToshoAttachment {
  id: number;
  type: string;
  size?: number;
  info?: {
    codec?: string;
    lang?: string;
    tracknum?: number;
    forced?: number;
    default?: number;
    name?: string;
  };
}

export function isForcedOrSignsAttachment(info?: ToshoAttachment['info']): boolean {
  if (!info) return false;
  if (info.forced === 1) return true;
  const name = (info.name ?? '').toLowerCase();
  return name.includes('forced') || name.includes('sign') || name.includes('song');
}

interface ToshoFile {
  filename: string;
  attachments?: ToshoAttachment[];
}

interface ToshoTorrentDetail {
  files: ToshoFile[] | null;
}

export const EPISODE_PATTERNS = [
  /S\d{1,2}E(\d{1,4})/i,
  /-\s*(\d{1,4})\s*\(/,
  /-\s*(\d{1,4})\s*\[/,
  /\s+(\d{1,4})\s*\[/i,
  /\b(?:ep|episode)\s*(\d{1,4})\b/i,
  /-\s*(\d{1,4})v\d\b/i,
  /-\s*(\d{1,4})(?:\.[a-z0-9]+)?\s*$/i,
];

export function parseEpisodeNumber(title: string): number | null {
  for (const pattern of EPISODE_PATTERNS) {
    const match = title.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

function buildAttachmentUrl(
  storageBaseUrl: string,
  attachmentId: number,
  videoFilename: string,
  tracknum: number,
  lang: string,
  codec: string,
): string {
  const id8 = attachmentId.toString(16).padStart(8, '0');
  const stem = videoFilename.replace(/\.[^.]+$/, '');
  const name = `${stem}_track${tracknum}.${lang}.${codec.toLowerCase()}.xz`;
  const base = storageBaseUrl.replace(/\/+$/, '');
  return `${base}/storage/attach/${id8}/${encodeURIComponent(name)}`;
}

export interface AnimeToshoOptions {
  feedBaseUrl?: string;
  storageBaseUrl?: string;
  timeoutMs?: number;
  title?: string | null;
}

export async function findAnimeToshoSubtitle(
  anidbId: number | null,
  episode: number,
  lang: string,
  opts: AnimeToshoOptions = {},
): Promise<ProviderResult> {
  const feedBaseUrl = (opts.feedBaseUrl ?? 'https://feed.animetosho.org').replace(/\/+$/, '');
  const storageBaseUrl = (opts.storageBaseUrl ?? 'https://animetosho.org').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;

  let results: ToshoSearchResult[] = [];
  let anidbSeriesUnindexed = false;

  if (anidbId !== null) {
    results = await fetchJson<ToshoSearchResult[]>(
      `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${episode}&limit=50`,
      { timeoutMs },
    );
    if (results.length === 0) {
      // Broader, unfiltered search: catches batch releases whose title
      // doesn't literally contain the bare episode number, which the
      // q= server-side text filter can otherwise exclude.
      results = await fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`,
        { timeoutMs },
      );
    }
  }

  if (results.length === 0 && opts.title) {
    const cleanTitle = opts.title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanTitle) {
      results = await fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&q=${encodeURIComponent(`${cleanTitle} ${episode}`)}&limit=50`,
        { timeoutMs },
      );
      anidbSeriesUnindexed = anidbId === null && results.length === 0;
    }
  } else if (results.length === 0 && anidbId === null) {
    anidbSeriesUnindexed = true;
  }

  if (results.length === 0) {
    return { found: false, seriesNotFound: anidbSeriesUnindexed };
  }

  const candidates = results.filter((r) => r.status === 'complete');

  for (const candidate of candidates) {
    try {
      let targetFile: ToshoFile | undefined;

      if (candidate.num_files === 1) {
        if (parseEpisodeNumber(candidate.title) !== episode) {
          continue;
        }
        const detail = await fetchJson<ToshoTorrentDetail>(
          `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
          { timeoutMs },
        );
        if (!detail.files || detail.files.length === 0) continue;
        targetFile = detail.files[0];
      } else if (candidate.num_files > 1) {
        const detail = await fetchJson<ToshoTorrentDetail>(
          `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
          { timeoutMs },
        );
        if (!detail.files || detail.files.length === 0) continue;
        targetFile = detail.files.find((f) => parseEpisodeNumber(f.filename) === episode);
        if (!targetFile) continue;
      } else {
        continue;
      }

      const subtitleAttachments = (targetFile.attachments ?? []).filter(
        (a) =>
          a.type === 'subtitle' &&
          a.info?.lang === lang &&
          a.info?.codec &&
          a.info.tracknum !== undefined &&
          !isForcedOrSignsAttachment(a.info),
      );

      subtitleAttachments.sort((a, b) => {
        const aDef = a.info?.default === 1 ? 1 : 0;
        const bDef = b.info?.default === 1 ? 1 : 0;
        if (aDef !== bDef) {
          return bDef - aDef;
        }
        return (b.size ?? 0) - (a.size ?? 0);
      });

      for (const attachment of subtitleAttachments) {
        const url = buildAttachmentUrl(
          storageBaseUrl,
          attachment.id,
          targetFile.filename,
          attachment.info!.tracknum!,
          lang,
          attachment.info!.codec!,
        );
        const compressed = await fetchBuffer(url, { timeoutMs });
        const decompressed = await decompressXz(compressed);
        const codecLower = attachment.info!.codec!.toLowerCase();
        const ext = codecLower === 'ass' || codecLower === 'ssa' ? 'ass' : 'srt';
        const vttContent = await convertToVtt(decompressed, ext, lang);
        if (!isAcceptableSubtitle(vttContent, lang)) {
          continue;
        }
        return { found: true, vttContent };
      }
    } catch (err) {
      console.warn(`[AnimeTosho] Candidate ${candidate.id} failed: ${(err as Error).message}`);
      continue;
    }
  }

  return { found: false };
}
