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
  let jpMkvBytes: Buffer;

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

    const jpSrtPath = join(dir, 'japanese.srt');
    writeFileSync(jpSrtPath, '1\n00:00:00,000 --> 00:00:02,000\nこれは日本語の字幕です。\n');
    const jpMkvPath = join(dir, 'japanese.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2',
      '-f', 'srt', '-i', jpSrtPath,
      '-map', '0:v', '-map', '1:s',
      '-c:v', 'libx264', '-c:s', 'srt',
      '-metadata:s:s:0', 'language=eng',
      jpMkvPath,
    ]);
    jpMkvBytes = readFileSync(jpMkvPath);

    server = createServer((req, res) => {
      if (req.url === '/stream/series/kitsu:1:1:1.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [{ url: `${baseUrl}/video.mkv` }] }));
      } else if (req.url === '/stream/series/kitsu:1:1:2.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [] }));
      } else if (req.url === '/stream/series/kitsu:1:1:3.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [{ url: 'http://127.0.0.1:1/dead.mkv' }, { url: `${baseUrl}/video.mkv` }] }));
      } else if (req.url === '/video.mkv') {
        res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes' });
        res.end(mkvBytes);
      } else if (req.url === '/japanese.mkv') {
        res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes' });
        res.end(jpMkvBytes);
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

  it('returns not found when the stream has no subtitle track matching the requested language', async () => {
    const result = await runExtractionTier({
      streamAddonUrl: `${baseUrl}/manifest.json`,
      contentId: 'kitsu:1',
      season: 1,
      episode: 1,
      lang: 'jpn',
      queue: new ExtractionQueue(1),
      extractionTimeoutMs: 30000,
      providerTimeoutMs: 8000,
    });
    expect(result.found).toBe(false);
  });

  it('falls through a dead candidate stream to a working stream', async () => {
    const result = await runExtractionTier({
      streamAddonUrl: `${baseUrl}/manifest.json`,
      contentId: 'kitsu:1',
      season: 1,
      episode: 3,
      lang: 'eng',
      queue: new ExtractionQueue(1),
      extractionTimeoutMs: 30000,
      providerTimeoutMs: 8000,
    });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Remote extraction fixture');
  });

  it('rejects an extraction result that is predominantly Japanese instead of caching it', async () => {
    const result = await runExtractionTier({
      streamAddonUrl: `${baseUrl}/manifest.json`,
      contentId: 'kitsu:1',
      season: 1,
      episode: 1,
      lang: 'eng',
      queue: new ExtractionQueue(1),
      extractionTimeoutMs: 30000,
      providerTimeoutMs: 8000,
      streamUrls: [`${baseUrl}/japanese.mkv`],
    });
    expect(result.found).toBe(false);
  });

  it('falls through a predominantly Japanese stream to a valid English stream', async () => {
    const result = await runExtractionTier({
      streamAddonUrl: `${baseUrl}/manifest.json`,
      contentId: 'kitsu:1',
      season: 1,
      episode: 1,
      lang: 'eng',
      queue: new ExtractionQueue(1),
      extractionTimeoutMs: 30000,
      providerTimeoutMs: 8000,
      streamUrls: [`${baseUrl}/japanese.mkv`, `${baseUrl}/video.mkv`],
    });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Remote extraction fixture');
  });
});
