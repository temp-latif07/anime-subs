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
  type?: string;
  size?: number | null;
  url?: string;
  name?: string;
  language_code?: string;
  lang?: string;
  format?: string;
  codec?: string;
  forced?: number | boolean;
  default?: number | boolean;
  info?: {
    codec?: string;
    format?: string;
    lang?: string;
    language?: string;
    language_code?: string;
    tracknum?: number;
    forced?: number | boolean;
    default?: number | boolean;
    name?: string;
  };
}

export function isForcedOrSignsAttachment(info?: ToshoAttachment['info'] | ToshoAttachment): boolean {
  if (!info) return false;
  if (info.forced === 1 || info.forced === true) return true;
  const anyInfo = info as { name?: string; language?: string; title?: string };
  const text = `${anyInfo.name ?? ''} ${anyInfo.language ?? ''} ${anyInfo.title ?? ''}`.toLowerCase();
  return text.includes('forced') || text.includes('sign') || text.includes('song');
}

interface ToshoFile {
  filename?: string;
  name?: string;
  attachments?: ToshoAttachment[];
}

interface ToshoTorrentDetail {
  files?: ToshoFile[] | null;
  attachments?: ToshoAttachment[] | null;
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
  const feedBaseUrl = (opts.feedBaseUrl ?? 'https://feed.animetosho.xyz').replace(/\/+$/, '');
  const storageBaseUrl = (opts.storageBaseUrl ?? 'https://storage.animetosho.xyz').replace(/\/+$/, '');
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
      let detail: ToshoTorrentDetail | undefined;

      if (candidate.num_files === 1) {
        if (parseEpisodeNumber(candidate.title) !== episode) {
          continue;
        }
        detail = await fetchJson<ToshoTorrentDetail>(
          `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
          { timeoutMs },
        );
        targetFile = detail.files && detail.files.length > 0 ? detail.files[0] : undefined;
      } else if (candidate.num_files > 1) {
        detail = await fetchJson<ToshoTorrentDetail>(
          `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
          { timeoutMs },
        );
        if (!detail.files || detail.files.length === 0) continue;
        targetFile = detail.files.find((f) => {
          const fname = f.filename ?? f.name ?? '';
          return parseEpisodeNumber(fname) === episode;
        });
        if (!targetFile) continue;
      } else {
        continue;
      }

      const attachmentsList = targetFile?.attachments ?? detail?.attachments ?? [];
      const subtitleAttachments = attachmentsList.filter(
        (a) => {
          if (a.type && a.type !== 'subtitle') return false;
          const aLang = a.info?.lang ?? a.info?.language_code ?? a.language_code ?? a.lang;
          const aCodec = a.info?.codec ?? a.info?.format ?? a.format ?? a.codec;
          if (aLang !== lang || !aCodec) return false;
          if (!a.url && a.info?.tracknum === undefined) return false;
          if (isForcedOrSignsAttachment(a.info) || isForcedOrSignsAttachment(a)) return false;
          return true;
        },
      );

      subtitleAttachments.sort((a, b) => {
        const aDef = (a.info?.default === 1 || a.info?.default === true || a.default === 1 || a.default === true) ? 1 : 0;
        const bDef = (b.info?.default === 1 || b.info?.default === true || b.default === 1 || b.default === true) ? 1 : 0;
        if (aDef !== bDef) {
          return bDef - aDef;
        }
        return (b.size ?? 0) - (a.size ?? 0);
      });

      for (const attachment of subtitleAttachments) {
        const rawCodec = attachment.info?.codec ?? attachment.info?.format ?? attachment.format ?? attachment.codec ?? '';
        const codec = rawCodec.toLowerCase();
        let url = attachment.url;
        if (url && url.startsWith('/')) {
          url = `${storageBaseUrl}${url}`;
        } else if (!url) {
          const videoFilename = targetFile?.filename ?? targetFile?.name ?? candidate.title;
          url = buildAttachmentUrl(
            storageBaseUrl,
            attachment.id,
            videoFilename,
            attachment.info!.tracknum!,
            lang,
            codec,
          );
        }
        const compressed = await fetchBuffer(url, { timeoutMs });
        const decompressed = await decompressXz(compressed);
        const ext = codec === 'ass' || codec === 'ssa' ? 'ass' : 'srt';
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
