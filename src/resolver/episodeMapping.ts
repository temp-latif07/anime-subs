import type Database from 'better-sqlite3';
import { XMLParser } from 'fast-xml-parser';

export interface MappingRule {
  anidbSeason: number;
  tvdbSeason: number;
  ranges: { start: number; end: number; offset: number }[];
  explicit: { from: number; to: number }[];
}

export interface MappingRow {
  anidbId: number;
  tvdbId: string | null;
  imdbId: string | null;
  defaultTvdbSeason: number | null;
  episodeOffset: number | null;
  mappingRules: MappingRule[];
}

interface RawMappingElement {
  '@_anidbseason': string;
  '@_tvdbseason': string;
  '@_start'?: string;
  '@_end'?: string;
  '@_offset'?: string;
  '#text'?: string;
}

interface RawAnimeElement {
  '@_anidbid': string;
  '@_tvdbid'?: string;
  '@_imdbid'?: string;
  '@_defaulttvdbseason'?: string;
  '@_episodeoffset'?: string;
  'mapping-list'?: { mapping: RawMappingElement | RawMappingElement[] };
}

function parseMappingRules(raw: RawAnimeElement['mapping-list']): MappingRule[] {
  if (!raw?.mapping) return [];
  const elements = Array.isArray(raw.mapping) ? raw.mapping : [raw.mapping];
  return elements.map((m) => {
    const rule: MappingRule = {
      anidbSeason: parseInt(m['@_anidbseason'], 10),
      tvdbSeason: parseInt(m['@_tvdbseason'], 10),
      ranges: [],
      explicit: [],
    };
    if (m['@_start'] !== undefined && m['@_end'] !== undefined) {
      rule.ranges.push({
        start: parseInt(m['@_start'], 10),
        end: parseInt(m['@_end'], 10),
        offset: parseInt(m['@_offset'] ?? '0', 10),
      });
    } else if (typeof m['#text'] === 'string') {
      for (const pair of m['#text'].split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const [from, to] = trimmed.split('-').map((n) => parseInt(n, 10));
        if (!Number.isNaN(from) && !Number.isNaN(to)) rule.explicit.push({ from, to });
      }
    }
    return rule;
  });
}

export class EpisodeMapping {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static fromExistingTable(db: Database.Database): EpisodeMapping {
    return new EpisodeMapping(db);
  }

  static buildFromXml(xml: string, db: Database.Database): EpisodeMapping {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(xml) as { 'anime-list'?: { anime?: RawAnimeElement | RawAnimeElement[] } };
    const rawAnime = parsed?.['anime-list']?.anime;
    const entries = !rawAnime ? [] : Array.isArray(rawAnime) ? rawAnime : [rawAnime];

    const rebuild = db.transaction((rows: RawAnimeElement[]) => {
      db.exec(`
        DROP TABLE IF EXISTS episode_mapping;
        CREATE TABLE episode_mapping (
          anidb_id INTEGER PRIMARY KEY,
          tvdb_id TEXT,
          imdb_id TEXT,
          default_tvdb_season INTEGER,
          episode_offset INTEGER,
          mapping_rules TEXT NOT NULL
        );
        CREATE INDEX idx_episode_mapping_tvdb ON episode_mapping(tvdb_id);
      `);
      const insert = db.prepare(
        'INSERT INTO episode_mapping (anidb_id, tvdb_id, imdb_id, default_tvdb_season, episode_offset, mapping_rules) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        const anidbId = parseInt(row['@_anidbid'], 10);
        if (Number.isNaN(anidbId)) continue;
        const rules = parseMappingRules(row['mapping-list']);
        insert.run(
          anidbId,
          row['@_tvdbid'] ?? null,
          row['@_imdbid'] ?? null,
          row['@_defaulttvdbseason'] !== undefined ? parseInt(row['@_defaulttvdbseason'], 10) : null,
          row['@_episodeoffset'] !== undefined ? parseInt(row['@_episodeoffset'], 10) : null,
          JSON.stringify(rules),
        );
      }
    });
    rebuild(entries);
    return new EpisodeMapping(db);
  }

  findByAnidbId(anidbId: number): MappingRow | null {
    const row = this.db
      .prepare(
        'SELECT anidb_id, tvdb_id, imdb_id, default_tvdb_season, episode_offset, mapping_rules FROM episode_mapping WHERE anidb_id = ?',
      )
      .get(anidbId) as
      | {
          anidb_id: number;
          tvdb_id: string | null;
          imdb_id: string | null;
          default_tvdb_season: number | null;
          episode_offset: number | null;
          mapping_rules: string;
        }
      | undefined;
    if (!row) return null;
    return {
      anidbId: row.anidb_id,
      tvdbId: row.tvdb_id,
      imdbId: row.imdb_id,
      defaultTvdbSeason: row.default_tvdb_season,
      episodeOffset: row.episode_offset,
      mappingRules: JSON.parse(row.mapping_rules) as MappingRule[],
    };
  }

  mapAnidbToTvdbEpisode(
    anidbId: number,
    anidbEpisode: number,
    anidbSeason = 1,
  ): { season: number; episode: number } | null {
    const row = this.findByAnidbId(anidbId);
    if (!row) return null;

    for (const rule of row.mappingRules) {
      if (rule.anidbSeason !== anidbSeason) continue;
      const explicit = rule.explicit.find((e) => e.from === anidbEpisode);
      if (explicit) return { season: rule.tvdbSeason, episode: explicit.to };
      const range = rule.ranges.find((r) => anidbEpisode >= r.start && anidbEpisode <= r.end);
      if (range) return { season: rule.tvdbSeason, episode: anidbEpisode + range.offset };
    }

    if (row.defaultTvdbSeason === null) return null;
    const offset = row.episodeOffset ?? 0;
    return { season: row.defaultTvdbSeason, episode: anidbEpisode + offset };
  }

  mapTvdbToAnidbEpisode(
    tvdbId: string,
    tvdbSeason: number,
    tvdbEpisode: number,
  ): { anidbId: number; anidbEpisode: number } | null {
    const rows = this.db
      .prepare(
        'SELECT anidb_id, default_tvdb_season, episode_offset, mapping_rules FROM episode_mapping WHERE tvdb_id = ?',
      )
      .all(tvdbId) as {
      anidb_id: number;
      default_tvdb_season: number | null;
      episode_offset: number | null;
      mapping_rules: string;
    }[];

    for (const row of rows) {
      const rules = JSON.parse(row.mapping_rules) as MappingRule[];
      for (const rule of rules) {
        if (rule.tvdbSeason !== tvdbSeason) continue;
        const explicit = rule.explicit.find((e) => e.to === tvdbEpisode);
        if (explicit) return { anidbId: row.anidb_id, anidbEpisode: explicit.from };
        const range = rule.ranges.find((r) => {
          const mappedStart = r.start + r.offset;
          const mappedEnd = r.end + r.offset;
          return tvdbEpisode >= mappedStart && tvdbEpisode <= mappedEnd;
        });
        if (range) return { anidbId: row.anidb_id, anidbEpisode: tvdbEpisode - range.offset };
      }
      if (rules.length === 0 && row.default_tvdb_season === tvdbSeason) {
        const offset = row.episode_offset ?? 0;
        return { anidbId: row.anidb_id, anidbEpisode: tvdbEpisode - offset };
      }
    }
    return null;
  }
}

export async function downloadEpisodeMapping(
  url = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml',
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download episode mapping dataset: HTTP ${res.status}`);
  return res.text();
}
