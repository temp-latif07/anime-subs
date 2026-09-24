import { getPlayableStreamUrls } from './streamAddonClient.js';
import { findSubtitleStream } from '../ffmpeg/probe.js';
import { extractSubtitleToVtt } from '../ffmpeg/extract.js';
import { isAcceptableSubtitle } from '../ffmpeg/vttUtils.js';
import type { ExtractionQueue } from '../queue/extractionQueue.js';
import type { ProviderResult } from '../types.js';

export interface ExtractionParams {
  streamAddonUrl: string;
  contentId: string;
  season: number;
  episode: number;
  lang: string;
  queue: ExtractionQueue;
  extractionTimeoutMs: number;
  providerTimeoutMs: number;
  mediaType?: string;
  streamUrls?: Promise<string[]> | string[];
}

export async function runExtractionTier(params: ExtractionParams): Promise<ProviderResult> {
  const streamUrls = params.streamUrls
    ? (Array.isArray(params.streamUrls) ? params.streamUrls : await params.streamUrls)
    : await getPlayableStreamUrls(
        params.streamAddonUrl,
        params.contentId,
        params.season,
        params.episode,
        { timeoutMs: params.providerTimeoutMs, mediaType: params.mediaType },
      );
  if (streamUrls.length === 0) return { found: false };

  return params.queue.run(async () => {
    for (const streamUrl of streamUrls) {
      try {
        const stream = await findSubtitleStream(
          streamUrl,
          params.lang,
          params.extractionTimeoutMs,
        );
        if (stream === null) continue;
        const vttContent = await extractSubtitleToVtt(
          streamUrl,
          stream.index,
          params.lang,
          stream.codec,
          params.extractionTimeoutMs,
        );
        if (!isAcceptableSubtitle(vttContent, params.lang)) continue;
        return { found: true, vttContent };
      } catch (err) {
        console.warn(`[Tier 3: Extraction] Candidate stream failed: ${(err as Error).message}`);
      }
    }
    return { found: false };
  });
}
