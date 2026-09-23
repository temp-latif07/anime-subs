import { getBestStreamUrl } from './streamAddonClient.js';
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
  const streamUrl = await getBestStreamUrl(
    params.streamAddonUrl,
    params.contentId,
    params.season,
    params.episode,
    { timeoutMs: params.providerTimeoutMs },
  );
  if (!streamUrl) return { found: false };

  return params.queue.run(async () => {
    const streamIndex = await findSubtitleStreamIndex(
      streamUrl,
      params.lang,
      params.extractionTimeoutMs,
    );
    if (streamIndex === null) return { found: false };
    const vttContent = await extractSubtitleToVtt(
      streamUrl,
      streamIndex,
      params.extractionTimeoutMs,
    );
    return { found: true, vttContent };
  });
}
