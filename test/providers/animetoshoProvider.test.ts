import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { findAnimeToshoSubtitle, parseEpisodeNumber } from '../../src/providers/animetoshoProvider.js';

describe('findAnimeToshoSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let lastSearchUrl: string | null = null;
  let compressedAssSubtitle: Buffer;
  let compressedSrtSubtitle: Buffer;
  let compressedJpSrtSubtitle: Buffer;
  const expectedAssPath = '/storage/attach/002b205c/%5BGroup%5D%20Show%20-%2005%20(1080p)%20%5BABCD1234%5D_track3.eng.ass.xz';
  const expectedSrtPath = '/storage/attach/00000064/Show%20S01E06_track2.eng.srt.xz';
  const expectedJpSrtPath = '/storage/attach/00000320/Show%20S01E08_track2.eng.srt.xz';
  const expectedBatchAssPath = '/storage/attach/000003ea/%5BGroup%5D%20BatchShow%20-%2002%20%5B1080p%5D_track2.eng.ass.xz';
  const expectedFallbackSrtPath = '/storage/attach/000007d1/%5BGroup%5D%20Fallback%20Show%20-%2001%20%5B1080p%5D_track2.eng.srt.xz';
  const expectedExpandedAssPath = '/storage/attach/00000bb9/%5BGroup%5D%20Show%2006%20%5B1080p%5D_track3.eng.ass.xz';

  beforeAll(async () => {
    compressedAssSubtitle = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,AnimeTosho fixture line\n'),
    });
    compressedSrtSubtitle = execFileSync('xz', ['-c'], {
      input: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nAnimeTosho SRT fixture line\n'),
    });
    compressedJpSrtSubtitle = execFileSync('xz', ['-c'], {
      input: Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nこれは日本語の字幕です。英語はありません。\n'),
    });

    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/json' && url.searchParams.get('t') === 'search') {
        lastSearchUrl = req.url!;
        const aid = url.searchParams.get('aid');
        const q = url.searchParams.get('q');
        if (aid === '18886') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 1, title: '[Group] Show - 05 (1080p) [ABCD1234].mkv', status: 'complete', num_files: 1 },
            { id: 2, title: '[Group] Show (Batch S01)', status: 'skipped', num_files: 12 },
            { id: 3, title: '[Group] Show - 05 (720p).mkv', status: 'pending', num_files: 1 },
            { id: 4, title: 'Show S01E06.mkv', status: 'complete', num_files: 1 },
            { id: 5, title: '[Group] Show - 07.mkv', status: 'complete', num_files: 1 },
            { id: 8, title: 'Show S01E08.mkv', status: 'complete', num_files: 1 },
          ]));
        } else if (aid === '19999') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 10, title: '[Group] BatchShow (01-12) [1080p]', status: 'complete', num_files: 12 },
          ]));
        } else if (aid === '29999') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 30, title: '[Group] Show 06 [1080p].mkv', status: 'complete', num_files: 1 },
          ]));
        } else if (!aid && q && (q.startsWith('Fallback Show') || q.startsWith('Fallback  Show'))) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 20, title: '[Group] Fallback Show - 01 [1080p].mkv', status: 'complete', num_files: 1 },
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
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '8') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: 'Show S01E08.mkv',
            attachments: [
              { id: 800, type: 'subtitle', info: { codec: 'SRT', lang: 'eng', tracknum: 2 } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '10') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [
            {
              filename: '[Group] BatchShow - 01 [1080p].mkv',
              attachments: [
                { id: 1001, type: 'subtitle', info: { codec: 'ASS', lang: 'eng', tracknum: 2 } },
              ],
            },
            {
              filename: '[Group] BatchShow - 02 [1080p].mkv',
              attachments: [
                { id: 1002, type: 'subtitle', info: { codec: 'ASS', lang: 'eng', tracknum: 2 } },
              ],
            },
          ],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '20') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Fallback Show - 01 [1080p].mkv',
            attachments: [
              { id: 2001, type: 'subtitle', info: { codec: 'SRT', lang: 'eng', tracknum: 2 } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '30') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show 06 [1080p].mkv',
            attachments: [
              { id: 3001, type: 'subtitle', info: { codec: 'ASS', lang: 'eng', tracknum: 3 } },
            ],
          }],
        }));
      } else if (url.pathname === expectedAssPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedAssSubtitle);
      } else if (url.pathname === expectedSrtPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedSrtSubtitle);
      } else if (url.pathname === expectedJpSrtPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedJpSrtSubtitle);
      } else if (url.pathname === expectedBatchAssPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedAssSubtitle);
      } else if (url.pathname === expectedFallbackSrtPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedSrtSubtitle);
      } else if (url.pathname === expectedExpandedAssPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedAssSubtitle);
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

  it('rejects a subtitle candidate that is predominantly Japanese and returns not found', async () => {
    const result = await findAnimeToshoSubtitle(18886, 8, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
  });

  it('includes targeted episode in aid search query (q=5)', async () => {
    lastSearchUrl = null;
    await findAnimeToshoSubtitle(18886, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(lastSearchUrl).toBeDefined();
    const parsed = new URL(lastSearchUrl!, baseUrl);
    expect(parsed.searchParams.get('aid')).toBe('18886');
    expect(parsed.searchParams.get('q')).toBe('5');
  });

  it('parses batch torrents (num_files > 1) by iterating detail.files to match episode', async () => {
    const result = await findAnimeToshoSubtitle(19999, 2, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('AnimeTosho fixture line');
  });

  it('falls back to title search when aid returns 0 results', async () => {
    const result = await findAnimeToshoSubtitle(99999, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Fallback: Show!',
    });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('AnimeTosho SRT fixture line');
  });

  it('searches by title directly when anidbId is null', async () => {
    const result = await findAnimeToshoSubtitle(null, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Fallback Show',
    });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('WEBVTT');
    expect(result.vttContent).toContain('AnimeTosho SRT fixture line');
  });

  it('returns seriesNotFound: true when both aid and title search return 0 results', async () => {
    const result = await findAnimeToshoSubtitle(99999, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Nonexistent Show',
    });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBe(true);
  });

  it('matches expanded episode regex formats in findAnimeToshoSubtitle for [Group] Show 06 [1080p]', async () => {
    const result = await findAnimeToshoSubtitle(29999, 6, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('AnimeTosho fixture line');
  });

  it('correctly parses various episode numbering conventions with parseEpisodeNumber', () => {
    expect(parseEpisodeNumber('[Group] Show 06 [1080p].mkv')).toBe(6);
    expect(parseEpisodeNumber('Show Episode 06.mkv')).toBe(6);
    expect(parseEpisodeNumber('Show Ep 06.mkv')).toBe(6);
    expect(parseEpisodeNumber('Show ep 06.mkv')).toBe(6);
    expect(parseEpisodeNumber('[Group] Show - 06v2 [1080p].mkv')).toBe(6);
    expect(parseEpisodeNumber('[Group] Show - 06v2.mkv')).toBe(6);
    expect(parseEpisodeNumber('Show - 06.mkv')).toBe(6);
    expect(parseEpisodeNumber('Show S01E06.mkv')).toBe(6);
    expect(parseEpisodeNumber('[Group] Show - 06 (1080p).mkv')).toBe(6);
    expect(parseEpisodeNumber('[Group] Show - 06 [1080p].mkv')).toBe(6);
    expect(parseEpisodeNumber('Random Title Without Episode.mkv')).toBeNull();
  });
});

