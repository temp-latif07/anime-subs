import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheStore } from '../../src/cache/cacheStore.js';

describe('CacheStore', () => {
  let dir: string;
  let store: CacheStore;
  const key = { anilistId: 154587, episode: 10, lang: 'eng' };

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
    const filePath = store.setReady(key, 2, 'WEBVTT\n\n1\nhello');
    const entry = store.get(key)!;
    expect(entry.status).toBe('ready');
    expect(entry.tier).toBe(2);
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
    store.setReady(key, 3, 'WEBVTT\n\n1\nhi');
    expect(store.get(key)!.status).toBe('ready');
  });

  it('clears stale tier/filePath when a ready entry transitions back to pending', () => {
    store.setReady(key, 2, 'WEBVTT\n\n1\nold content');
    store.setPending(key);
    const entry = store.get(key)!;
    expect(entry.status).toBe('pending');
    expect(entry.tier).toBeNull();
    expect(entry.filePath).toBeNull();
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
    store.setReady(key, 1, 'WEBVTT\n\n1\nepisode 10 eng');
    expect(store.get({ ...key, episode: 11 })).toBeNull();
    expect(store.get({ ...key, lang: 'spa' })).toBeNull();
  });
});
