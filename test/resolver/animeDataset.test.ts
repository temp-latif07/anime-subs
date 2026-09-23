import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AnimeDataset } from '../../src/resolver/animeDataset.js';

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
    expect(dataset.findByAnilistId(154587)).toEqual({ anilistId: 154587, anidbId: 17617 });
  });

  it('finds an entry by Kitsu id', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByScheme('kitsu', 46474)).toEqual({ anilistId: 154587, anidbId: 17617 });
  });

  it('finds an entry by MAL id', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByScheme('mal', 52991)).toEqual({ anilistId: 154587, anidbId: 17617 });
  });

  it('returns null for an id with no match', () => {
    const dataset = AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'));
    expect(dataset.findByAnilistId(999999)).toBeNull();
  });

  it('builds successfully even when some entries have no mappable ids', () => {
    expect(() => AnimeDataset.buildFromRaw(sampleRaw, new Database(':memory:'))).not.toThrow();
  });
});
