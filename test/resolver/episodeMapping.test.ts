import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { EpisodeMapping, downloadEpisodeMapping } from '../../src/resolver/episodeMapping.js';

const simpleXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="1" tvdbid="72025" defaulttvdbseason="1">
    <name>Fixture Show</name>
  </anime>
</anime-list>`;

describe('EpisodeMapping — no mapping-list (straight passthrough)', () => {
  it('maps anidb episode N to tvdb season=defaulttvdbseason, episode=N with no offset', () => {
    const mapping = EpisodeMapping.buildFromXml(simpleXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(1, 5)).toEqual({ season: 1, episode: 5 });
  });

  it('returns null for an anidbId not present in the dataset', () => {
    const mapping = EpisodeMapping.buildFromXml(simpleXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(999, 1)).toBeNull();
  });
});

const chobitsLikeXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="12" tvdbid="72070" defaulttvdbseason="1">
    <name>Fixture Chobits-like</name>
    <mapping-list>
      <mapping anidbseason="1" tvdbseason="0">;9-1;18-2;</mapping>
      <mapping anidbseason="1" tvdbseason="1" start="10" end="17" offset="-1"/>
      <mapping anidbseason="1" tvdbseason="1" start="19" end="26" offset="-2"/>
    </mapping-list>
  </anime>
</anime-list>`;

describe('EpisodeMapping — range and explicit rules (forward)', () => {
  it('applies an explicit episode override before falling through to range rules', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(12, 9)).toEqual({ season: 0, episode: 1 });
    expect(mapping.mapAnidbToTvdbEpisode(12, 18)).toEqual({ season: 0, episode: 2 });
  });

  it('applies a range+offset rule when no explicit override matches', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(12, 10)).toEqual({ season: 1, episode: 9 });
    expect(mapping.mapAnidbToTvdbEpisode(12, 26)).toEqual({ season: 1, episode: 24 });
  });
});

describe('EpisodeMapping — reverse (tvdb -> anidb) and imdbId', () => {
  it('reverses a range+offset rule', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('72070', 1, 9)).toEqual({ anidbId: 12, anidbEpisode: 10 });
  });

  it('reverses an explicit-list rule', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('72070', 0, 1)).toEqual({ anidbId: 12, anidbEpisode: 9 });
  });

  it('reverses a straight passthrough entry without mapping rules', () => {
    const mapping = EpisodeMapping.buildFromXml(simpleXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('72025', 1, 5)).toEqual({ anidbId: 1, anidbEpisode: 5 });
  });

  it('returns null when no anime entry has that tvdbId/season/episode combination', () => {
    const mapping = EpisodeMapping.buildFromXml(chobitsLikeXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('99999', 1, 1)).toBeNull();
  });

  it('exposes a direct imdbId from the dataset when present', () => {
    const xmlWithImdb = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="7" tvdbid="movie" imdbid="tt0119698">
    <name>Fixture Movie</name>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(xmlWithImdb, new Database(':memory:'));
    expect(mapping.findByAnidbId(7)?.imdbId).toBe('tt0119698');
  });

  it('findByAnidbId returns null for non-existent anidbId', () => {
    const mapping = EpisodeMapping.buildFromXml(simpleXml, new Database(':memory:'));
    expect(mapping.findByAnidbId(99999)).toBeNull();
  });

  it('maps across multiple anime entries sharing the same tvdbId across seasons', () => {
    const multiSeasonXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="101" tvdbid="5000" defaulttvdbseason="1">
    <name>Show Season 1</name>
  </anime>
  <anime anidbid="102" tvdbid="5000" defaulttvdbseason="2">
    <name>Show Season 2</name>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(multiSeasonXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('5000', 1, 3)).toEqual({ anidbId: 101, anidbEpisode: 3 });
    expect(mapping.mapTvdbToAnidbEpisode('5000', 2, 4)).toEqual({ anidbId: 102, anidbEpisode: 4 });
  });

  it('handles episodeOffset in straight passthrough forward and reverse', () => {
    const offsetXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="50" tvdbid="8000" defaulttvdbseason="2" episodeoffset="12">
    <name>Show Part 2</name>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(offsetXml, new Database(':memory:'));
    expect(mapping.mapAnidbToTvdbEpisode(50, 1)).toEqual({ season: 2, episode: 13 });
    expect(mapping.mapTvdbToAnidbEpisode('8000', 2, 13)).toEqual({ anidbId: 50, anidbEpisode: 1 });
  });

  it('reverses to the correct split-cour entry when two anidb entries share one tvdb season, disambiguated by offset', () => {
    const splitCourXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="100" tvdbid="9000" defaulttvdbseason="3">
    <name>Show Part 1</name>
  </anime>
  <anime anidbid="200" tvdbid="9000" defaulttvdbseason="3" episodeoffset="12">
    <name>Show Part 2</name>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(splitCourXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('9000', 3, 5)).toEqual({ anidbId: 100, anidbEpisode: 5 });
    expect(mapping.mapTvdbToAnidbEpisode('9000', 3, 13)).toEqual({ anidbId: 200, anidbEpisode: 1 });
  });

  it('reverses split-cour entries the same way regardless of row insertion order', () => {
    const splitCourXmlReversed = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="200" tvdbid="9001" defaulttvdbseason="3" episodeoffset="12">
    <name>Show Part 2</name>
  </anime>
  <anime anidbid="100" tvdbid="9001" defaulttvdbseason="3">
    <name>Show Part 1</name>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(splitCourXmlReversed, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('9001', 3, 5)).toEqual({ anidbId: 100, anidbEpisode: 5 });
    expect(mapping.mapTvdbToAnidbEpisode('9001', 3, 13)).toEqual({ anidbId: 200, anidbEpisode: 1 });
  });

  it('still falls back to the default season when the only mapping-list rule is for a different (specials) season', () => {
    const specialsPlusDefaultXml = `<?xml version="1.0" encoding="utf-8"?>
<anime-list>
  <anime anidbid="300" tvdbid="9500" defaulttvdbseason="1">
    <name>Show With A Special</name>
    <mapping-list>
      <mapping anidbseason="0" tvdbseason="0">;99-1;</mapping>
    </mapping-list>
  </anime>
</anime-list>`;
    const mapping = EpisodeMapping.buildFromXml(specialsPlusDefaultXml, new Database(':memory:'));
    expect(mapping.mapTvdbToAnidbEpisode('9500', 1, 3)).toEqual({ anidbId: 300, anidbEpisode: 3 });
  });
});

describe('downloadEpisodeMapping', () => {
  it('downloads raw XML text from a custom URL', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(simpleXml);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const xml = await downloadEpisodeMapping(`http://127.0.0.1:${port}/anime-list.xml`);
      expect(xml).toBe(simpleXml);
    } finally {
      server.close();
    }
  });

  it('throws when the response is not ok', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end('err');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(downloadEpisodeMapping(`http://127.0.0.1:${port}/x.xml`)).rejects.toThrow(
        'Failed to download episode mapping dataset: HTTP 500',
      );
    } finally {
      server.close();
    }
  });
});



