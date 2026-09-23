import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AnimeDataset } from '../../src/resolver/animeDataset.js';
import { parseSubtitleRequestId, resolveIds } from '../../src/resolver/idResolver.js';

const dataset = AnimeDataset.buildFromRaw({
  data: [{
    sources: [
      'https://anidb.net/anime/17617',
      'https://anilist.co/anime/154587',
      'https://kitsu.app/anime/46474',
      'https://myanimelist.net/anime/52991',
    ],
  }],
}, new Database(':memory:'));

describe('parseSubtitleRequestId', () => {
  it('splits a kitsu-prefixed id into contentId/season/episode', () => {
    expect(parseSubtitleRequestId('kitsu:46474:1:10')).toEqual({ contentId: 'kitsu:46474', season: 1, episode: 10 });
  });

  it('splits a bare imdb id (no scheme prefix) correctly', () => {
    expect(parseSubtitleRequestId('tt39304754:1:1')).toEqual({ contentId: 'tt39304754', season: 1, episode: 1 });
  });

  it('throws on a malformed id', () => {
    expect(() => parseSubtitleRequestId('not-enough-parts')).toThrow(/Malformed/);
  });
});

describe('resolveIds', () => {
  it('resolves a kitsu id via the dataset', () => {
    expect(resolveIds('kitsu:46474', dataset)).toEqual({ anilistId: 154587, anidbId: 17617 });
  });

  it('resolves a mal id via the dataset', () => {
    expect(resolveIds('mal:52991', dataset)).toEqual({ anilistId: 154587, anidbId: 17617 });
  });

  it('resolves an anilist id directly', () => {
    expect(resolveIds('anilist:154587', dataset)).toEqual({ anilistId: 154587, anidbId: 17617 });
  });

  it('returns nulls for a bare tt id (no IMDb mapping in v1)', () => {
    expect(resolveIds('tt39304754', dataset)).toEqual({ anilistId: null, anidbId: null });
  });

  it('returns nulls for a recognized scheme with no dataset match', () => {
    expect(resolveIds('kitsu:999999', dataset)).toEqual({ anilistId: null, anidbId: null });
  });
});
