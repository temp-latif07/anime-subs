import Database from 'better-sqlite3';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function loadOrRefreshDataset(
  datasetDb: Database.Database,
  previous?: AnimeDataset,
  downloadUrl?: string,
): Promise<AnimeDataset> {
  try {
    const raw = await downloadDataset(downloadUrl);
    return AnimeDataset.buildFromRaw(raw, datasetDb);
  } catch (err) {
    if (previous) {
      console.error(`[AnimeSubs] Dataset download/build failed, keeping previous in-memory dataset: ${(err as Error).message}`);
      return previous;
    }
    const existing = tryLoadExistingTable(datasetDb);
    if (existing) {
      console.error(`[AnimeSubs] Dataset download failed on startup; falling back to on-disk anime_ids table from a previous run: ${(err as Error).message}`);
      return existing;
    }
    throw err;
  }
}

function tryLoadExistingTable(db: Database.Database): AnimeDataset | null {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anime_ids'").get();
    if (!row) return null;
    const count = (db.prepare('SELECT COUNT(*) as c FROM anime_ids').get() as { c: number }).c;
    if (count === 0) return null;
    return AnimeDataset.fromExistingTable(db);
  } catch {
    return null;
  }
}

async function main() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const datasetDb = new Database(join(config.dataDir, 'anime-dataset.db'));
  const datasetHolder: DatasetHolder = { current: await loadOrRefreshDataset(datasetDb) };
  setInterval(async () => {
    datasetHolder.current = await loadOrRefreshDataset(datasetDb, datasetHolder.current);
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

const isDirectRun = process.argv[1] && (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
