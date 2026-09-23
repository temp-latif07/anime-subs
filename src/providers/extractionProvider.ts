import { getPlayableStreamUrls } from './streamAddonClient.js';
import { findSubtitleStreamIndex } from '../ffmpeg/probe.js';
import { extractSubtitleToVtt } from '../ffmpeg/extract.js';
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
}

export async function runExtractionTier(params: ExtractionParams): Promise<ProviderResult> {
  const streamUrls = await getPlayableStreamUrls(
    params.streamAddonUrl,
    params.contentId,
    params.season,
    params.episode,
    { timeoutMs: params.providerTimeoutMs },
  );
  if (streamUrls.length === 0) return { found: false };

  return params.queue.run(async () => {
    for (const streamUrl of streamUrls) {
      try {
        const streamIndex = await findSubtitleStreamIndex(
          streamUrl,
          params.lang,
          params.extractionTimeoutMs,
        );
        if (streamIndex === null) continue;
        const vttContent = await extractSubtitleToVtt(
          streamUrl,
          streamIndex,
          params.extractionTimeoutMs,
        );
        return { found: true, vttContent };
      } catch (err) {
        console.warn(`[Tier 3: Extraction] Candidate stream failed: ${(err as Error).message}`);
      }
    }
    return { found: false };
  });
}
