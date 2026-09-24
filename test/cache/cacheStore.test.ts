import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CacheStore } from '../../src/cache/cacheStore.js';

describe('CacheStore', () => {
  let dir: string;
  let store: CacheStore;
  const key = { anilistId: 154587, episode: 10, lang: 'eng', provider: 'jimaku' as const };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-cache-'));
    store = new CacheStore(join(dir, 'cache.db'), join(dir, 'files'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a key that has never been written', () => {
    expect(store.get(key)).toBeNull();
  });

  it('round-trips a ready entry and writes the vtt file to disk', () => {
    const toshoKey = { ...key, provider: 'animetosho' as const };
    const filePath = store.setReady(toshoKey, 'WEBVTT\n\n1\nhello');
    const entry = store.get(toshoKey)!;
    expect(entry.status).toBe('ready');
    expect(entry.provider).toBe('animetosho');
    expect(entry.filePath).toBe(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('WEBVTT\n\n1\nhello');
  });

  it('records a negative entry', () => {
    store.setNegative(key);
    expect(store.get(key)!.status).toBe('negative');
  });

  it('treats a negative entry as expired only after the configured TTL', () => {
    store.setNegative(key);
    const fresh = store.get(key)!;
    expect(store.isNegativeExpired(fresh, 24)).toBe(false);
    const stale = { ...fresh, updatedAt: Date.now() - 25 * 60 * 60 * 1000 };
    expect(store.isNegativeExpired(stale, 24)).toBe(true);
  });

  it('overwrites a pending entry once the result becomes ready', () => {
    store.setPending(key);
    expect(store.get(key)!.status).toBe('pending');
    store.setReady(key, 'WEBVTT\n\n1\nhi');
    expect(store.get(key)!.status).toBe('ready');
  });

  it('clears stale provider/filePath when a ready entry transitions back to pending', () => {
    store.setReady(key, 'WEBVTT\n\n1\nold content');
    store.setPending(key);
    const entry = store.get(key)!;
    expect(entry.status).toBe('pending');
    expect(entry.provider).toBeNull();
    expect(entry.filePath).toBeNull();
  });

  it('deletes an entry from the cache', () => {
    store.setReady(key, 'WEBVTT\n\n1\nready to delete');
    expect(store.get(key)).not.toBeNull();
    store.delete(key);
    expect(store.get(key)).toBeNull();
  });

  it('deleteByKey removes the database entry and unlinks the file from disk', () => {
    const toshoKey = { ...key, provider: 'animetosho' as const };
    const filePath = store.setReady(toshoKey, 'WEBVTT\n\n1\nhello');
    expect(existsSync(filePath)).toBe(true);

    const deleted = store.deleteByKey(`${toshoKey.anilistId}:${toshoKey.episode}:${toshoKey.lang}:${toshoKey.provider}`);
    expect(deleted).toBe(true);
    expect(store.get(toshoKey)).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('delete removes the database entry and unlinks the file from disk', () => {
    const toshoKey = { ...key, provider: 'animetosho' as const };
    const filePath = store.setReady(toshoKey, 'WEBVTT\n\n1\nhello');
    expect(existsSync(filePath)).toBe(true);

    store.delete(toshoKey);
    expect(store.get(toshoKey)).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('purges known forced cache entries (e.g. 195600:2:eng:animetosho) on initialization', () => {
    const forcedKey = { anilistId: 195600, episode: 2, lang: 'eng', provider: 'animetosho' as const };
    const filePath = store.setReady(forcedKey, 'WEBVTT\n\n1\nForced subtitle line');
    expect(store.get(forcedKey)).not.toBeNull();
    expect(existsSync(filePath)).toBe(true);

    // Re-initialize a new CacheStore on the same directory
    const dbPath = join(dir, 'cache.db');
    const newStore = new CacheStore(dbPath, join(dir, 'files'));
    try {
      expect(newStore.get(forcedKey)).toBeNull();
      expect(existsSync(filePath)).toBe(false);
    } finally {
      newStore.close();
    }
  });

  it('tracks and clears in-flight work per key', () => {
    expect(store.getInFlight(key)).toBeUndefined();
    const promise = Promise.resolve({ found: true, vttContent: 'x' });
    store.setInFlight(key, promise);
    expect(store.getInFlight(key)).toBe(promise);
    store.clearInFlight(key);
    expect(store.getInFlight(key)).toBeUndefined();
  });

  it('keys different episodes/languages independently', () => {
    store.setReady(key, 'WEBVTT\n\n1\nepisode 10 eng');
    expect(store.get({ ...key, episode: 11 })).toBeNull();
    expect(store.get({ ...key, lang: 'spa' })).toBeNull();
  });

  it('keys the same episode/lang independently per provider', () => {
    const jimakuKey = { ...key, provider: 'jimaku' as const };
    const toshoKey = { ...key, provider: 'animetosho' as const };
    store.setReady(jimakuKey, 'WEBVTT\n\n1\njimaku');
    expect(store.get(toshoKey)).toBeNull();
    expect(store.get(jimakuKey)?.status).toBe('ready');
  });

  it('migrates an old-schema row (tier column, no provider) to the provider column on read', () => {
    // Simulate a pre-migration row written by the old schema directly via raw SQL,
    // the way an existing production cache.db would have it.
    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    rawDb.exec("ALTER TABLE cache ADD COLUMN tier INTEGER");
    rawDb.prepare("INSERT INTO cache (key, status, tier, file_path, updated_at, provider) VALUES (?, 'ready', 3, '/tmp/x.vtt', ?, NULL)")
      .run('154587:10:eng', Date.now());
    const migrated = store.get({ ...key, provider: 'extraction' as const });
    expect(migrated).not.toBeNull();
    expect(migrated?.provider).toBe('extraction');
  });

  it('migrates an old-schema database (tier column without provider) on startup', () => {
    store.close();
    const dbPath = join(dir, 'cache.db');
    rmSync(dbPath);
    const oldDb = new Database(dbPath);
    oldDb.exec(`
      CREATE TABLE cache (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tier INTEGER,
        file_path TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
    oldDb.prepare("INSERT INTO cache (key, status, tier, file_path, updated_at) VALUES (?, 'ready', 1, '/tmp/j.vtt', ?)")
      .run('154587:10:eng', Date.now());
    oldDb.close();

    store = new CacheStore(dbPath, join(dir, 'files'));
    const entry = store.get(key);
    expect(entry).not.toBeNull();
    expect(entry?.status).toBe('ready');
    expect(entry?.provider).toBe('jimaku');
  });

  it('records and checks series-level provider negative cache with TTL', () => {
    expect(store.hasSeriesProviderMiss('jimaku', 154587, 24)).toBe(false);
    store.setSeriesProviderMiss('jimaku', 154587);
    expect(store.hasSeriesProviderMiss('jimaku', 154587, 24)).toBe(true);
    expect(store.hasSeriesProviderMiss('animetosho', 154587, 24)).toBe(false);
    expect(store.hasSeriesProviderMiss('jimaku', 999999, 24)).toBe(false);
  });

  it('reconciles stale pending rows left over from a process restart back to a clean (absent) state', () => {
    store.setPending(key);
    // Simulate a restart: inFlight Map is empty (fresh CacheStore instance),
    // but the DB row is still 'pending'.
    const reconciled = store.reconcilePendingOnStartup();
    expect(reconciled).toBe(1);
    expect(store.get(key)).toBeNull();
  });

  it('does not touch ready or negative rows during pending reconciliation', () => {
    store.setReady(key, 'WEBVTT\n\n1\nhi');
    const otherKey = { ...key, episode: 11 };
    store.setNegative(otherKey);
    store.reconcilePendingOnStartup();
    expect(store.get(key)?.status).toBe('ready');
    expect(store.get(otherKey)?.status).toBe('negative');
  });

  it('provides recoverPendingRows as an alias for reconcilePendingOnStartup', () => {
    store.setPending(key);
    const recovered = store.recoverPendingRows();
    expect(recovered).toBe(1);
    expect(store.get(key)).toBeNull();
  });

  it('tracks remaining quota and decrements when downloads are recorded', () => {
    expect(store.getRemainingQuota('opensubtitles', 20)).toBe(20);
    store.recordDownloadUsed('opensubtitles');
    expect(store.getRemainingQuota('opensubtitles', 20)).toBe(19);
    store.recordDownloadUsed('opensubtitles');
    expect(store.getRemainingQuota('opensubtitles', 20)).toBe(18);
  });

  it('does not return negative quota when usage exceeds limit', () => {
    for (let i = 0; i < 5; i++) {
      store.recordDownloadUsed('opensubtitles');
    }
    expect(store.getRemainingQuota('opensubtitles', 3)).toBe(0);
  });

  it('resets quota window after 24 hours', () => {
    store.recordDownloadUsed('opensubtitles');
    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const past = Date.now() - 25 * 60 * 60 * 1000;
    rawDb.prepare('UPDATE provider_quota SET window_start = ? WHERE provider = ?').run(past, 'opensubtitles');
    expect(store.getRemainingQuota('opensubtitles', 20)).toBe(20);
    store.recordDownloadUsed('opensubtitles');
    expect(store.getRemainingQuota('opensubtitles', 20)).toBe(19);
  });

  it('tracks quota independently per provider', () => {
    store.recordDownloadUsed('opensubtitles');
    expect(store.getRemainingQuota('opensubtitles', 20)).toBe(19);
    expect(store.getRemainingQuota('other', 20)).toBe(20);
  });
});

