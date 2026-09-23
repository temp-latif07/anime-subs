import Database from 'better-sqlite3';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { AnimeDataset, downloadDataset } from './resolver/animeDataset.js';
import { CacheStore } from './cache/cacheStore.js';
import { ExtractionQueue } from './queue/extractionQueue.js';
import { createServer } from './server.js';
import { findJimakuSubtitle } from './providers/jimakuProvider.js';
import { findAnimeToshoSubtitle } from './providers/animetoshoProvider.js';
import { runExtractionTier } from './providers/extractionProvider.js';
import type { DatasetHolder } from './subtitlesHandler.js';

const DATASET_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main() {
  const config = loadConfig();

  const datasetDb = new Database(join(config.dataDir, 'anime-dataset.db'));
  const datasetHolder: DatasetHolder = { current: AnimeDataset.buildFromRaw(await downloadDataset(), datasetDb) };
  setInterval(async () => {
    try {
      datasetHolder.current = AnimeDataset.buildFromRaw(await downloadDataset(), datasetDb);
    } catch (err) {
      console.error('Failed to refresh anime dataset:', err);
    }
  }, DATASET_REFRESH_INTERVAL_MS);

  const cache = new CacheStore(join(config.dataDir, 'cache.db'), join(config.dataDir, 'subtitles'));
  const queue = new ExtractionQueue(config.extractionConcurrency);

  const app = createServer({
    dataset: datasetHolder,
    cache,
    queue,
    config,
    buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
    jimakuProvider: findJimakuSubtitle,
    animetoshoProvider: findAnimeToshoSubtitle,
    extractionProvider: runExtractionTier,
  }, cache);

  app.listen(config.port, () => {
    console.log(`AnimeSubs listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
