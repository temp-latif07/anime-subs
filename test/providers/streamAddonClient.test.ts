import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { getBestStreamUrl } from '../../src/providers/streamAddonClient.js';

describe('getBestStreamUrl', () => {
  let server: Server;
  let manifestUrl: string;
  let baseUrl: string;

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
      } else if (req.url === '/stream/series/kitsu:50350:1:3.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ streams: [] }));
      } else if (req.url === '/stream/series/kitsu:50350:1:4.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      } else if (req.url === '/stream/series/kitsu:50350:1:5.json') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ streams: [{ url: 'https://debrid.example.com/direct/slow.mkv' }] }));
        }, 100);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    manifestUrl = `${baseUrl}/manifest.json`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('skips an infoHash-only entry and returns the first directly playable url', async () => {
    expect(await getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 1)).toBe('https://debrid.example.com/direct/episode1.mkv');
  });

  it('returns null when every stream is infoHash-only (unresolved torrent)', async () => {
    expect(await getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 2)).toBeNull();
  });

  it('returns null when streams array is empty', async () => {
    expect(await getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 3)).toBeNull();
  });

  it('returns null when response has no streams property', async () => {
    expect(await getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 4)).toBeNull();
  });

  it('handles manifestUrl without manifest.json path', async () => {
    expect(await getBestStreamUrl(baseUrl, 'kitsu:50350', 1, 1)).toBe('https://debrid.example.com/direct/episode1.mkv');
  });

  it('respects timeoutMs option', async () => {
    await expect(getBestStreamUrl(manifestUrl, 'kitsu:50350', 1, 5, { timeoutMs: 20 })).rejects.toThrow();
  });
});
