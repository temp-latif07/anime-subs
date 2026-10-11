import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { decompressXz } from '../ffmpeg/xz.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import { isAcceptableSubtitle } from '../ffmpeg/vttUtils.js';
import type { ProviderResult } from '../types.js';
import type { ReleaseHint } from '../releaseHint.js';

interface ToshoSearchResult {
  id: number;
  title: string;
  status: string;
  num_files: number;
  total_size?: number;
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

// Mini anime, PVs, trailers and creditless OP/ED releases share the series
// anidb id and have their own "episode N", so they can be mistaken for the
// real episode. PV/CM only count when they look like a release tag (after a
// dash or opening bracket, or followed by a number), so series names that
// merely contain those words are kept.
export function isNonEpisodeRelease(title: string): boolean {
  return /mini[\s-]?anime|\bNC(?:OP|ED)\d*\b|creditless|\btrailer\b|[-\u2013[(]\s*(?:PV|CM)\b|\bPV\s*\d+\b/i.test(title);
}

const EXTRAS_DIR = /(?:^|[\\/])(?:extras?|specials?|bonus|nc(?:op|ed)s?|creditless)[\\/]/i;

interface ToshoFile {
  filename?: string;
  name?: string;
  size?: number | null;
  crc32?: string | null;
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

// "01 ~ 24", "01-24", "(01-12)": a batch, not a single episode.
function hasEpisodeRange(title: string): boolean {
  for (const m of title.matchAll(/\b(\d{1,4})\s*~\s*(\d{1,4})\b|\b(\d{1,4})-(\d{1,4})\b/g)) {
    const from = parseInt(m[1] ?? m[3], 10);
    const to = parseInt(m[2] ?? m[4], 10);
    if (to > from) return true;
  }
  return false;
}

const NON_EPISODE_NUMBERS = new Set([480, 576, 720, 1080, 2160]);

function isResolutionOrYear(n: number): boolean {
  return NON_EPISODE_NUMBERS.has(n) || (n >= 1900 && n <= 2099);
}

export function parseEpisodeNumber(title: string): number | null {
  if (hasEpisodeRange(title)) return null;
  for (const pattern of EPISODE_PATTERNS) {
    const match = title.match(pattern);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (isResolutionOrYear(n)) continue;
    return n;
  }
  return null;
}

// Files much smaller than the one being played are shorts or previews, not
// the same episode. The floor is loose so lower-quality encodes still pass.
const MIN_SIZE_RATIO = 0.05;

export function isPlausibleSize(size: number | null | undefined, playingSize: number | undefined): boolean {
  if (!size || !playingSize) return true;
  return size >= playingSize * MIN_SIZE_RATIO;
}

export function parseReleaseGroup(name: string): string | null {
  const m = name.match(/^\s*(?:.*[\\/])?\[([^\]]+)\]/);
  return m ? m[1].toLowerCase() : null;
}

export function parseCrc(name: string): string | null {
  const m = name.match(/\[([0-9A-Fa-f]{8})\]/);
  return m ? m[1].toUpperCase() : null;
}

export function findEpisodeFile(files: ToshoFile[], episode: number, release?: ReleaseHint): ToshoFile | undefined {
  const matches = files.filter((f) => {
    const fname = f.filename ?? f.name ?? '';
    if (isNonEpisodeRelease(fname) || EXTRAS_DIR.test(fname)) return false;
    if (!isPlausibleSize(f.size, release?.size)) return false;
    return parseEpisodeNumber(fname) === episode;
  });
  const playingCrc = release?.filename ? parseCrc(release.filename) : null;
  const exact = matches.find((f) => {
    const fname = f.filename ?? f.name ?? '';
    return (playingCrc !== null && (f.crc32?.toUpperCase() === playingCrc || parseCrc(fname) === playingCrc))
      || (!!release?.size && f.size === release.size);
  });
  return exact ?? matches[0];
}

// Drops candidates that cannot be the playing file and moves releases from the
// same group first. Array.sort is stable, so the API order is kept otherwise.
export function rankCandidates(candidates: ToshoSearchResult[], release?: ReleaseHint): ToshoSearchResult[] {
  if (!release) return candidates;
  const group = release.filename ? parseReleaseGroup(release.filename) : null;
  const plausible = candidates.filter((c) => c.num_files !== 1 || isPlausibleSize(c.total_size, release.size));
  const score = (c: ToshoSearchResult) => (group && parseReleaseGroup(c.title) === group ? 1 : 0);
  return [...plausible].sort((a, b) => score(b) - score(a));
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
  release?: ReleaseHint;
}

async function resolveSubtitleFromCandidates(
  candidates: ToshoSearchResult[],
  episode: number,
  lang: string,
  feedBaseUrl: string,
  storageBaseUrl: string,
  timeoutMs: number,
  release?: ReleaseHint,
  maxDetailFetches: number = 5,
): Promise<ProviderResult | null> {
  const completeCandidates = rankCandidates(
    candidates.filter((r) => r.status === 'complete' && !isNonEpisodeRelease(r.title)),
    release,
  );
  let detailFetches = 0;

  for (const candidate of completeCandidates) {
    if (detailFetches >= maxDetailFetches) {
      break;
    }

    try {
      let targetFile: ToshoFile | undefined;
      let detail: ToshoTorrentDetail | undefined;

      if (candidate.num_files === 1) {
        if (parseEpisodeNumber(candidate.title) !== episode) {
          continue;
        }
        detailFetches++;
        detail = await fetchJson<ToshoTorrentDetail>(
          `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
          { timeoutMs },
        );
        targetFile = detail.files && detail.files.length > 0 ? detail.files[0] : undefined;
      } else if (candidate.num_files > 1) {
        detailFetches++;
        detail = await fetchJson<ToshoTorrentDetail>(
          `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
          { timeoutMs },
        );
        if (!detail.files || detail.files.length === 0) continue;
        targetFile = findEpisodeFile(detail.files, episode, release);
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

  return null;
}

export async function findAnimeToshoSubtitle(
  anidbId: number | null,
  episode: number,
  lang: string,
  opts: AnimeToshoOptions = {},
): Promise<ProviderResult> {
  const feedBaseUrl = (opts.feedBaseUrl ?? 'https://feed.animetosho.net').replace(/\/+$/, '');
  const storageBaseUrl = (opts.storageBaseUrl ?? 'https://storage.animetosho.net').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 3500;

  const paddedEp = String(episode).padStart(2, '0');
  const epQueries = paddedEp !== String(episode) ? [paddedEp, String(episode)] : [String(episode)];

  if (anidbId !== null) {
    const searchPromises = epQueries.map((q) =>
      fetchJson<ToshoSearchResult[]>(
        `${feedBaseUrl}/json?t=search&aid=${anidbId}&q=${q}&limit=50`,
        { timeoutMs },
      ),
    );
    const searchSettled = await Promise.allSettled(searchPromises);
    const fulfilledSearch = searchSettled.filter(
      (r): r is PromiseFulfilledResult<ToshoSearchResult[]> => r.status === 'fulfilled',
    );
    if (fulfilledSearch.length === 0) {
      const firstRejected = searchSettled.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      throw firstRejected?.reason ?? new Error('AnimeTosho search failed');
    }

    const candidateMap = new Map<number, ToshoSearchResult>();
    for (const res of fulfilledSearch) {
      for (const item of res.value) {
        candidateMap.set(item.id, item);
      }
    }
    const candidates = Array.from(candidateMap.values());
    if (candidates.length > 0) {
      const match = await resolveSubtitleFromCandidates(candidates, episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs, opts.release);
      if (match) return match;
    }

    // Broader, unfiltered search: catches batch releases whose title
    // doesn't literally contain the bare episode number, which the
    // q= server-side text filter can otherwise exclude.
    const broadResults = await fetchJson<ToshoSearchResult[]>(
      `${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`,
      { timeoutMs },
    );
    if (broadResults.length > 0) {
      const match = await resolveSubtitleFromCandidates(broadResults, episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs, opts.release);
      if (match) return match;
    }
  }

  let titleResultsSeen = 0;
  if (opts.title) {
    const cleanTitle = opts.title.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanTitle) {
      const titlePromises = epQueries.map((q) =>
        fetchJson<ToshoSearchResult[]>(
          `${feedBaseUrl}/json?t=search&q=${encodeURIComponent(`${cleanTitle} ${q}`)}&limit=50`,
          { timeoutMs },
        ),
      );
      const titleSettled = await Promise.allSettled(titlePromises);
      const fulfilledTitle = titleSettled.filter(
        (r): r is PromiseFulfilledResult<ToshoSearchResult[]> => r.status === 'fulfilled',
      );
      if (fulfilledTitle.length === 0) {
        const firstRejected = titleSettled.find(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        throw firstRejected?.reason ?? new Error('AnimeTosho title search failed');
      }

      const titleCandidateMap = new Map<number, ToshoSearchResult>();
      for (const res of fulfilledTitle) {
        titleResultsSeen += res.value.length;
        for (const item of res.value) {
          titleCandidateMap.set(item.id, item);
        }
      }
      const titleCandidates = Array.from(titleCandidateMap.values());
      if (titleCandidates.length > 0) {
        const match = await resolveSubtitleFromCandidates(titleCandidates, episode, lang, feedBaseUrl, storageBaseUrl, timeoutMs, opts.release);
        if (match) return match;
      }
    }
  }

  const seriesNotFound = anidbId === null && titleResultsSeen === 0;
  return { found: false, seriesNotFound };
}
