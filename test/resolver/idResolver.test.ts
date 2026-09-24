import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { AnimeDataset } from '../../src/resolver/animeDataset.js';
import { EpisodeMapping } from '../../src/resolver/episodeMapping.js';
import { parseSubtitleRequestId, resolveIds } from '../../src/resolver/idResolver.js';

const dataset = AnimeDataset.buildFromRaw({
  data: [
    {
      sources: [
        'https://anidb.net/anime/17617',
        'https://anilist.co/anime/154587',
        'https://kitsu.app/anime/46474',
        'https://myanimelist.net/anime/52991',
      ],
    },
    {
      title: 'Grand Blue Season 3',
      sources: [
        'https://kitsu.app/anime/50181',
      ],
    },
  ],
}, new Database(':memory:'));

const mappingXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="17617" tvdbid="418099" defaulttvdbseason="1" imdbid="tt21209876">
    <name>Fixture</name>
  </anime>
</anime-list>`;
const episodeMapping = EpisodeMapping.buildFromXml(mappingXml, new Database(':memory:'));
const datasetWithImdb = AnimeDataset.buildFromRaw({
  data: [{ sources: ['https://anidb.net/anime/17617', 'https://anilist.co/anime/154587'] }],
}, new Database(':memory:'), episodeMapping);

describe('parseSubtitleRequestId', () => {
  it('splits a kitsu-prefixed id into contentId/season/episode', () => {
    expect(parseSubtitleRequestId('kitsu:46474:1:10')).toEqual({ contentId: 'kitsu:46474', season: 1, episode: 10 });
  });

  it('splits a 3-part kitsu id into contentId/season=1/episode', () => {
    expect(parseSubtitleRequestId('kitsu:50350:3')).toEqual({ contentId: 'kitsu:50350', season: 1, episode: 3 });
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
    expect(resolveIds('kitsu:46474', dataset)).toEqual({ anilistId: 154587, anidbId: 17617, title: null, imdbId: null });
  });

  it('resolves a mal id via the dataset', () => {
    expect(resolveIds('mal:52991', dataset)).toEqual({ anilistId: 154587, anidbId: 17617, title: null, imdbId: null });
  });

  it('resolves an anilist id directly', () => {
    expect(resolveIds('anilist:154587', dataset)).toEqual({ anilistId: 154587, anidbId: 17617, title: null, imdbId: null });
  });

  it('returns nulls for a recognized scheme with no dataset match', () => {
    expect(resolveIds('kitsu:999999', dataset)).toEqual({ anilistId: null, anidbId: null });
  });

  it('returns anime title in resolveIds', () => {
    const ids = resolveIds('kitsu:50181', dataset);
    expect(ids.title).toBe('Grand Blue Season 3');
  });
});

describe('resolveIds — tt-prefixed content ids', () => {
  it('resolves a tt-prefixed id via the imdb_id reverse index and episode mapping', () => {
    const ids = resolveIds('tt21209876', datasetWithImdb, episodeMapping, 1, 5);
    expect(ids.anilistId).toBe(154587);
    expect(ids.anidbId).toBe(17617);
    expect(ids.imdbId).toBe('tt21209876');
  });

  it('returns nulls for a tt id with no matching imdb_id in the dataset', () => {
    const ids = resolveIds('tt00000000', datasetWithImdb, episodeMapping, 1, 5);
    expect(ids).toEqual({ anilistId: null, anidbId: null });
  });

  it('returns nulls for a tt id when no episodeMapping is supplied at all', () => {
    const ids = resolveIds('tt21209876', datasetWithImdb, undefined, 1, 5);
    expect(ids).toEqual({ anilistId: null, anidbId: null });
  });

  it('returns nulls for a tt id when season or episode is missing', () => {
    expect(resolveIds('tt21209876', datasetWithImdb, episodeMapping, undefined, 5)).toEqual({ anilistId: null, anidbId: null });
    expect(resolveIds('tt21209876', datasetWithImdb, episodeMapping, 1, undefined)).toEqual({ anilistId: null, anidbId: null });
  });

  it('disambiguates between multiple entries sharing the same imdbId based on season/episode mapping', () => {
    const multiXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="1001" tvdbid="5000" defaulttvdbseason="1" imdbid="tt9999999">
    <name>Show S1</name>
  </anime>
  <anime anidbid="1002" tvdbid="5000" defaulttvdbseason="2" imdbid="tt9999999">
    <name>Show S2</name>
  </anime>
</anime-list>`;
    const multiMapping = EpisodeMapping.buildFromXml(multiXml, new Database(':memory:'));
    const multiDataset = AnimeDataset.buildFromRaw({
      data: [
        { sources: ['https://anidb.net/anime/1001', 'https://anilist.co/anime/2001'] },
        { sources: ['https://anidb.net/anime/1002', 'https://anilist.co/anime/2002'] },
      ],
    }, new Database(':memory:'), multiMapping);

    const s1 = resolveIds('tt9999999', multiDataset, multiMapping, 1, 3);
    expect(s1.anilistId).toBe(2001);
    expect(s1.anidbId).toBe(1001);

    const s2 = resolveIds('tt9999999', multiDataset, multiMapping, 2, 3);
    expect(s2.anilistId).toBe(2002);
    expect(s2.anidbId).toBe(1002);
  });
});
