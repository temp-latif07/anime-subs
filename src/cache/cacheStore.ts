import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeVtt } from '../ffmpeg/vttUtils.js';
import type { CacheKey, CacheEntry, CacheStatus, CacheProvider, ProviderResult } from '../types.js';

function keyId(key: CacheKey): string {
  return `${key.anilistId}:${key.episode}:${key.lang}:${key.provider}`;
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
        provider TEXT,
        file_path TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS series_provider_cache (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        series_id INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_quota (
        provider TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        window_start INTEGER NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(cache)").all() as { name: string }[];
    const hasProvider = columns.some((c) => c.name === 'provider');
    if (!hasProvider) {
      this.db.exec("ALTER TABLE cache ADD COLUMN provider TEXT");
    }
    this.migrateTierColumnIfPresent();
  }

  private migrateTierColumnIfPresent(): void {
    const columns = this.db.prepare("PRAGMA table_info(cache)").all() as { name: string }[];
    const hasTier = columns.some((c) => c.name === 'tier');
    if (!hasTier) return;
    const TIER_TO_PROVIDER: Record<number, CacheProvider> = { 1: 'jimaku', 2: 'animetosho', 3: 'extraction' };
    const rows = this.db.prepare("SELECT key, tier FROM cache WHERE provider IS NULL AND tier IS NOT NULL").all() as { key: string; tier: number }[];
    const update = this.db.prepare('UPDATE cache SET provider = ? WHERE key = ?');
    for (const row of rows) {
      const provider = TIER_TO_PROVIDER[row.tier];
      if (provider) update.run(provider, row.key);
    }
  }

  get(key: CacheKey): CacheEntry | null {
    let row = this.db
      .prepare('SELECT status, provider, file_path, updated_at FROM cache WHERE key = ?')
      .get(keyId(key)) as { status: CacheStatus; provider: CacheProvider | null; file_path: string | null; updated_at: number } | undefined;
    if (!row) return null;
    if (row.status === 'ready' && row.provider === null) {
      this.migrateTierColumnIfPresent();
      row = this.db
        .prepare('SELECT status, provider, file_path, updated_at FROM cache WHERE key = ?')
        .get(keyId(key)) as { status: CacheStatus; provider: CacheProvider | null; file_path: string | null; updated_at: number } | undefined;
      if (!row) return null;
    }
    return { status: row.status, provider: row.provider, filePath: row.file_path, updatedAt: row.updated_at };
  }

  setPending(key: CacheKey): void {
    this.db.prepare(`
      INSERT INTO cache (key, status, provider, file_path, updated_at) VALUES (?, 'pending', NULL, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'pending', provider = NULL, file_path = NULL, updated_at = excluded.updated_at
    `).run(keyId(key), Date.now());
  }

  setReady(key: CacheKey, vttContent: string): string {
    const id = keyId(key);
    const filePath = join(this.filesDir, `${id.replace(/:/g, '_')}.vtt`);
    const normalized = normalizeVtt(vttContent, key.lang);
    writeFileSync(filePath, normalized, 'utf-8');
    this.db.prepare(`
      INSERT INTO cache (key, status, provider, file_path, updated_at) VALUES (?, 'ready', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'ready', provider = excluded.provider, file_path = excluded.file_path, updated_at = excluded.updated_at
    `).run(id, key.provider, filePath, Date.now());
    return filePath;
  }

  setNegative(key: CacheKey): void {
    this.db.prepare(`
      INSERT INTO cache (key, status, provider, file_path, updated_at) VALUES (?, 'negative', NULL, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'negative', provider = NULL, file_path = NULL, updated_at = excluded.updated_at
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

  setSeriesProviderMiss(provider: 'jimaku' | 'animetosho', seriesId: number): void {
    const id = `${provider}:${seriesId}`;
    this.db.prepare(`
      INSERT INTO series_provider_cache (id, provider, series_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(id, provider, seriesId, Date.now());
  }

  hasSeriesProviderMiss(provider: 'jimaku' | 'animetosho', seriesId: number, ttlHours: number): boolean {
    const id = `${provider}:${seriesId}`;
    const row = this.db
      .prepare('SELECT updated_at FROM series_provider_cache WHERE id = ?')
      .get(id) as { updated_at: number } | undefined;
    if (!row) return false;
    return Date.now() - row.updated_at <= ttlHours * 60 * 60 * 1000;
  }

  reconcilePendingOnStartup(): number {
    const result = this.db.prepare("DELETE FROM cache WHERE status = 'pending'").run();
    return result.changes;
  }

  recoverPendingRows(): number {
    return this.reconcilePendingOnStartup();
  }

  getRemainingQuota(provider: string, dailyLimit: number): number {
    const row = this.db.prepare('SELECT count, window_start FROM provider_quota WHERE provider = ?').get(provider) as { count: number; window_start: number } | undefined;
    if (!row || Date.now() - row.window_start > 24 * 60 * 60 * 1000) {
      return dailyLimit;
    }
    return Math.max(0, dailyLimit - row.count);
  }

  recordDownloadUsed(provider: string): void {
    const row = this.db.prepare('SELECT count, window_start FROM provider_quota WHERE provider = ?').get(provider) as { count: number; window_start: number } | undefined;
    const now = Date.now();
    if (!row || now - row.window_start > 24 * 60 * 60 * 1000) {
      this.db.prepare('INSERT INTO provider_quota (provider, count, window_start) VALUES (?, 1, ?) ON CONFLICT(provider) DO UPDATE SET count = 1, window_start = excluded.window_start').run(provider, now);
      return;
    }
    this.db.prepare('UPDATE provider_quota SET count = count + 1 WHERE provider = ?').run(provider);
  }

  close(): void {
    this.db.close();
  }
}

