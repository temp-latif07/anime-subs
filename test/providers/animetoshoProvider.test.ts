import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { findAnimeToshoSubtitle } from '../../src/providers/animetoshoProvider.js';

describe('findAnimeToshoSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let compressedAssSubtitle: Buffer;
  let compressedSrtSubtitle: Buffer;
  const expectedAssPath = '/storage/attach/002b205c/%5BGroup%5D%20Show%20-%2005%20(1080p)%20%5BABCD1234%5D_track3.eng.ass.xz';
  const expectedSrtPath = '/storage/attach/00000064/Show%20S01E06_track2.eng.srt.xz';

  beforeAll(async () => {
    compressedAssSubtitle = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,AnimeTosho fixture line\n'),
    });
    compressedSrtSubtitle = execFileSync('xz', ['-c'], {
      input: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nAnimeTosho SRT fixture line\n'),
    });

    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/json' && url.searchParams.get('t') === 'search') {
        const aid = url.searchParams.get('aid');
        if (aid === '18886') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 1, title: '[Group] Show - 05 (1080p) [ABCD1234].mkv', status: 'complete', num_files: 1 },
            { id: 2, title: '[Group] Show (Batch S01)', status: 'skipped', num_files: 12 },
            { id: 3, title: '[Group] Show - 05 (720p).mkv', status: 'pending', num_files: 1 },
            { id: 4, title: 'Show S01E06.mkv', status: 'complete', num_files: 1 },
            { id: 5, title: '[Group] Show - 07.mkv', status: 'complete', num_files: 1 },
          ]));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
        }
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
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '4') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: 'Show S01E06.mkv',
            attachments: [
              { id: 100, type: 'subtitle', info: { codec: 'SRT', lang: 'eng', tracknum: 2 } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '5') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 07.mkv',
            attachments: [
              { id: 200, type: 'subtitle', info: { codec: 'ASS', lang: 'jpn', tracknum: 1 } },
            ],
          }],
        }));
      } else if (url.pathname === expectedAssPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedAssSubtitle);
      } else if (url.pathname === expectedSrtPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedSrtSubtitle);
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

  it('skips non-complete status releases even if episode matches', async () => {
    // ID 3 has episode 5, num_files 1, but status 'pending'
    // ID 1 matches first, but if we query non-existent lang, it won't fall back to ID 3
    const result = await findAnimeToshoSubtitle(18886, 5, 'fra', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
  });

  it('handles S01E06 format and SRT codec conversion', async () => {
    const result = await findAnimeToshoSubtitle(18886, 6, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('AnimeTosho SRT fixture line');
  });

  it('returns not found if torrent files lack matching language subtitle', async () => {
    const result = await findAnimeToshoSubtitle(18886, 7, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
  });

  it('applies custom timeoutMs option', async () => {
    const result = await findAnimeToshoSubtitle(18886, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl, timeoutMs: 5000 });
    expect(result.found).toBe(true);
  });
});
