import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeVtt } from '../ffmpeg/vttUtils.js';
import type { CacheKey, CacheEntry, CacheStatus, ProviderResult } from '../types.js';

function keyId(key: CacheKey): string {
  return `${key.anilistId}:${key.episode}:${key.lang}`;
}

export class CacheStore {
  private db: Database.Database;
  private filesDir: string;
  private inFlight = new Map<string, Promise<ProviderResult>>();

  constructor(dbPath: string, filesDir: string) {
    this.filesDir = filesDir;
    if (!existsSync(filesDir)) mkdirSync(filesDir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tier INTEGER,
        file_path TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  get(key: CacheKey): CacheEntry | null {
    const row = this.db
      .prepare('SELECT status, tier, file_path, updated_at FROM cache WHERE key = ?')
      .get(keyId(key)) as { status: CacheStatus; tier: number | null; file_path: string | null; updated_at: number } | undefined;
    if (!row) return null;
    return { status: row.status, tier: row.tier as 1 | 2 | 3 | null, filePath: row.file_path, updatedAt: row.updated_at };
  }

  setPending(key: CacheKey): void {
    this.db.prepare(`
      INSERT INTO cache (key, status, tier, file_path, updated_at) VALUES (?, 'pending', NULL, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'pending', tier = NULL, file_path = NULL, updated_at = excluded.updated_at
    `).run(keyId(key), Date.now());
  }

  setReady(key: CacheKey, tier: 1 | 2 | 3, vttContent: string): string {
    const id = keyId(key);
    const filePath = join(this.filesDir, `${id.replace(/:/g, '_')}.vtt`);
    const normalized = normalizeVtt(vttContent);
    writeFileSync(filePath, normalized, 'utf-8');
    this.db.prepare(`
      INSERT INTO cache (key, status, tier, file_path, updated_at) VALUES (?, 'ready', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'ready', tier = excluded.tier, file_path = excluded.file_path, updated_at = excluded.updated_at
    `).run(id, tier, filePath, Date.now());
    return filePath;
  }

  setNegative(key: CacheKey): void {
    this.db.prepare(`
      INSERT INTO cache (key, status, tier, file_path, updated_at) VALUES (?, 'negative', NULL, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'negative', tier = NULL, file_path = NULL, updated_at = excluded.updated_at
    `).run(keyId(key), Date.now());
  }

  isNegativeExpired(entry: CacheEntry, ttlHours: number): boolean {
    return Date.now() - entry.updatedAt > ttlHours * 60 * 60 * 1000;
  }

  getInFlight(key: CacheKey): Promise<ProviderResult> | undefined {
    return this.inFlight.get(keyId(key));
  }

  setInFlight(key: CacheKey, promise: Promise<ProviderResult>): void {
    this.inFlight.set(keyId(key), promise);
  }

  clearInFlight(key: CacheKey): void {
    this.inFlight.delete(keyId(key));
  }

  close(): void {
    this.db.close();
  }
}
