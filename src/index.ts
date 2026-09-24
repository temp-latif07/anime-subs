import Database from 'better-sqlite3';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { AnimeDataset, downloadDataset } from './resolver/animeDataset.js';
import { EpisodeMapping, downloadEpisodeMapping } from './resolver/episodeMapping.js';
import { CacheStore } from './cache/cacheStore.js';
import { ExtractionQueue } from './queue/extractionQueue.js';
import { createServer } from './server.js';
import { findJimakuSubtitle } from './providers/jimakuProvider.js';
import { findAnimeToshoSubtitle } from './providers/animetoshoProvider.js';
import { findOpenSubtitlesSubtitle } from './providers/opensubtitlesProvider.js';
import { runExtractionTier } from './providers/extractionProvider.js';
import type { DatasetHolder } from './subtitlesHandler.js';

const DATASET_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function loadOrRefreshDataset(
  datasetDb: Database.Database,
  previous?: AnimeDataset,
  downloadUrl?: string,
  episodeMapping?: EpisodeMapping,
): Promise<AnimeDataset> {
  try {
    const raw = await downloadDataset(downloadUrl);
    return AnimeDataset.buildFromRaw(raw, datasetDb, episodeMapping);
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

export async function loadOrRefreshEpisodeMapping(
  episodeMappingDb: Database.Database,
  previous?: EpisodeMapping,
  downloadUrl?: string,
): Promise<EpisodeMapping> {
  try {
    const xml = await downloadEpisodeMapping(downloadUrl);
    return EpisodeMapping.buildFromXml(xml, episodeMappingDb);
  } catch (err) {
    if (previous) {
      console.error(`[AnimeSubs] Episode-mapping download/build failed, keeping previous in-memory mapping: ${(err as Error).message}`);
      return previous;
    }
    const existing = tryLoadExistingEpisodeMappingTable(episodeMappingDb);
    if (existing) {
      console.error(`[AnimeSubs] Episode-mapping download failed on startup; falling back to on-disk table from a previous run: ${(err as Error).message}`);
      return existing;
    }
    throw err;
  }
}

function tryLoadExistingEpisodeMappingTable(db: Database.Database): EpisodeMapping | null {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episode_mapping'").get();
    if (!row) return null;
    const count = (db.prepare('SELECT COUNT(*) as c FROM episode_mapping').get() as { c: number }).c;
    if (count === 0) return null;
    return EpisodeMapping.fromExistingTable(db);
  } catch {
    return null;
  }
}

export interface ShutdownDependencies {
  server: { close: (callback?: (err?: Error) => void) => void };
  cache?: { close: () => void };
  datasetDb?: Database.Database;
  episodeMappingDb?: Database.Database;
  refreshInterval?: NodeJS.Timeout;
  exit?: (code: number) => void;
}

export function createShutdownHandler(deps: ShutdownDependencies): (signal: string) => void {
  let isShuttingDown = false;
  return (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[AnimeSubs] Received ${signal}, shutting down`);
    if (deps.refreshInterval) {
      clearInterval(deps.refreshInterval);
    }
    deps.server.close(() => {
      deps.cache?.close();
      deps.datasetDb?.close();
      deps.episodeMappingDb?.close();
      (deps.exit ?? process.exit)(0);
    });
  };
}

async function main() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const episodeMappingDb = new Database(join(config.dataDir, 'episode-mapping.db'));
  let episodeMapping = await loadOrRefreshEpisodeMapping(episodeMappingDb);

  const datasetDb = new Database(join(config.dataDir, 'anime-dataset.db'));
  const datasetHolder: DatasetHolder = { current: await loadOrRefreshDataset(datasetDb, undefined, undefined, episodeMapping) };
  const refreshInterval = setInterval(async () => {
    episodeMapping = await loadOrRefreshEpisodeMapping(episodeMappingDb, episodeMapping);
    datasetHolder.current = await loadOrRefreshDataset(datasetDb, datasetHolder.current, undefined, episodeMapping);
  }, DATASET_REFRESH_INTERVAL_MS);

  const cache = new CacheStore(join(config.dataDir, 'cache.db'), join(config.dataDir, 'subtitles'));
  const reconciled = cache.reconcilePendingOnStartup();
  if (reconciled > 0) {
    console.log(`[AnimeSubs] Cleared ${reconciled} stale pending cache row(s) from a previous run`);
  }

  const queue = new ExtractionQueue(config.extractionConcurrency);

  const app = createServer({
    dataset: datasetHolder,
    episodeMapping,
    cache,
    queue,
    config,
    buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}/${key.provider}.vtt`,
    jimakuProvider: findJimakuSubtitle,
    animetoshoProvider: findAnimeToshoSubtitle,
    opensubtitlesProvider: findOpenSubtitlesSubtitle,
    extractionProvider: runExtractionTier,
  }, cache);

  const server = app.listen(config.port, () => {
    console.log(`AnimeSubs listening on port ${config.port}`);
  });

  const shutdown = createShutdownHandler({
    server,
    cache,
    datasetDb,
    episodeMappingDb,
    refreshInterval,
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
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
