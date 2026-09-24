import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { loadOrRefreshDataset } from '../src/index.js';

describe('loadOrRefreshDataset', () => {
  it('falls back to an existing on-disk anime_ids table when the download fails and no previous in-memory dataset exists', async () => {
    const db = new Database(':memory:');
    AnimeDataset.buildFromRaw(
      { data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617'] }] },
      db,
    );

    // downloadDataset with an unreachable URL forces a failure
    const dataset = await loadOrRefreshDataset(db, undefined, 'http://127.0.0.1:1/unreachable');
    expect(dataset.findByAnilistId(154587)).toEqual({ anilistId: 154587, anidbId: 17617, title: null });
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
