import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { decompressXz } from '../ffmpeg/xz.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import type { ProviderResult } from '../types.js';

interface ToshoSearchResult {
  id: number;
  title: string;
  status: string;
  num_files: number;
}

interface ToshoAttachment {
  id: number;
  type: string;
  info?: { codec?: string; lang?: string; tracknum?: number };
}

interface ToshoFile {
  filename: string;
  attachments?: ToshoAttachment[];
}

interface ToshoTorrentDetail {
  files: ToshoFile[] | null;
}

const EPISODE_PATTERNS = [
  /S\d{1,2}E(\d{1,4})/i,
  /-\s*(\d{1,4})\s*\(/,
  /-\s*(\d{1,4})\s*\[/,
  /-\s*(\d{1,4})(?:\.[a-z0-9]+)?\s*$/i,
];

function parseEpisodeNumber(title: string): number | null {
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
}

export async function findAnimeToshoSubtitle(
  anidbId: number,
  episode: number,
  lang: string,
  opts: AnimeToshoOptions = {},
): Promise<ProviderResult> {
  const feedBaseUrl = (opts.feedBaseUrl ?? 'https://feed.animetosho.org').replace(/\/+$/, '');
  const storageBaseUrl = (opts.storageBaseUrl ?? 'https://animetosho.org').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;

  const results = await fetchJson<ToshoSearchResult[]>(
    `${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`,
    { timeoutMs },
  );

  const candidates = results.filter(
    (r) => r.status === 'complete' && r.num_files === 1 && parseEpisodeNumber(r.title) === episode,
  );

  for (const candidate of candidates) {
    const detail = await fetchJson<ToshoTorrentDetail>(
      `${feedBaseUrl}/json?show=torrent&id=${candidate.id}`,
      { timeoutMs },
    );
    if (!detail.files) continue;

    for (const file of detail.files) {
      const attachment = file.attachments?.find(
        (a) => a.type === 'subtitle' && a.info?.lang === lang,
      );
      if (!attachment?.info?.codec || attachment.info.tracknum === undefined) continue;

      const url = buildAttachmentUrl(
        storageBaseUrl,
        attachment.id,
        file.filename,
        attachment.info.tracknum,
        lang,
        attachment.info.codec,
      );
      const compressed = await fetchBuffer(url, { timeoutMs });
      const decompressed = await decompressXz(compressed);
      const codecLower = attachment.info.codec.toLowerCase();
      const ext = codecLower === 'ass' || codecLower === 'ssa' ? 'ass' : 'srt';
      const vttContent = await convertToVtt(decompressed, ext);
      return { found: true, vttContent };
    }
  }

  return { found: false };
}
