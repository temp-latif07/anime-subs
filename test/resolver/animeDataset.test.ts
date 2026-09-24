import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnimeDataset, downloadDataset } from '../../src/resolver/animeDataset.js';

const sampleRaw = {
  data: [
    {
      sources: [
        'https://anidb.net/anime/17617',
        'https://anilist.co/anime/154587',
        'https://kitsu.app/anime/46474',
        'https://myanimelist.net/anime/52991',
      ],
    },
    { sources: ['https://anime-planet.com/anime/no-mapped-ids'] },
  ],
};

describe('AnimeDataset', () => {
  it('finds an entry by AniList id and returns its AniDB id', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByAnilistId(154587)).toEqual({ anilistId: 154587, anidbId: 17617, title: null });
  });

  it('finds an entry by Kitsu id', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByScheme('kitsu', 46474)).toEqual({ anilistId: 154587, anidbId: 17617, title: null });
  });

  it('finds an entry by MAL id', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByScheme('mal', 52991)).toEqual({ anilistId: 154587, anidbId: 17617, title: null });
  });

  it('returns null for an id with no match', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByAnilistId(999999)).toBeNull();
  });

  it('builds successfully even when some entries have no mappable ids', () => {
    expect(() => AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'))).not.toThrow();
  });

  it('stores and returns the canonical anime title', () => {
    const raw = {
      data: [
        {
          title: 'Grand Blue Season 3',
          sources: ['https://anidb.net/anime/19600', 'https://anilist.co/anime/199111'],
        },
      ],
    };
    const dataset = AnimeDataset.buildFromRaw(raw, new Database(':memory:'));
    const row = dataset.findByAnilistId(199111);
    expect(row?.title).toBe('Grand Blue Season 3');
  });

  it('leaves the previous table intact when a rebuild fails partway through insertion', () => {
    const db = new Database(':memory:');
    AnimeDataset.buildFromRaw(sampleRaw, db); // first successful build

    const badRaw = {
      data: [
        { sources: null },
      ],
    };
    // @ts-expect-error -- intentionally malformed to simulate a bad upstream entry
    expect(() => AnimeDataset.buildFromRaw(badRaw, db)).toThrow();

    // The table from the first successful build must still be queryable.
    const row = db.prepare('SELECT anilist_id FROM anime_ids WHERE anilist_id = ?').get(154587);
    expect(row).toBeDefined();
  });

  it('instantiates AnimeDataset from an existing table', () => {
    const db = new Database(':memory:');
    AnimeDataset.buildFromRaw(sampleRaw, db);
    const dataset = AnimeDataset.fromExistingTable(db);
    expect(dataset.findByAnilistId(154587)).toEqual({ anilistId: 154587, anidbId: 17617, title: null });
  });
});

describe('downloadDataset', () => {
  it('downloads and parses dataset from a custom URL', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sampleRaw));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const data = await downloadDataset(`http://127.0.0.1:${port}/dataset.json`);
      expect(data).toEqual(sampleRaw);
    } finally {
      server.close();
    }
  });

  it('throws Error when response is not ok', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      await expect(downloadDataset(`http://127.0.0.1:${port}/dataset.json`)).rejects.toThrow('Failed to download anime dataset: HTTP 500');
    } finally {
      server.close();
    }
  });
});
