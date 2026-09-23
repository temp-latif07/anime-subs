# AnimeSubs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted Stremio subtitle addon that resolves English anime subtitles through a three-tier fallback chain (Jimaku → AnimeTosho → embedded-track extraction from the user's own stream addon), so anime with no external subtitle source and/or embedded-only tracks still get subtitles that render correctly on TV.

**Architecture:** A single Node.js/TypeScript HTTP server (Express) implementing only the Stremio `subtitles` resource. Everything is orchestrated in-process: an id resolver normalizes whatever id Stremio sends into AniList/AniDB ids via a bundled cross-reference dataset, two fast external providers (Jimaku, AnimeTosho) are tried synchronously, and a slower fallback (calls the user's own stream addon, extracts the embedded subtitle track with ffmpeg) runs as a queued background job cached in SQLite + a local file directory. Packaged as a Docker image for self-hosting (home server / VPS) — no serverless, no external job queue, no external cache service needed.

**Tech Stack:** Node.js 24, TypeScript (ESM/NodeNext), Express 5, better-sqlite3, Vitest, ffmpeg/ffprobe + xz-utils (system binaries via Docker), Docker + docker-compose.

**Spec:** `docs/superpowers/specs/2026-09-23-anime-subs-addon-design.md`

## Global Constraints

- Single-tenant only: config via env vars, no per-user tokens, no SSRF hardening against arbitrary third-party input (per spec's Non-goals).
- Default target language: `eng` (ISO 639-2), configurable via `SUBTITLE_LANGUAGES`.
- Scope is anime **series** only — no movie support (episodic semantics are load-bearing throughout: Jimaku's `episode` filter, AnimeTosho's episode-number title parsing, per-episode caching). Manifest declares `types: ["series"]` only.
- The anime cross-reference dataset (`manami-project/anime-offline-database`) has **no IMDb mapping** — a bare `tt…` id that doesn't otherwise resolve returns an empty subtitle list, never an error.
- Cache-first always: no provider tier runs on a cache hit (`ready`, `pending`, or unexpired `negative`).
- In-flight de-duplication: never start a second background extraction for a key that already has one running.
- ffmpeg/ffprobe/xz are invoked via array-form `child_process.spawn`/`execFileSync` — never shell-interpolated.
- All outbound HTTP calls use an explicit timeout (`PROVIDER_TIMEOUT_MS`, default 8000ms) via `AbortController`.
- TDD throughout: every task writes the failing test first, confirms the failure, then implements.
- Commit after every task (all steps of a task belong in one commit unless a step explicitly says otherwise).

---

### Task 1: Project scaffolding + config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `export interface Config { port: number; dataDir: string; streamAddonUrl: string; jimakuApiKey: string; subtitleLanguages: string[]; negativeCacheTtlHours: number; extractionConcurrency: number; extractionTimeoutMs: number; providerTimeoutMs: number; logLevel: string; }` and `export function loadConfig(env?: NodeJS.ProcessEnv): Config` — throws `Error` with a message naming the missing/invalid var.

- [ ] **Step 1: Create the project scaffolding files**

`package.json`:
```json
{
  "name": "animesubs",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "better-sqlite3": "^13.0.3",
    "express": "^5.2.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/express": "^5.0.6",
    "@types/node": "^26.6.2",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vitest": "^5.0.1"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60000,
  },
});
```

`.gitignore`:
```
node_modules/
dist/
.env
*.db
/data/
```

`.env.example`:
```
STREAM_ADDON_URL=https://your-aiostreams-instance.example.com/your-config-token/manifest.json
JIMAKU_API_KEY=your-jimaku-api-key
SUBTITLE_LANGUAGES=eng
PORT=7000
DATA_DIR=/data
NEGATIVE_CACHE_TTL_HOURS=24
EXTRACTION_CONCURRENCY=1
EXTRACTION_TIMEOUT_MS=900000
PROVIDER_TIMEOUT_MS=8000
LOG_LEVEL=info
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  STREAM_ADDON_URL: 'https://aiostreams.example.com/abc123/manifest.json',
  JIMAKU_API_KEY: 'test-key',
};

describe('loadConfig', () => {
  it('applies defaults when optional vars are absent', () => {
    const config = loadConfig(baseEnv as NodeJS.ProcessEnv);
    expect(config.port).toBe(7000);
    expect(config.dataDir).toBe('/data');
    expect(config.subtitleLanguages).toEqual(['eng']);
    expect(config.negativeCacheTtlHours).toBe(24);
    expect(config.extractionConcurrency).toBe(1);
    expect(config.extractionTimeoutMs).toBe(900000);
    expect(config.providerTimeoutMs).toBe(8000);
  });

  it('parses comma-separated languages, trimming whitespace', () => {
    const config = loadConfig({ ...baseEnv, SUBTITLE_LANGUAGES: 'eng, spa , fre' } as NodeJS.ProcessEnv);
    expect(config.subtitleLanguages).toEqual(['eng', 'spa', 'fre']);
  });

  it('throws a descriptive error when STREAM_ADDON_URL is missing', () => {
    const { STREAM_ADDON_URL, ...rest } = baseEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/STREAM_ADDON_URL/);
  });

  it('throws a descriptive error when JIMAKU_API_KEY is missing', () => {
    const { JIMAKU_API_KEY, ...rest } = baseEnv;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/JIMAKU_API_KEY/);
  });

  it('throws when STREAM_ADDON_URL is not a valid URL', () => {
    expect(() => loadConfig({ ...baseEnv, STREAM_ADDON_URL: 'not-a-url' } as NodeJS.ProcessEnv))
      .toThrow(/not a valid URL/);
  });

  it('throws when a numeric var is present but blank', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: '' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('throws when a numeric var is present but not a number', () => {
    expect(() => loadConfig({ ...baseEnv, EXTRACTION_CONCURRENCY: 'abc' } as NodeJS.ProcessEnv)).toThrow(/EXTRACTION_CONCURRENCY/);
  });

  it('throws when SUBTITLE_LANGUAGES is present but blank', () => {
    expect(() => loadConfig({ ...baseEnv, SUBTITLE_LANGUAGES: '' } as NodeJS.ProcessEnv)).toThrow(/SUBTITLE_LANGUAGES/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `src/config.ts` doesn't exist yet.

- [ ] **Step 4: Write the implementation**

`src/config.ts`:
```ts
export interface Config {
  port: number;
  dataDir: string;
  streamAddonUrl: string;
  jimakuApiKey: string;
  subtitleLanguages: string[];
  negativeCacheTtlHours: number;
  extractionConcurrency: number;
  extractionTimeoutMs: number;
  providerTimeoutMs: number;
  logLevel: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = requireEnv(env, name);
  try {
    new URL(value);
  } catch {
    throw new Error(`Environment variable ${name} is not a valid URL: ${value}`);
  }
  return value;
}

function requireInt(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} is not a valid integer: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const subtitleLanguages = (env.SUBTITLE_LANGUAGES ?? 'eng').split(',').map((s) => s.trim()).filter(Boolean);
  if (subtitleLanguages.length === 0) {
    throw new Error('SUBTITLE_LANGUAGES resolved to an empty list -- set at least one language or unset the variable to use the default (eng)');
  }

  return {
    port: requireInt(env, 'PORT', 7000),
    dataDir: env.DATA_DIR ?? '/data',
    streamAddonUrl: requireUrl(env, 'STREAM_ADDON_URL'),
    jimakuApiKey: requireEnv(env, 'JIMAKU_API_KEY'),
    subtitleLanguages,
    negativeCacheTtlHours: requireInt(env, 'NEGATIVE_CACHE_TTL_HOURS', 24),
    extractionConcurrency: requireInt(env, 'EXTRACTION_CONCURRENCY', 1),
    extractionTimeoutMs: requireInt(env, 'EXTRACTION_TIMEOUT_MS', 900000),
    providerTimeoutMs: requireInt(env, 'PROVIDER_TIMEOUT_MS', 8000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts test/config.test.ts package-lock.json
git commit -m "Add project scaffolding and env-var config loader"
```

---

### Task 2: Shared types + cache store

**Files:**
- Create: `src/types.ts`
- Create: `src/cache/cacheStore.ts`
- Test: `test/cache/cacheStore.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (`src/types.ts`): `CacheStatus = 'pending' | 'ready' | 'negative'`, `CacheKey { anilistId: number; episode: number; lang: string }`, `CacheEntry { status: CacheStatus; tier: 1|2|3|null; filePath: string|null; updatedAt: number }`, `ProviderResult { found: boolean; vttContent?: string }`, `SubtitleCandidate { lang: string; url: string }`.
- Produces (`src/cache/cacheStore.ts`): `class CacheStore` with `get`, `setPending`, `setReady`, `setNegative`, `isNegativeExpired`, `getInFlight`, `setInFlight`, `clearInFlight`, `close`.

- [ ] **Step 1: Write the failing test**

`test/cache/cacheStore.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write the implementation**

`src/types.ts`:
```ts
export type CacheStatus = 'pending' | 'ready' | 'negative';

export interface CacheKey {
  anilistId: number;
  episode: number;
  lang: string;
}

export interface CacheEntry {
  status: CacheStatus;
  tier: 1 | 2 | 3 | null;
  filePath: string | null;
  updatedAt: number;
}

export interface ProviderResult {
  found: boolean;
  vttContent?: string;
}

export interface SubtitleCandidate {
  lang: string;
  url: string;
}
```

`src/cache/cacheStore.ts`:
```ts
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
    writeFileSync(filePath, vttContent, 'utf-8');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cache/cacheStore.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/cache/cacheStore.ts test/cache/cacheStore.test.ts
git commit -m "Add shared types and SQLite-backed cache store"
```

---

### Task 3: ID resolver + anime cross-reference dataset

**Files:**
- Create: `src/resolver/animeDataset.ts`
- Create: `src/resolver/idResolver.ts`
- Modify: `src/types.ts` (add `ResolvedIds`)
- Test: `test/resolver/animeDataset.test.ts`
- Test: `test/resolver/idResolver.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (uses `better-sqlite3` directly, and adds `ResolvedIds` to `src/types.ts`).
- Produces: `class AnimeDataset` with static `buildFromRaw(raw: RawDataset, db: Database.Database): AnimeDataset`, instance `findByAnilistId(id: number)`, `findByScheme(scheme: 'kitsu'|'mal'|'anidb', id: number)`; `async function downloadDataset(): Promise<RawDataset>`; `function parseSubtitleRequestId(raw: string): { contentId: string; season: number; episode: number }`; `function resolveIds(contentId: string, dataset: AnimeDataset): ResolvedIds`.

- [ ] **Step 1: Write the failing tests**

`test/resolver/animeDataset.test.ts`:
```ts
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
```

`test/resolver/idResolver.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/resolver/`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write the implementation**

Add to `src/types.ts`:
```ts
export interface ResolvedIds {
  anilistId: number | null;
  anidbId: number | null;
}
```

`src/resolver/animeDataset.ts`:
```ts
import type Database from 'better-sqlite3';

export interface RawDatasetEntry {
  sources: string[];
}

export interface RawDataset {
  data: RawDatasetEntry[];
}

interface IdRow {
  anilistId: number | null;
  anidbId: number | null;
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
    db.exec(`
      DROP TABLE IF EXISTS anime_ids;
      CREATE TABLE anime_ids (
        anilist_id INTEGER,
        anidb_id INTEGER,
        kitsu_id INTEGER,
        mal_id INTEGER
      );
      CREATE INDEX idx_anilist ON anime_ids(anilist_id);
      CREATE INDEX idx_anidb ON anime_ids(anidb_id);
      CREATE INDEX idx_kitsu ON anime_ids(kitsu_id);
      CREATE INDEX idx_mal ON anime_ids(mal_id);
    `);
    const insert = db.prepare('INSERT INTO anime_ids (anilist_id, anidb_id, kitsu_id, mal_id) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((entries: RawDatasetEntry[]) => {
      for (const entry of entries) {
        const ids = extractIds(entry.sources);
        if (ids.anilistId === null && ids.anidbId === null && ids.kitsuId === null && ids.malId === null) continue;
        insert.run(ids.anilistId, ids.anidbId, ids.kitsuId, ids.malId);
      }
    });
    insertMany(raw.data);
    return new AnimeDataset(db);
  }

  findByAnilistId(id: number): IdRow | null {
    return (this.db.prepare('SELECT anilist_id as anilistId, anidb_id as anidbId FROM anime_ids WHERE anilist_id = ?').get(id) as IdRow) ?? null;
  }

  findByScheme(scheme: 'kitsu' | 'mal' | 'anidb', id: number): IdRow | null {
    const column = scheme === 'kitsu' ? 'kitsu_id' : scheme === 'mal' ? 'mal_id' : 'anidb_id';
    return (this.db.prepare(`SELECT anilist_id as anilistId, anidb_id as anidbId FROM anime_ids WHERE ${column} = ?`).get(id) as IdRow) ?? null;
  }
}

export async function downloadDataset(): Promise<RawDataset> {
  const url = 'https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database-minified.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download anime dataset: HTTP ${res.status}`);
  return (await res.json()) as RawDataset;
}
```

`src/resolver/idResolver.ts`:
```ts
import type { ResolvedIds } from '../types.js';
import type { AnimeDataset } from './animeDataset.js';

export interface ParsedSubtitleRequestId {
  contentId: string;
  season: number;
  episode: number;
}

export function parseSubtitleRequestId(raw: string): ParsedSubtitleRequestId {
  const parts = raw.split(':');
  if (parts.length < 3) throw new Error(`Malformed subtitle request id: ${raw}`);
  const episode = parseInt(parts.pop()!, 10);
  const season = parseInt(parts.pop()!, 10);
  const contentId = parts.join(':');
  if (Number.isNaN(episode) || Number.isNaN(season) || contentId === '') {
    throw new Error(`Malformed subtitle request id: ${raw}`);
  }
  return { contentId, season, episode };
}

export function resolveIds(contentId: string, dataset: AnimeDataset): ResolvedIds {
  const empty: ResolvedIds = { anilistId: null, anidbId: null };

  if (contentId.startsWith('tt')) {
    return empty; // no IMDb mapping in the dataset -- v1 scope limitation, see spec
  }

  const [scheme, valueStr] = contentId.split(':');
  const value = parseInt(valueStr, 10);
  if (Number.isNaN(value)) return empty;

  let row: ResolvedIds | null = null;
  if (scheme === 'anilist') row = dataset.findByAnilistId(value);
  else if (scheme === 'kitsu' || scheme === 'mal' || scheme === 'anidb') row = dataset.findByScheme(scheme, value);

  return row ?? empty;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/resolver/`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/resolver/animeDataset.ts src/resolver/idResolver.ts test/resolver/
git commit -m "Add anime id cross-reference dataset and subtitle-request id resolver"
```

---

### Task 4: HTTP client wrapper

**Files:**
- Create: `src/http/httpClient.ts`
- Test: `test/http/httpClient.test.ts`

**Interfaces:**
- Produces: `class HttpTimeoutError extends Error`; `async function fetchJson<T>(url: string, opts?: { headers?: Record<string,string>; timeoutMs?: number }): Promise<T>`; `async function fetchBuffer(url: string, opts?: same): Promise<Buffer>`.

- [ ] **Step 1: Write the failing test**

`test/http/httpClient.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchJson, fetchBuffer, HttpTimeoutError } from '../../src/http/httpClient.js';

describe('httpClient', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
      } else if (req.url === '/bytes') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.from([1, 2, 3]));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('too late'), 500);
      } else if (req.url === '/slow-body') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write(Buffer.from([1, 2]));
        setTimeout(() => res.end(Buffer.from([3, 4])), 500);
      } else if (req.url === '/error') {
        res.writeHead(500);
        res.end('boom');
      } else if (req.url === '/headers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: req.headers['authorization'] ?? null }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('fetches and parses JSON', async () => {
    expect(await fetchJson(`${baseUrl}/json`)).toEqual({ hello: 'world' });
  });

  it('passes custom headers through', async () => {
    const result = await fetchJson<{ auth: string }>(`${baseUrl}/headers`, { headers: { Authorization: 'Bearer xyz' } });
    expect(result.auth).toBe('Bearer xyz');
  });

  it('fetches raw bytes as a Buffer', async () => {
    const buf = await fetchBuffer(`${baseUrl}/bytes`);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  it('throws on a non-2xx response', async () => {
    await expect(fetchJson(`${baseUrl}/error`)).rejects.toThrow(/HTTP 500/);
  });

  it('throws HttpTimeoutError when the request exceeds timeoutMs', async () => {
    await expect(fetchJson(`${baseUrl}/slow`, { timeoutMs: 50 })).rejects.toThrow(HttpTimeoutError);
  });

  it('throws HttpTimeoutError when the response body stalls beyond timeoutMs', async () => {
    await expect(fetchBuffer(`${baseUrl}/slow-body`, { timeoutMs: 50 })).rejects.toThrow(HttpTimeoutError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/http/httpClient.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/http/httpClient.ts`:
```ts
export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpTimeoutError';
  }
}

async function timedFetch<T>(
  url: string,
  opts: FetchOptions,
  consume: (res: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    }
    return await consume(res);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new HttpTimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return timedFetch(url, opts, async (res) => (await res.json()) as T);
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<Buffer> {
  return timedFetch(url, opts, async (res) => Buffer.from(await res.arrayBuffer()));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/http/httpClient.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/http/httpClient.ts test/http/httpClient.test.ts
git commit -m "Add HTTP client wrapper with timeout support"
```

---

### Task 5: ffmpeg wrappers (probe + extract + local-file convert)

**Files:**
- Create: `src/ffmpeg/probe.ts`
- Create: `src/ffmpeg/extract.ts`
- Test: `test/ffmpeg/extract.test.ts`

**Interfaces:**
- Produces: `async function findSubtitleStreamIndex(sourceUrl: string, lang: string, timeoutMs?: number): Promise<number | null>`; `async function extractSubtitleToVtt(sourceUrl: string, streamIndex: number, timeoutMs?: number): Promise<string>`; `async function convertToVtt(inputContent: Buffer, inputExt: 'ass'|'srt', timeoutMs?: number): Promise<string>`.

**Prerequisite:** `ffmpeg` and `ffprobe` must be installed and on `PATH` in the dev/CI environment (they're already a hard runtime dependency of the project — see Task 14's Dockerfile).

- [ ] **Step 1: Write the failing test**

`test/ffmpeg/extract.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSubtitleStreamIndex } from '../../src/ffmpeg/probe.js';
import { extractSubtitleToVtt, convertToVtt } from '../../src/ffmpeg/extract.js';

describe('ffmpeg subtitle extraction (real ffmpeg/ffprobe subprocess)', () => {
  let dir: string;
  let mkvPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-fixture-'));
    const srtPath = join(dir, 'sample.srt');
    writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:02,000\nHello from a test fixture\n');
    mkvPath = join(dir, 'sample.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2',
      '-f', 'srt', '-i', srtPath,
      '-map', '0:v', '-map', '1:s',
      '-c:v', 'libx264', '-c:s', 'srt',
      '-metadata:s:s:0', 'language=eng',
      mkvPath,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the English subtitle stream index via ffprobe', async () => {
    expect(await findSubtitleStreamIndex(mkvPath, 'eng')).toBe(1);
  });

  it('returns null when no stream matches the requested language', async () => {
    expect(await findSubtitleStreamIndex(mkvPath, 'spa')).toBeNull();
  });

  it('extracts the subtitle stream as WebVTT containing the known text', async () => {
    const vtt = await extractSubtitleToVtt(mkvPath, 1);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Hello from a test fixture');
  });

  it('converts a standalone SRT buffer to WebVTT', async () => {
    const srtContent = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nStandalone conversion\n');
    const vtt = await convertToVtt(srtContent, 'srt');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Standalone conversion');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write the implementation**

`src/ffmpeg/probe.ts`:
```ts
import { spawn } from 'node:child_process';

interface FfprobeStream {
  index: number;
  tags?: { language?: string };
}
interface FfprobeOutput {
  streams: FfprobeStream[];
}

export function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`${command} exited with code ${code}: ${stderr}`)); return; }
      resolve(stdout);
    });
  });
}

export async function findSubtitleStreamIndex(sourceUrl: string, lang: string, timeoutMs = 30000): Promise<number | null> {
  const output = await runCommand('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 's', sourceUrl,
  ], timeoutMs);
  const parsed = JSON.parse(output) as FfprobeOutput;
  const match = parsed.streams.find((s) => s.tags?.language === lang);
  return match ? match.index : null;
}
```

`src/ffmpeg/extract.ts`:
```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`)); return; }
      resolve();
    });
  });
}

export async function extractSubtitleToVtt(sourceUrl: string, streamIndex: number, timeoutMs = 900000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'animesubs-extract-'));
  const outPath = join(dir, 'out.vtt');
  try {
    await runFfmpeg(['-v', 'error', '-i', sourceUrl, '-map', `0:${streamIndex}`, '-c:s', 'webvtt', outPath], timeoutMs);
    return readFileSync(outPath, 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function convertToVtt(inputContent: Buffer, inputExt: 'ass' | 'srt', timeoutMs = 30000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'animesubs-convert-'));
  const inPath = join(dir, `in.${inputExt}`);
  const outPath = join(dir, 'out.vtt');
  try {
    writeFileSync(inPath, inputContent);
    await runFfmpeg(['-v', 'error', '-i', inPath, outPath], timeoutMs);
    return readFileSync(outPath, 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ffmpeg/extract.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/probe.ts src/ffmpeg/extract.ts test/ffmpeg/extract.test.ts
git commit -m "Add ffprobe/ffmpeg subprocess wrappers for subtitle extraction"
```

---

### Task 6: xz decompression helper

**Files:**
- Create: `src/ffmpeg/xz.ts`
- Test: `test/ffmpeg/xz.test.ts`

**Interfaces:**
- Produces: `async function decompressXz(input: Buffer, timeoutMs?: number): Promise<Buffer>`.

**Prerequisite:** `xz` (xz-utils) must be installed and on `PATH`.

- [ ] **Step 1: Write the failing test**

`test/ffmpeg/xz.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { decompressXz } from '../../src/ffmpeg/xz.js';

describe('decompressXz', () => {
  it('decompresses real xz-compressed data back to the original bytes', async () => {
    const original = Buffer.from('[Script Info]\nTitle: test subtitle\n');
    const compressed = execFileSync('xz', ['-c'], { input: original });
    const result = await decompressXz(compressed);
    expect(result.toString('utf-8')).toBe(original.toString('utf-8'));
  });

  it('rejects when given non-xz data', async () => {
    await expect(decompressXz(Buffer.from('not xz data'))).rejects.toThrow(/exited with code/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ffmpeg/xz.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/ffmpeg/xz.ts`:
```ts
import { spawn } from 'node:child_process';

export function decompressXz(input: Buffer, timeoutMs = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('xz', ['-d', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`xz decompression timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`xz exited with code ${code}: ${stderr}`)); return; }
      resolve(Buffer.concat(chunks));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ffmpeg/xz.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg/xz.ts test/ffmpeg/xz.test.ts
git commit -m "Add xz decompression helper for AnimeTosho attachments"
```

---

### Task 7: Jimaku provider (tier 1)

**Files:**
- Create: `src/providers/jimakuProvider.ts`
- Test: `test/providers/jimakuProvider.test.ts`

**Interfaces:**
- Consumes: `fetchJson` from `src/http/httpClient.js` (Task 4), `convertToVtt` from `src/ffmpeg/extract.js` (Task 5), `ProviderResult` from `src/types.js` (Task 2).
- Produces: `interface JimakuOptions { baseUrl?: string; timeoutMs?: number }` and `async function findJimakuSubtitle(anilistId: number, episode: number, lang: string, apiKey: string, opts?: JimakuOptions): Promise<ProviderResult>`. The optional tail is a single options object (not separate positional params) specifically so `timeoutMs` can be added here and threaded through from `Config.providerTimeoutMs` in Task 12 without colliding positionally with `baseUrl`.

**Verified contract** (from Jimaku's live OpenAPI spec at `/api/openapi.json`): `GET {baseUrl}/api/entries/search?anilist_id={id}` with header `Authorization: {apiKey}` returns `Entry[]` (`{ id, flags: { anime, adult, ... } }`); `GET {baseUrl}/api/entries/{entryId}/files?episode={n}` returns `FileEntry[]` (`{ name, url, ... }`) with **no language field** — language must be inferred from `name` by convention.

- [ ] **Step 1: Write the failing test**

`test/providers/jimakuProvider.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { findJimakuSubtitle } from '../../src/providers/jimakuProvider.js';

describe('findJimakuSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let receivedAuth: string | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      receivedAuth = req.headers['authorization'] ?? null;

      if (url.pathname === '/api/entries/search' && url.searchParams.get('anilist_id') === '154587') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, flags: { anime: true, adult: false } }]));
      } else if (url.pathname === '/api/entries/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      } else if (url.pathname === '/api/entries/1/files' && url.searchParams.get('episode') === '5') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'Show - 05 (Japanese).ass', url: `http://ignored/jpn.ass` },
          { name: 'Show - 05 [English].srt', url: `${baseUrl}/files/english.srt` },
        ]));
      } else if (url.pathname === '/api/entries/1/files') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      } else if (url.pathname === '/files/english.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nJimaku fixture line\n');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('finds an English file by filename heuristic, converts it, and sends the API key header', async () => {
    const result = await findJimakuSubtitle(154587, 5, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('Jimaku fixture line');
    expect(receivedAuth).toBe('test-key');
  });

  it('returns not found when no entry matches the anilist id', async () => {
    const result = await findJimakuSubtitle(999999, 5, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(false);
  });

  it('returns not found when the episode has no English-matching file', async () => {
    const result = await findJimakuSubtitle(154587, 99, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(false);
  });

  it('applies a custom timeoutMs to outbound requests', async () => {
    const result = await findJimakuSubtitle(154587, 5, 'eng', 'test-key', { baseUrl, timeoutMs: 5000 });
    expect(result.found).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/jimakuProvider.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/providers/jimakuProvider.ts`:
```ts
import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import type { ProviderResult } from '../types.js';

interface JimakuEntry {
  id: number;
  flags: { anime: boolean; adult: boolean };
}
interface JimakuFile {
  name: string;
  url: string;
}

const LANGUAGE_TOKENS: Record<string, RegExp> = {
  eng: /\b(english|eng)\b|\[en\]/i,
};
const SUBTITLE_EXTENSIONS = /\.(srt|ass|vtt)$/i;
const EXCLUDED_LANGUAGE_TOKENS = /\b(japanese|jpn|jp)\b/i;

function matchesLanguage(filename: string, lang: string): boolean {
  if (!SUBTITLE_EXTENSIONS.test(filename)) return false;
  if (EXCLUDED_LANGUAGE_TOKENS.test(filename)) return false;
  const pattern = LANGUAGE_TOKENS[lang];
  return pattern ? pattern.test(filename) : false;
}

function extToVttInput(filename: string): 'ass' | 'srt' | null {
  if (/\.ass$/i.test(filename)) return 'ass';
  if (/\.srt$/i.test(filename)) return 'srt';
  return null;
}

export interface JimakuOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export async function findJimakuSubtitle(
  anilistId: number,
  episode: number,
  lang: string,
  apiKey: string,
  opts: JimakuOptions = {},
): Promise<ProviderResult> {
  const baseUrl = opts.baseUrl ?? 'https://jimaku.cc';
  const timeoutMs = opts.timeoutMs ?? 8000;

  const entries = await fetchJson<JimakuEntry[]>(
    `${baseUrl}/api/entries/search?anilist_id=${anilistId}`,
    { headers: { Authorization: apiKey }, timeoutMs },
  );
  const entry = entries.find((e) => e.flags.anime && !e.flags.adult);
  if (!entry) return { found: false };

  const files = await fetchJson<JimakuFile[]>(
    `${baseUrl}/api/entries/${entry.id}/files?episode=${episode}`,
    { headers: { Authorization: apiKey }, timeoutMs },
  );
  const match = files.find((f) => matchesLanguage(f.name, lang));
  if (!match) return { found: false };

  const ext = extToVttInput(match.name);
  if (!ext) return { found: false };

  const raw = await fetchBuffer(match.url, { timeoutMs });
  const vttContent = ext === 'vtt' ? raw.toString('utf-8') : await convertToVtt(raw, ext);
  return { found: true, vttContent };
}
```

Note: the test fixture uses a `.srt` file, so `extToVttInput` always returns `'srt'` in this test; the `ext === 'vtt'` branch exists to pass a plain-text `.vtt` match straight through without invoking ffmpeg.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/jimakuProvider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/jimakuProvider.ts test/providers/jimakuProvider.test.ts
git commit -m "Add Jimaku provider (tier 1)"
```

---

### Task 8: AnimeTosho provider (tier 2)

**Files:**
- Create: `src/providers/animetoshoProvider.ts`
- Test: `test/providers/animetoshoProvider.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `fetchBuffer` (Task 4); `decompressXz` (Task 6); `convertToVtt` (Task 5); `ProviderResult` (Task 2).
- Produces: `interface AnimeToshoOptions { feedBaseUrl?: string; storageBaseUrl?: string; timeoutMs?: number }` and `async function findAnimeToshoSubtitle(anidbId: number, episode: number, lang: string, opts?: AnimeToshoOptions): Promise<ProviderResult>`. Same options-object pattern as Task 7's `JimakuOptions`, for the same reason.

**Verified contract** (confirmed live end-to-end against a real release): `GET {feedBaseUrl}/json?t=search&aid={anidbId}&limit=50` → torrent summaries `{ id, title, status, num_files }`; `GET {feedBaseUrl}/json?show=torrent&id={id}` → `{ files: [{ filename, attachments: [{ id, type, info: { codec, lang, tracknum } }] }] | null }`; download URL is `{storageBaseUrl}/storage/attach/{id.toString(16).padStart(8,'0')}/{encodeURIComponent(filenameWithoutExt + '_track' + tracknum + '.' + lang + '.' + codec.toLowerCase() + '.xz')}`, 301-redirects, body is xz-compressed subtitle text.

- [ ] **Step 1: Write the failing test**

`test/providers/animetoshoProvider.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { findAnimeToshoSubtitle } from '../../src/providers/animetoshoProvider.js';

describe('findAnimeToshoSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let compressedSubtitle: Buffer;
  const expectedPath = '/storage/attach/002b205c/%5BGroup%5D%20Show%20-%2005%20(1080p)%20%5BABCD1234%5D_track3.eng.ass.xz';

  beforeAll(async () => {
    compressedSubtitle = execFileSync('xz', ['-c'], { input: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nAnimeTosho fixture line\n') });

    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/json' && url.searchParams.get('t') === 'search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { id: 1, title: '[Group] Show - 05 (1080p) [ABCD1234].mkv', status: 'complete', num_files: 1 },
          { id: 2, title: '[Group] Show (Batch S01)', status: 'skipped', num_files: 12 },
        ]));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 05 (1080p) [ABCD1234].mkv',
            attachments: [
              { id: 42, type: 'font', info: {} },
              { id: 2826332, type: 'subtitle', info: { codec: 'ASS', lang: 'eng', tracknum: 3 } },
            ],
          }],
        }));
      } else if (url.pathname === expectedPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedSubtitle);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('finds, downloads, decompresses, and converts the matching episode subtitle', async () => {
    const result = await findAnimeToshoSubtitle(18886, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('AnimeTosho fixture line');
  });

  it('returns not found when no episode in the search results matches', async () => {
    const result = await findAnimeToshoSubtitle(18886, 99, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
  });

  it('skips batch releases (num_files > 1) even if the title parses to the right episode', async () => {
    const result = await findAnimeToshoSubtitle(18886, 1, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/providers/animetoshoProvider.ts`:
```ts
import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { decompressXz } from '../ffmpeg/xz.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import type { ProviderResult } from '../types.js';

interface ToshoSearchResult {
  id: number;
  title: string;
  status: string;
  num_files: number;
}
interface ToshoAttachment {
  id: number;
  type: string;
  info?: { codec?: string; lang?: string; tracknum?: number };
}
interface ToshoFile {
  filename: string;
  attachments: ToshoAttachment[];
}
interface ToshoTorrentDetail {
  files: ToshoFile[] | null;
}

const EPISODE_PATTERNS = [/S\d{1,2}E(\d{1,4})/i, /-\s*(\d{1,4})\s*\(/, /-\s*(\d{1,4})\s*$/];

function parseEpisodeNumber(title: string): number | null {
  for (const pattern of EPISODE_PATTERNS) {
    const match = title.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

function buildAttachmentUrl(storageBaseUrl: string, attachmentId: number, videoFilename: string, tracknum: number, lang: string, codec: string): string {
  const id8 = attachmentId.toString(16).padStart(8, '0');
  const stem = videoFilename.replace(/\.[^.]+$/, '');
  const name = `${stem}_track${tracknum}.${lang}.${codec.toLowerCase()}.xz`;
  return `${storageBaseUrl}/storage/attach/${id8}/${encodeURIComponent(name)}`;
}

export interface AnimeToshoOptions {
  feedBaseUrl?: string;
  storageBaseUrl?: string;
  timeoutMs?: number;
}

export async function findAnimeToshoSubtitle(
  anidbId: number,
  episode: number,
  lang: string,
  opts: AnimeToshoOptions = {},
): Promise<ProviderResult> {
  const feedBaseUrl = opts.feedBaseUrl ?? 'https://feed.animetosho.org';
  const storageBaseUrl = opts.storageBaseUrl ?? 'https://animetosho.org';
  const timeoutMs = opts.timeoutMs ?? 8000;

  const results = await fetchJson<ToshoSearchResult[]>(`${feedBaseUrl}/json?t=search&aid=${anidbId}&limit=50`, { timeoutMs });

  const candidates = results.filter((r) => r.status === 'complete' && r.num_files === 1 && parseEpisodeNumber(r.title) === episode);

  for (const candidate of candidates) {
    const detail = await fetchJson<ToshoTorrentDetail>(`${feedBaseUrl}/json?show=torrent&id=${candidate.id}`, { timeoutMs });
    if (!detail.files) continue;

    for (const file of detail.files) {
      const attachment = file.attachments.find((a) => a.type === 'subtitle' && a.info?.lang === lang);
      if (!attachment?.info?.codec || attachment.info.tracknum === undefined) continue;

      const url = buildAttachmentUrl(storageBaseUrl, attachment.id, file.filename, attachment.info.tracknum, lang, attachment.info.codec);
      const compressed = await fetchBuffer(url, { timeoutMs });
      const decompressed = await decompressXz(compressed);
      const ext = attachment.info.codec.toLowerCase() === 'ass' ? 'ass' : 'srt';
      const vttContent = await convertToVtt(decompressed, ext);
      return { found: true, vttContent };
    }
  }

  return { found: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/animetoshoProvider.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/animetoshoProvider.ts test/providers/animetoshoProvider.test.ts
git commit -m "Add AnimeTosho provider (tier 2)"
```

---

### Task 9: Stream addon client

**Files:**
- Create: `src/providers/streamAddonClient.ts`
- Test: `test/providers/streamAddonClient.test.ts`

**Interfaces:**
- Consumes: `fetchJson` (Task 4).
- Produces: `async function getBestStreamUrl(streamAddonManifestUrl: string, contentId: string, season: number, episode: number, opts?: { timeoutMs?: number }): Promise<string | null>` — returns the first stream with a playable `url` field, skipping `infoHash`-only entries. `opts.timeoutMs` defaults to 8000 and is how Task 11 threads `Config.providerTimeoutMs` through.

- [ ] **Step 1: Write the failing test**

`test/providers/streamAddonClient.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { getBestStreamUrl } from '../../src/providers/streamAddonClient.js';

describe('getBestStreamUrl', () => {
  let server: Server;
  let manifestUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/stream/series/kitsu:50350:1:1.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          streams: [
            { infoHash: 'deadbeef', name: 'unresolved torrent' },
            { url: 'https://debrid.example.com/direct/episode1.mkv', name: '1080p debrid' },
          ],
        }));
      } else if (req.url === '/stream/series/kitsu:50350:1:2.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [{ infoHash: 'onlyatorrent' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    manifestUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/manifest.json`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('skips an infoHash-only entry and returns the first directly playable url', async () => {
    expect(await getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 1)).toBe('https://debrid.example.com/direct/episode1.mkv');
  });

  it('returns null when every stream is infoHash-only (unresolved torrent)', async () => {
    expect(await getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/streamAddonClient.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/providers/streamAddonClient.ts`:
```ts
import { fetchJson } from '../http/httpClient.js';

interface StremioStream {
  url?: string;
  infoHash?: string;
}
interface StreamResponse {
  streams: StremioStream[];
}

function buildStreamRequestUrl(manifestUrl: string, requestId: string): string {
  const base = manifestUrl.replace(/manifest\.json$/, '');
  return `${base}stream/series/${requestId}.json`;
}

export async function getBestStreamUrl(
  streamAddonManifestUrl: string,
  contentId: string,
  season: number,
  episode: number,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const requestId = `${contentId}:${season}:${episode}`;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const response = await fetchJson<StreamResponse>(buildStreamRequestUrl(streamAddonManifestUrl, requestId), { timeoutMs });
  const playable = response.streams.find((s) => typeof s.url === 'string' && s.url.length > 0);
  return playable?.url ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/streamAddonClient.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/streamAddonClient.ts test/providers/streamAddonClient.test.ts
git commit -m "Add stream addon client, preferring debrid-resolved playable streams"
```

---

### Task 10: Extraction queue

**Files:**
- Create: `src/queue/extractionQueue.ts`
- Test: `test/queue/extractionQueue.test.ts`

**Interfaces:**
- Produces: `class ExtractionQueue { constructor(concurrency: number); run<T>(fn: () => Promise<T>): Promise<T>; }`.

- [ ] **Step 1: Write the failing test**

`test/queue/extractionQueue.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ExtractionQueue } from '../../src/queue/extractionQueue.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('ExtractionQueue', () => {
  it('runs a job immediately while under the concurrency limit', async () => {
    const queue = new ExtractionQueue(2);
    expect(await queue.run(async () => 42)).toBe(42);
  });

  it('queues a job beyond the concurrency limit until a slot frees up', async () => {
    const queue = new ExtractionQueue(1);
    const order: string[] = [];
    const first = deferred<void>();

    const jobA = queue.run(async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    await new Promise((r) => setTimeout(r, 10));

    const jobB = queue.run(async () => { order.push('b-start'); });

    expect(order).toEqual(['a-start']);
    first.resolve();
    await Promise.all([jobA, jobB]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('propagates a rejected job without blocking the next one', async () => {
    const queue = new ExtractionQueue(1);
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await queue.run(async () => 'still works')).toBe('still works');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/queue/extractionQueue.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/queue/extractionQueue.ts`:
```ts
export class ExtractionQueue {
  private concurrency: number;
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/queue/extractionQueue.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/queue/extractionQueue.ts test/queue/extractionQueue.test.ts
git commit -m "Add concurrency-limited extraction queue"
```

---

### Task 11: Extraction provider (tier 3)

**Files:**
- Create: `src/providers/extractionProvider.ts`
- Test: `test/providers/extractionProvider.test.ts`

**Interfaces:**
- Consumes: `getBestStreamUrl` (Task 9), `findSubtitleStreamIndex` (Task 5), `extractSubtitleToVtt` (Task 5), `ExtractionQueue` (Task 10), `ProviderResult` (Task 2).
- Produces: `export interface ExtractionParams { streamAddonUrl: string; contentId: string; season: number; episode: number; lang: string; queue: ExtractionQueue; extractionTimeoutMs: number; providerTimeoutMs: number; }` and `async function runExtractionTier(params: ExtractionParams): Promise<ProviderResult>`. `providerTimeoutMs` bounds the initial stream-addon lookup call (via `getBestStreamUrl`'s `opts.timeoutMs`); `extractionTimeoutMs` bounds the much longer ffprobe/ffmpeg subprocess calls. These are deliberately separate fields — conflating them would force the stream-addon HTTP call to wait up to 15 minutes instead of failing fast.

- [ ] **Step 1: Write the failing test**

`test/providers/extractionProvider.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtractionTier } from '../../src/providers/extractionProvider.js';
import { ExtractionQueue } from '../../src/queue/extractionQueue.js';

describe('runExtractionTier (real ffmpeg against a remote HTTP stream)', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let mkvBytes: Buffer;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-extraction-fixture-'));
    const srtPath = join(dir, 'sample.srt');
    writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:02,000\nRemote extraction fixture\n');
    const mkvPath = join(dir, 'sample.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2',
      '-f', 'srt', '-i', srtPath,
      '-map', '0:v', '-map', '1:s',
      '-c:v', 'libx264', '-c:s', 'srt',
      '-metadata:s:s:0', 'language=eng',
      mkvPath,
    ]);
    mkvBytes = readFileSync(mkvPath);

    server = createServer((req, res) => {
      if (req.url === '/stream/series/kitsu:1:1:1.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [{ url: `${baseUrl}/video.mkv` }] }));
      } else if (req.url === '/stream/series/kitsu:1:1:2.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [] }));
      } else if (req.url === '/video.mkv') {
        res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes' });
        res.end(mkvBytes);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('finds a stream, extracts its embedded English subtitle, and returns WebVTT', async () => {
    const result = await runExtractionTier({
      streamAddonUrl: `${baseUrl}/manifest.json`,
      contentId: 'kitsu:1',
      season: 1,
      episode: 1,
      lang: 'eng',
      queue: new ExtractionQueue(1),
      extractionTimeoutMs: 30000,
      providerTimeoutMs: 8000,
    });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Remote extraction fixture');
  });

  it('returns not found when the stream addon has nothing playable', async () => {
    const result = await runExtractionTier({
      streamAddonUrl: `${baseUrl}/manifest.json`,
      contentId: 'kitsu:1',
      season: 1,
      episode: 2,
      lang: 'eng',
      queue: new ExtractionQueue(1),
      extractionTimeoutMs: 30000,
      providerTimeoutMs: 8000,
    });
    expect(result.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/extractionProvider.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/providers/extractionProvider.ts`:
```ts
import { getBestStreamUrl } from './streamAddonClient.js';
import { findSubtitleStreamIndex } from '../ffmpeg/probe.js';
import { extractSubtitleToVtt } from '../ffmpeg/extract.js';
import type { ExtractionQueue } from '../queue/extractionQueue.js';
import type { ProviderResult } from '../types.js';

export interface ExtractionParams {
  streamAddonUrl: string;
  contentId: string;
  season: number;
  episode: number;
  lang: string;
  queue: ExtractionQueue;
  extractionTimeoutMs: number;
  providerTimeoutMs: number;
}

export async function runExtractionTier(params: ExtractionParams): Promise<ProviderResult> {
  const streamUrl = await getBestStreamUrl(
    params.streamAddonUrl, params.contentId, params.season, params.episode,
    { timeoutMs: params.providerTimeoutMs },
  );
  if (!streamUrl) return { found: false };

  return params.queue.run(async () => {
    const streamIndex = await findSubtitleStreamIndex(streamUrl, params.lang, params.extractionTimeoutMs);
    if (streamIndex === null) return { found: false };
    const vttContent = await extractSubtitleToVtt(streamUrl, streamIndex, params.extractionTimeoutMs);
    return { found: true, vttContent };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/extractionProvider.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/providers/extractionProvider.ts test/providers/extractionProvider.test.ts
git commit -m "Add extraction provider (tier 3), queued and network-verified end to end"
```

---

### Task 12: Subtitles request handler (orchestration)

**Files:**
- Create: `src/subtitlesHandler.ts`
- Test: `test/subtitlesHandler.test.ts`

**Interfaces:**
- Consumes: `parseSubtitleRequestId`, `resolveIds` (Task 3); `AnimeDataset` (Task 3); `CacheStore` (Task 2); `ExtractionQueue` (Task 10); `Config` (Task 1); `CacheKey`, `ProviderResult`, `SubtitleCandidate` (Task 2); `ExtractionParams` (Task 11).
- Produces: `export interface DatasetHolder { current: AnimeDataset; }`, defined directly in `src/subtitlesHandler.ts` (not `src/types.ts` — only this handler and its Task 13 caller need it); `export interface SubtitlesHandlerDeps { dataset: DatasetHolder; cache: CacheStore; queue: ExtractionQueue; config: Config; buildSubtitleUrl: (key: CacheKey) => string; jimakuProvider: (anilistId: number, episode: number, lang: string, apiKey: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>; animetoshoProvider: (anidbId: number, episode: number, lang: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>; extractionProvider: (params: ExtractionParams) => Promise<ProviderResult>; }`; `async function handleSubtitlesRequest(rawId: string, deps: SubtitlesHandlerDeps): Promise<{ subtitles: SubtitleCandidate[] }>`. The provider deps' trailing `opts` parameter is how `Config.providerTimeoutMs` reaches Tasks 7/8/9's HTTP calls — see Task 7/8/9/11's options-object interfaces.

The provider functions are injected (not imported directly) specifically so this task's tests never make a real network/ffmpeg call — they test orchestration logic only. Task 13 wires the real `findJimakuSubtitle`/`findAnimeToshoSubtitle`/`runExtractionTier` in.

- [ ] **Step 1: Write the failing test**

`test/subtitlesHandler.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import { CacheStore } from '../src/cache/cacheStore.js';
import { ExtractionQueue } from '../src/queue/extractionQueue.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from '../src/subtitlesHandler.js';
import type { Config } from '../src/config.js';

const dataset = AnimeDataset.buildFromRaw({
  data: [{ sources: ['https://anidb.net/anime/17617', 'https://anilist.co/anime/154587', 'https://kitsu.app/anime/46474'] }],
}, new Database(':memory:'));

const baseConfig: Config = {
  port: 7000, dataDir: '/tmp', streamAddonUrl: 'https://stream.example.com/manifest.json',
  jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
  extractionConcurrency: 1, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, logLevel: 'info',
};

describe('handleSubtitlesRequest', () => {
  let dir: string;
  let cache: CacheStore;
  let deps: SubtitlesHandlerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-handler-'));
    cache = new CacheStore(join(dir, 'cache.db'), join(dir, 'files'));
    deps = {
      dataset: { current: dataset },
      cache,
      queue: new ExtractionQueue(1),
      config: baseConfig,
      buildSubtitleUrl: (key) => `https://addon.example.com/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
      jimakuProvider: vi.fn(async () => ({ found: false })),
      animetoshoProvider: vi.fn(async () => ({ found: false })),
      extractionProvider: vi.fn(async () => ({ found: false })),
    };
  });

  afterEach(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty list for an unresolvable content id', async () => {
    expect((await handleSubtitlesRequest('tt99999:1:1', deps)).subtitles).toEqual([]);
  });

  it('returns a tier-1 (Jimaku) hit and caches it', async () => {
    deps.jimakuProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\njimaku hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([{ lang: 'eng', url: 'https://addon.example.com/vtt/154587/5/eng.vtt' }]);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('ready');
  });

  it('falls through to tier 2 (AnimeTosho) when tier 1 finds nothing', async () => {
    deps.animetoshoProvider = vi.fn(async () => ({ found: true, vttContent: 'WEBVTT\n\n1\ntosho hit' }));
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.tier).toBe(2);
  });

  it('starts a background extraction and returns a placeholder entry when tiers 1-2 find nothing', async () => {
    let resolveExtraction!: (r: { found: boolean; vttContent?: string }) => void;
    deps.extractionProvider = vi.fn(() => new Promise((resolve) => { resolveExtraction = resolve; }));

    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toHaveLength(1);
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('pending');

    resolveExtraction({ found: true, vttContent: 'WEBVTT\n\n1\nextracted' });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get({ anilistId: 154587, episode: 5, lang: 'eng' })?.status).toBe('ready');
  });

  it('does not start a second extraction job while one is already in flight', async () => {
    deps.extractionProvider = vi.fn(() => new Promise(() => {}));
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(deps.extractionProvider).toHaveBeenCalledTimes(1);
  });

  it('skips a request whose negative cache entry has not expired', async () => {
    cache.setNegative({ anilistId: 154587, episode: 5, lang: 'eng' });
    const result = await handleSubtitlesRequest('kitsu:46474:1:5', deps);
    expect(result.subtitles).toEqual([]);
    expect(deps.jimakuProvider).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

`src/subtitlesHandler.ts`:
```ts
import { parseSubtitleRequestId, resolveIds } from './resolver/idResolver.js';
import type { AnimeDataset } from './resolver/animeDataset.js';
import type { CacheStore } from './cache/cacheStore.js';
import type { ExtractionQueue } from './queue/extractionQueue.js';
import type { Config } from './config.js';
import type { CacheKey, ProviderResult, SubtitleCandidate } from './types.js';
import type { ExtractionParams } from './providers/extractionProvider.js';

export interface DatasetHolder {
  current: AnimeDataset;
}

export interface SubtitlesHandlerDeps {
  dataset: DatasetHolder;
  cache: CacheStore;
  queue: ExtractionQueue;
  config: Config;
  buildSubtitleUrl: (key: CacheKey) => string;
  jimakuProvider: (anilistId: number, episode: number, lang: string, apiKey: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>;
  animetoshoProvider: (anidbId: number, episode: number, lang: string, opts?: { timeoutMs?: number }) => Promise<ProviderResult>;
  extractionProvider: (params: ExtractionParams) => Promise<ProviderResult>;
}

export async function handleSubtitlesRequest(
  rawId: string,
  deps: SubtitlesHandlerDeps,
): Promise<{ subtitles: SubtitleCandidate[] }> {
  const parsed = parseSubtitleRequestId(rawId);
  const ids = resolveIds(parsed.contentId, deps.dataset.current);
  if (ids.anilistId === null) return { subtitles: [] };
  const anilistId = ids.anilistId;

  const subtitles: SubtitleCandidate[] = [];
  for (const lang of deps.config.subtitleLanguages) {
    const key: CacheKey = { anilistId, episode: parsed.episode, lang };
    const included = await resolveOneLanguage(key, ids.anidbId, parsed, deps);
    if (included) subtitles.push({ lang, url: deps.buildSubtitleUrl(key) });
  }
  return { subtitles };
}

async function resolveOneLanguage(
  key: CacheKey,
  anidbId: number | null,
  parsed: { contentId: string; season: number; episode: number },
  deps: SubtitlesHandlerDeps,
): Promise<boolean> {
  const cached = deps.cache.get(key);
  if (cached?.status === 'ready' || cached?.status === 'pending') return true;
  if (cached?.status === 'negative' && !deps.cache.isNegativeExpired(cached, deps.config.negativeCacheTtlHours)) {
    return false;
  }

  if (await tryFastTiers(key, anidbId, deps)) return true;

  startExtractionInBackground(key, parsed, deps);
  return true;
}

async function tryFastTiers(key: CacheKey, anidbId: number | null, deps: SubtitlesHandlerDeps): Promise<boolean> {
  const timeoutOpts = { timeoutMs: deps.config.providerTimeoutMs };
  try {
    const jimaku = await deps.jimakuProvider(key.anilistId, key.episode, key.lang, deps.config.jimakuApiKey, timeoutOpts);
    if (jimaku.found && jimaku.vttContent) {
      deps.cache.setReady(key, 1, jimaku.vttContent);
      return true;
    }
  } catch {
    // isolated failure -- fall through to the next tier
  }

  if (anidbId !== null) {
    try {
      const tosho = await deps.animetoshoProvider(anidbId, key.episode, key.lang, timeoutOpts);
      if (tosho.found && tosho.vttContent) {
        deps.cache.setReady(key, 2, tosho.vttContent);
        return true;
      }
    } catch {
      // isolated failure -- fall through to the next tier
    }
  }

  return false;
}

function startExtractionInBackground(
  key: CacheKey,
  parsed: { contentId: string; season: number; episode: number },
  deps: SubtitlesHandlerDeps,
): void {
  if (deps.cache.getInFlight(key)) return;

  deps.cache.setPending(key);
  const job = deps.extractionProvider({
    streamAddonUrl: deps.config.streamAddonUrl,
    contentId: parsed.contentId,
    season: parsed.season,
    episode: parsed.episode,
    lang: key.lang,
    queue: deps.queue,
    extractionTimeoutMs: deps.config.extractionTimeoutMs,
    providerTimeoutMs: deps.config.providerTimeoutMs,
  })
    .then((result) => {
      if (result.found && result.vttContent) {
        deps.cache.setReady(key, 3, result.vttContent);
      } else {
        deps.cache.setNegative(key);
      }
      return result;
    })
    .catch(() => {
      deps.cache.setNegative(key);
      return { found: false } as ProviderResult;
    })
    .finally(() => deps.cache.clearInFlight(key));

  deps.cache.setInFlight(key, job);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/subtitlesHandler.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/subtitlesHandler.ts test/subtitlesHandler.test.ts
git commit -m "Add subtitles request handler orchestrating the three-tier chain"
```

---

### Task 13: Express server, manifest, and startup wiring

**Files:**
- Create: `src/manifest.ts`
- Create: `src/server.ts`
- Create: `src/index.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-12 (`loadConfig`, `AnimeDataset`/`downloadDataset`, `CacheStore`, `ExtractionQueue`, `handleSubtitlesRequest`/`SubtitlesHandlerDeps`/`DatasetHolder`, `findJimakuSubtitle`, `findAnimeToshoSubtitle`, `runExtractionTier`).
- Produces: `export const manifest`; `export function createServer(handlerDeps: SubtitlesHandlerDeps, cache: CacheStore): Express`; `src/index.ts` as the process entrypoint (not unit tested directly — it's exercised by running the built image in Task 14).

- [ ] **Step 1: Write the failing test**

`test/server.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { CacheStore } from '../src/cache/cacheStore.js';
import { ExtractionQueue } from '../src/queue/extractionQueue.js';
import { AnimeDataset } from '../src/resolver/animeDataset.js';
import type { Config } from '../src/config.js';

describe('HTTP contract', () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;
  let cache: CacheStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-server-'));
    cache = new CacheStore(join(dir, 'cache.db'), join(dir, 'files'));
    const dataset = AnimeDataset.buildFromRaw({
      data: [{ sources: ['https://anilist.co/anime/154587', 'https://anidb.net/anime/17617'] }],
    }, new Database(':memory:'));

    const config: Config = {
      port: 0, dataDir: dir, streamAddonUrl: 'https://stream.example.com/manifest.json',
      jimakuApiKey: 'key', subtitleLanguages: ['eng'], negativeCacheTtlHours: 24,
      extractionConcurrency: 1, extractionTimeoutMs: 1000, providerTimeoutMs: 1000, logLevel: 'info',
    };

    const app = createServer({
      dataset: { current: dataset },
      cache,
      queue: new ExtractionQueue(1),
      config,
      buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
      jimakuProvider: async () => ({ found: false }),
      animetoshoProvider: async () => ({ found: false }),
      extractionProvider: async () => ({ found: false }),
    }, cache);

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves a manifest with the fields Stremio requires', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'org.animesubs', resources: ['subtitles'], types: ['series'] });
  });

  it('returns an empty subtitles array for an unresolvable id', async () => {
    const res = await fetch(`${baseUrl}/subtitles/series/kitsu:999999:1:1.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subtitles: [] });
  });

  it('serves a cached ready vtt file with the right content type', async () => {
    cache.setReady({ anilistId: 154587, episode: 5, lang: 'eng' }, 2, 'WEBVTT\n\n1\nhello');
    const res = await fetch(`${baseUrl}/vtt/154587/5/eng.vtt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/vtt');
    expect(await res.text()).toContain('hello');
  });

  it('serves a placeholder vtt for a pending entry', async () => {
    cache.setPending({ anilistId: 154587, episode: 6, lang: 'eng' });
    const res = await fetch(`${baseUrl}/vtt/154587/6/eng.vtt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Extracting subtitles');
  });

  it('returns 404 with a placeholder vtt body for an entirely unknown key', async () => {
    const res = await fetch(`${baseUrl}/vtt/1/1/eng.vtt`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Write the implementation**

`src/manifest.ts`:
```ts
export const manifest = {
  id: 'org.animesubs',
  version: '1.0.0',
  name: 'AnimeSubs',
  description: 'Tiered anime subtitle resolver: Jimaku and AnimeTosho first, embedded-track extraction from your own stream addon as a fallback when nothing else has anything.',
  resources: ['subtitles'],
  types: ['series'],
  idPrefixes: ['kitsu', 'mal', 'anidb', 'anilist'],
  catalogs: [],
  behaviorHints: { configurable: false },
};
```

`src/server.ts`:
```ts
import express, { type Express } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { manifest } from './manifest.js';
import { handleSubtitlesRequest, type SubtitlesHandlerDeps } from './subtitlesHandler.js';
import type { CacheStore } from './cache/cacheStore.js';

export function createServer(handlerDeps: SubtitlesHandlerDeps, cache: CacheStore): Express {
  const app = express();

  app.get('/manifest.json', (_req, res) => {
    res.json(manifest);
  });

  app.get('/subtitles/series/:id.json', async (req, res) => {
    try {
      res.json(await handleSubtitlesRequest(req.params.id, handlerDeps));
    } catch (err) {
      res.status(500).json({ subtitles: [], error: (err as Error).message });
    }
  });

  app.get('/vtt/:anilistId/:episode/:lang.vtt', (req, res) => {
    const key = {
      anilistId: parseInt(req.params.anilistId, 10),
      episode: parseInt(req.params.episode, 10),
      lang: req.params.lang,
    };
    const entry = cache.get(key);
    res.type('text/vtt');

    if (entry?.status === 'ready' && entry.filePath && existsSync(entry.filePath)) {
      res.send(readFileSync(entry.filePath, 'utf-8'));
      return;
    }
    if (entry?.status === 'pending') {
      res.send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nExtracting subtitles -- reselect this track in about a minute.\n');
      return;
    }
    res.status(404).send('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nNo subtitle available.\n');
  });

  return app;
}
```

`src/index.ts`:
```ts
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { AnimeDataset, downloadDataset } from './resolver/animeDataset.js';
import { CacheStore } from './cache/cacheStore.js';
import { ExtractionQueue } from './queue/extractionQueue.js';
import { createServer } from './server.js';
import { findJimakuSubtitle } from './providers/jimakuProvider.js';
import { findAnimeToshoSubtitle } from './providers/animetoshoProvider.js';
import { runExtractionTier } from './providers/extractionProvider.js';
import type { DatasetHolder } from './subtitlesHandler.js';

const DATASET_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main() {
  const config = loadConfig();

  const datasetDb = new Database(join(config.dataDir, 'anime-dataset.db'));
  const datasetHolder: DatasetHolder = { current: AnimeDataset.buildFromRaw(await downloadDataset(), datasetDb) };
  setInterval(async () => {
    try {
      datasetHolder.current = AnimeDataset.buildFromRaw(await downloadDataset(), datasetDb);
    } catch (err) {
      console.error('Failed to refresh anime dataset:', err);
    }
  }, DATASET_REFRESH_INTERVAL_MS);

  const cache = new CacheStore(join(config.dataDir, 'cache.db'), join(config.dataDir, 'subtitles'));
  const queue = new ExtractionQueue(config.extractionConcurrency);

  const app = createServer({
    dataset: datasetHolder,
    cache,
    queue,
    config,
    buildSubtitleUrl: (key) => `/vtt/${key.anilistId}/${key.episode}/${key.lang}.vtt`,
    jimakuProvider: findJimakuSubtitle,
    animetoshoProvider: findAnimeToshoSubtitle,
    extractionProvider: runExtractionTier,
  }, cache);

  app.listen(config.port, () => {
    console.log(`AnimeSubs listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 1-13 (roughly 57 tests across all files).

- [ ] **Step 6: Verify the TypeScript build itself is clean**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/manifest.ts src/server.ts src/index.ts test/server.test.ts
git commit -m "Add Express server, manifest, and process entrypoint"
```

---

### Task 14: Docker packaging + deployment/getting-started guide

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Create: `README.md`

**Interfaces:**
- Consumes: the built `dist/` output from Task 13's `npm run build`; all env vars from Task 1's `.env.example`.
- Produces: a runnable container image and the deployment/getting-started documentation the spec requires as a deliverable.

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
.env
*.db
data
.git
```

- [ ] **Step 2: Create the Dockerfile**

`Dockerfile`:
```dockerfile
FROM node:24-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg xz-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME /data
ENV DATA_DIR=/data
EXPOSE 7000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Create docker-compose.yml**

`docker-compose.yml`:
```yaml
services:
  animesubs:
    build: .
    ports:
      - "7000:7000"
    volumes:
      - animesubs-data:/data
    env_file:
      - .env
    restart: unless-stopped

volumes:
  animesubs-data:
```

- [ ] **Step 4: Build the image and verify it starts**

Run: `cp .env.example .env` and fill in real `STREAM_ADDON_URL` and `JIMAKU_API_KEY` values, then:

Run: `docker compose build`
Expected: image builds successfully (ffmpeg/xz-utils/better-sqlite3 all resolve without error).

Run: `docker compose up -d && sleep 5 && curl -s http://localhost:7000/manifest.json`
Expected: JSON manifest response with `"id":"org.animesubs"`.

Run: `docker compose logs animesubs | tail -20`
Expected: `AnimeSubs listening on port 7000` with no error lines.

Run: `docker compose down`

- [ ] **Step 5: Write the getting-started/deployment README**

`README.md`:
```markdown
# AnimeSubs

A self-hosted Stremio subtitle addon for anime. Tries a community subtitle
archive (Jimaku), then AnimeTosho's already-extracted embedded tracks, then
falls back to extracting the embedded subtitle track directly from your own
stream addon (e.g. AIOStreams) when nothing else has anything. Runs entirely
on your own hardware -- no cloud services required.

## Prerequisites

- Docker and Docker Compose
- A [Jimaku](https://jimaku.cc) account and API key (Account -> API Key)
- The manifest URL of a Stremio stream addon that returns direct,
  already-resolved playback URLs for the content you watch (e.g. your
  personal AIOStreams instance's manifest URL, with your debrid config
  baked into it)

## Quick start

```bash
git clone <this repo>
cd anime-subs
cp .env.example .env
```

Edit `.env`:

```
STREAM_ADDON_URL=https://your-aiostreams-instance.example.com/your-config-token/manifest.json
JIMAKU_API_KEY=your-jimaku-api-key
```

Then:

```bash
docker compose up -d
```

## Installing in Stremio

Open Stremio, go to the addon search/install bar, and enter:

```
http://<your-server-ip>:7000/manifest.json
```

(Or open that URL in a browser on the same network as your Stremio client --
most Stremio builds offer an "Install" button when a manifest URL is opened
directly.)

## Verifying it's working

Check the manifest loads:

```bash
curl http://localhost:7000/manifest.json
```

Check a real request (replace the Kitsu id and episode with a show you
know has subtitles somewhere):

```bash
curl "http://localhost:7000/subtitles/series/kitsu:46474:1:1.json"
```

Watch the logs while doing this to see which tier answered:

```bash
docker compose logs -f animesubs
```

If tiers 1 and 2 came back empty, the first request for that episode starts
a background extraction and returns a placeholder subtitle. Wait roughly a
minute (depends on the episode's file size and your connection to the
stream source), then reselect the subtitle track in Stremio -- it will now
be the real extracted text.

## Troubleshooting

- **Manifest won't load / container won't start**: check
  `docker compose logs animesubs`. A missing or malformed
  `STREAM_ADDON_URL`/`JIMAKU_API_KEY` fails fast at startup with a specific
  error naming the variable.
- **Every request returns an empty subtitle list**: the incoming content id
  probably isn't resolvable against the bundled anime dataset. This addon
  only resolves `kitsu:`, `mal:`, `anidb:`, and `anilist:`-prefixed ids --
  not bare IMDb (`tt...`) ids (see the design spec's ID resolver section).
  Check what id scheme your metadata addon is actually serving for the
  content in question.
- **Tier 3 (extraction) never finds anything**: confirm
  `STREAM_ADDON_URL` actually returns a stream with a direct `url` field
  (not just `infoHash`) for that content -- test it directly:
  `curl "$(cat .env | grep STREAM_ADDON_URL | cut -d= -f2 | sed 's/manifest.json//')stream/series/kitsu:ID:1:1.json"`.
- **Jimaku requests fail with 401**: your `JIMAKU_API_KEY` is wrong or
  expired -- regenerate it from your Jimaku account page.
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore README.md
git commit -m "Add Docker packaging and deployment/getting-started guide"
```

---

## Self-Review Notes

- **Spec coverage:** ID resolver (Task 3), Jimaku/AnimeTosho/extraction tiers (Tasks 7/8/11), cache with in-flight dedup and negative TTL (Task 2), extraction queue (Task 10), orchestration with cache-first short-circuiting (Task 12), HTTP surface limited to manifest/subtitles/vtt (Task 13), Docker + getting-started guide (Task 14), config validation at startup (Task 1) all map directly to spec sections. The spec's "Performance & resource efficiency" section's five bullets are each covered: cache-first (Task 12's `resolveOneLanguage` early-returns), in-flight dedup (Task 2's `CacheStore` + Task 12's `getInFlight` check), bounded queue (Task 10), subtitle-only ffmpeg mapping (Task 5's `-map 0:<index> -c:s webvtt`, never touching video/audio), bounded HTTP timeouts (Task 4, threaded through as `providerTimeoutMs`/explicit `timeoutMs` args).
- **Type consistency:** `CacheKey`/`CacheEntry`/`ProviderResult`/`SubtitleCandidate` (Task 2) are used with identical shapes through Tasks 7, 8, 11, 12, 13. `ExtractionParams` (Task 11) matches exactly what Task 12's `startExtractionInBackground` constructs. `DatasetHolder` (introduced in Task 12) is used identically in Task 13's server test and `index.ts`.
- **Known, explicitly-scoped limitations** (not placeholders): no movie support, no IMDb mapping, episode-number parsing is regex-heuristic (season-relative numbering preferred over absolute when both appear in a title), tier-3 extraction picks its own canonical stream rather than the user's exact pick. All are stated in the spec's Non-goals/Goals and re-stated at the relevant task.
