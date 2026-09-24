import type Database from 'better-sqlite3';

export interface RawDatasetEntry {
  title?: string;
  sources: string[];
}

export interface RawDataset {
  data: RawDatasetEntry[];
}

interface IdRow {
  anilistId: number | null;
  anidbId: number | null;
  title: string | null;
}

const SOURCE_PATTERNS = {
  anilist: /anilist\.co\/anime\/(\d+)/,
  anidb: /anidb\.net\/anime\/(\d+)/,
  kitsu: /kitsu\.(?:app|io)\/anime\/(\d+)/,
  mal: /myanimelist\.net\/anime\/(\d+)/,
};

function extractIds(sources: string[]) {
  const result = { anilistId: null as number | null, anidbId: null as number | null, kitsuId: null as number | null, malId: null as number | null };
  for (const url of sources) {
    const anilist = url.match(SOURCE_PATTERNS.anilist);
    if (anilist) result.anilistId = parseInt(anilist[1], 10);
    const anidb = url.match(SOURCE_PATTERNS.anidb);
    if (anidb) result.anidbId = parseInt(anidb[1], 10);
    const kitsu = url.match(SOURCE_PATTERNS.kitsu);
    if (kitsu) result.kitsuId = parseInt(kitsu[1], 10);
    const mal = url.match(SOURCE_PATTERNS.mal);
    if (mal) result.malId = parseInt(mal[1], 10);
  }
  return result;
}

export class AnimeDataset {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static buildFromRaw(raw: RawDataset, db: Database.Database): AnimeDataset {
    const rebuild = db.transaction((entries: RawDatasetEntry[]) => {
      db.exec(`
        DROP TABLE IF EXISTS anime_ids;
        CREATE TABLE anime_ids (
          anilist_id INTEGER,
          anidb_id INTEGER,
          kitsu_id INTEGER,
          mal_id INTEGER,
          title TEXT
        );
        CREATE INDEX idx_anilist ON anime_ids(anilist_id);
        CREATE INDEX idx_anidb ON anime_ids(anidb_id);
        CREATE INDEX idx_kitsu ON anime_ids(kitsu_id);
        CREATE INDEX idx_mal ON anime_ids(mal_id);
      `);
      const insert = db.prepare('INSERT INTO anime_ids (anilist_id, anidb_id, kitsu_id, mal_id, title) VALUES (?, ?, ?, ?, ?)');
      for (const entry of entries) {
        const ids = extractIds(entry.sources);
        if (ids.anilistId === null && ids.anidbId === null && ids.kitsuId === null && ids.malId === null) continue;
        insert.run(ids.anilistId, ids.anidbId, ids.kitsuId, ids.malId, entry.title ?? null);
      }
    });

    rebuild(raw.data);
    return new AnimeDataset(db);
  }

  findByAnilistId(id: number): IdRow | null {
    return (this.db.prepare('SELECT anilist_id as anilistId, anidb_id as anidbId, title FROM anime_ids WHERE anilist_id = ?').get(id) as IdRow) ?? null;
  }

  findByScheme(scheme: 'kitsu' | 'mal' | 'anidb', id: number): IdRow | null {
    const column = scheme === 'kitsu' ? 'kitsu_id' : scheme === 'mal' ? 'mal_id' : 'anidb_id';
    return (this.db.prepare(`SELECT anilist_id as anilistId, anidb_id as anidbId, title FROM anime_ids WHERE ${column} = ?`).get(id) as IdRow) ?? null;
  }
}

export async function downloadDataset(
  url = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json',
): Promise<RawDataset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download anime dataset: HTTP ${res.status}`);
  return (await res.json()) as RawDataset;
}
