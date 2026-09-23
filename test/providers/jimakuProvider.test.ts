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
      if (url.pathname.startsWith('/api/')) {
        receivedAuth = req.headers['authorization'] ?? null;
      }

      if (url.pathname === '/api/entries/search' && url.searchParams.get('anilist_id') === '154587') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 1, flags: { anime: true, adult: false } }]));
      } else if (url.pathname === '/api/entries/search' && url.searchParams.get('anilist_id') === '100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 2, flags: { anime: false, adult: false } }]));
      } else if (url.pathname === '/api/entries/search' && url.searchParams.get('anilist_id') === '200') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 3, flags: { anime: true, adult: true } }]));
      } else if (url.pathname === '/api/entries/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      } else if (url.pathname === '/api/entries/1/files' && url.searchParams.get('episode') === '5') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'Show - 05 (Japanese).ass', url: `http://ignored/jpn.ass` },
          { name: 'Show - 05 [English].srt', url: `${baseUrl}/files/english.srt` },
        ]));
      } else if (url.pathname === '/api/entries/1/files' && url.searchParams.get('episode') === '6') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'Show - 06 [en].vtt', url: `${baseUrl}/files/english.vtt` },
        ]));
      } else if (url.pathname === '/api/entries/1/files' && url.searchParams.get('episode') === '7') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'Show - 07 [English].ass', url: `${baseUrl}/files/english.ass` },
        ]));
      } else if (url.pathname === '/api/entries/1/files') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
      } else if (url.pathname === '/files/english.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nJimaku fixture line\n');
      } else if (url.pathname === '/files/english.vtt') {
        res.writeHead(200, { 'Content-Type': 'text/vtt' });
        res.end('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nJimaku direct vtt line\n');
      } else if (url.pathname === '/files/english.ass') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Jimaku ASS fixture line\n');
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

  it('returns not found when entry is not anime', async () => {
    const result = await findJimakuSubtitle(100, 5, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(false);
  });

  it('returns not found when entry is adult anime', async () => {
    const result = await findJimakuSubtitle(200, 5, 'eng', 'test-key', { baseUrl });
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

  it('passes through .vtt files directly without converting', async () => {
    const result = await findJimakuSubtitle(154587, 6, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toBe('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nJimaku direct vtt line\n');
  });

  it('converts .ass files to WebVTT', async () => {
    const result = await findJimakuSubtitle(154587, 7, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('Jimaku ASS fixture line');
  });

  it('returns not found when language requested is not supported or matched', async () => {
    const result = await findJimakuSubtitle(154587, 5, 'fra', 'test-key', { baseUrl });
    expect(result.found).toBe(false);
  });
});
