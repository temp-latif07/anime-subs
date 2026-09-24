import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { loadOrRefreshDataset, createShutdownHandler } from '../src/index.js';

describe('loadOrRefreshDataset', () => {
  it('falls back to an existing on-disk anime_ids table when the download fails and no previous in-memory dataset exists', async () => {
    const db = new Database(':memory:');
    AnimeDataset.buildFromRaw(
      { data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617'] }] },
      db,
    );

    // downloadDataset with an unreachable URL forces a failure
    const dataset = await loadOrRefreshDataset(db, undefined, 'http://127.0.0.1:1/unreachable');
    expect(dataset.findByAnilistId(154587)).toEqual({ anilistId: 154587, anidbId: 17617, title: null, imdbId: null });
  });

  it('rethrows when the download fails and there is no fallback table at all', async () => {
    const db = new Database(':memory:');
    await expect(loadOrRefreshDataset(db, undefined, 'http://127.0.0.1:1/unreachable')).rejects.toThrow();
  });

  it('keeps previous in-memory dataset when refresh download fails', async () => {
    const db = new Database(':memory:');
    const prev = AnimeDataset.buildFromRaw(
      { data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617'] }] },
      db,
    );
    const dataset = await loadOrRefreshDataset(db, prev, 'http://127.0.0.1:1/unreachable');
    expect(dataset).toBe(prev);
  });

  it('rethrows when download fails and fallback table exists but is empty', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE anime_ids (anilist_id INTEGER, anidb_id INTEGER, kitsu_id INTEGER, mal_id INTEGER, title TEXT)');
    await expect(loadOrRefreshDataset(db, undefined, 'http://127.0.0.1:1/unreachable')).rejects.toThrow();
  });
});

describe('createShutdownHandler', () => {
  it('clears interval, closes server, closes databases, and exits 0 on signal', () => {
    let intervalCleared = false;
    const interval = setInterval(() => {}, 100000);
    const origClearInterval = globalThis.clearInterval;
    globalThis.clearInterval = ((timer: any) => {
      if (timer === interval) intervalCleared = true;
      origClearInterval(timer);
    }) as any;

    let serverClosed = false;
    let cacheClosed = false;
    let dbClosed = false;
    let exitCode: number | null = null;

    const mockServer = {
      close: (cb?: () => void) => {
        serverClosed = true;
        if (cb) cb();
      },
    };
    const mockCache = {
      close: () => {
        cacheClosed = true;
      },
    };
    const mockDb = {
      close: () => {
        dbClosed = true;
      },
    } as any;

    try {
      const shutdown = createShutdownHandler({
        server: mockServer,
        cache: mockCache as any,
        datasetDb: mockDb,
        refreshInterval: interval,
        exit: (code) => {
          exitCode = code;
        },
      });

      shutdown('SIGTERM');

      expect(intervalCleared).toBe(true);
      expect(serverClosed).toBe(true);
      expect(cacheClosed).toBe(true);
      expect(dbClosed).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      globalThis.clearInterval = origClearInterval;
      clearInterval(interval);
    }
  });

  it('ignores subsequent signals once shutdown has started', () => {
    let serverCloseCount = 0;
    const mockServer = {
      close: (cb?: () => void) => {
        serverCloseCount++;
        if (cb) cb();
      },
    };
    const shutdown = createShutdownHandler({
      server: mockServer,
      exit: () => {},
    });

    shutdown('SIGINT');
    shutdown('SIGINT');
    expect(serverCloseCount).toBe(1);
  });
});

