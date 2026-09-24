import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { findAnimeToshoSubtitle, parseEpisodeNumber, isForcedOrSignsAttachment } from '../../src/providers/animetoshoProvider.js';

describe('findAnimeToshoSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let lastSearchUrl: string | null = null;
  let compressedAssSubtitle: Buffer;
  let compressedSrtSubtitle: Buffer;
  let compressedJpSrtSubtitle: Buffer;
  let compressedFullDialogueAss: Buffer;
  let compressedDefaultAss: Buffer;
  let compressedForcedAss: Buffer;
  const expectedAssPath = '/storage/attach/002b205c/%5BGroup%5D%20Show%20-%2005%20(1080p)%20%5BABCD1234%5D_track3.eng.ass.xz';
  const expectedSrtPath = '/storage/attach/00000064/Show%20S01E06_track2.eng.srt.xz';
  const expectedJpSrtPath = '/storage/attach/00000320/Show%20S01E08_track2.eng.srt.xz';
  const expectedBatchAssPath = '/storage/attach/000003ea/%5BGroup%5D%20BatchShow%20-%2002%20%5B1080p%5D_track2.eng.ass.xz';
  const expectedFallbackSrtPath = '/storage/attach/000007d1/%5BGroup%5D%20Fallback%20Show%20-%2001%20%5B1080p%5D_track2.eng.srt.xz';
  const expectedExpandedAssPath = '/storage/attach/00000bb9/%5BGroup%5D%20Show%2006%20%5B1080p%5D_track3.eng.ass.xz';
  const expectedBroadBatchAssPath = '/storage/attach/00000fa1/%5BGroup%5D%20BroadBatch%20-%2005%20%5B1080p%5D_track2.eng.ass.xz';
  const expectedFlakySrtPath = '/storage/attach/000013ed/%5BGroup%5D%20FlakyShow%20-%2005%20(alt)%20%5B720p%5D_track2.eng.srt.xz';

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
    compressedFullDialogueAss = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Full dialogue subtitle line\n'),
    });
    compressedDefaultAss = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Default track subtitle line\n'),
    });
    compressedForcedAss = execFileSync('xz', ['-c'], {
      input: Buffer.from('[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Forced signs line only\n'),
    });

    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/json' && url.searchParams.get('t') === 'search') {
        lastSearchUrl = req.url!;
        const aid = url.searchParams.get('aid');
        const q = url.searchParams.get('q');
        if (aid === '18886' && q !== '999') {
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
        } else if (aid === '39999' && !q) {
          // broader aid-only search finds a batch release the q=-filtered search missed
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 40, title: '[Group] BroadBatch (01-12) [1080p]', status: 'complete', num_files: 12 },
          ]));
        } else if (aid === '39999' && q) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([]));
        } else if (aid === '49999') {
          // simulates a torrent-detail fetch that fails for the first candidate
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 50, title: '[Group] FlakyShow - 05 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 51, title: '[Group] FlakyShow - 05 (alt) [720p].mkv', status: 'complete', num_files: 1 },
          ]));
        } else if (aid === '69999') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([
            { id: 60, title: '[Group] Show - 01 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 61, title: '[Group] Show - 02 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 62, title: '[Group] Show - 03 [1080p].mkv', status: 'complete', num_files: 1 },
            { id: 63, title: '[Group] Show - 04 [1080p].mkv', status: 'complete', num_files: 1 },
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
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '40') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [
            {
              filename: '[Group] BroadBatch - 05 [1080p].mkv',
              attachments: [
                { id: 4001, type: 'subtitle', info: { codec: 'ASS', lang: 'eng', tracknum: 2 } },
              ],
            },
          ],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '50') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '51') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] FlakyShow - 05 (alt) [720p].mkv',
            attachments: [
              { id: 5101, type: 'subtitle', info: { codec: 'SRT', lang: 'eng', tracknum: 2 } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '60') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 01 [1080p].mkv',
            attachments: [
              { id: 6001, type: 'subtitle', size: 6000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, forced: 1 } },
              { id: 6002, type: 'subtitle', size: 35000, info: { codec: 'ASS', lang: 'eng', tracknum: 2, forced: 0 } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '61') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 02 [1080p].mkv',
            attachments: [
              { id: 6101, type: 'subtitle', size: 10000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, name: 'CR ASS) English [Forced]' } },
              { id: 6102, type: 'subtitle', size: 15000, info: { codec: 'ASS', lang: 'eng', tracknum: 2, name: 'English (Full)' } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '62') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 03 [1080p].mkv',
            attachments: [
              { id: 6201, type: 'subtitle', size: 40000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, default: 0 } },
              { id: 6202, type: 'subtitle', size: 25000, info: { codec: 'ASS', lang: 'eng', tracknum: 2, default: 1 } },
            ],
          }],
        }));
      } else if (url.pathname === '/json' && url.searchParams.get('show') === 'torrent' && url.searchParams.get('id') === '63') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          files: [{
            filename: '[Group] Show - 04 [1080p].mkv',
            attachments: [
              { id: 6301, type: 'subtitle', size: 5000, info: { codec: 'ASS', lang: 'eng', tracknum: 1, forced: 1, name: 'Signs & Songs' } },
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
      } else if (url.pathname === expectedBroadBatchAssPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedAssSubtitle);
      } else if (url.pathname === expectedFlakySrtPath) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedSrtSubtitle);
      } else if (url.pathname.includes('00001771') || url.pathname.includes('000017d5') || url.pathname.includes('0000189d')) {
        // 6001, 6101, 6301 are forced
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedForcedAss);
      } else if (url.pathname.includes('00001772') || url.pathname.includes('000017d6') || url.pathname.includes('00001839')) {
        // 6002, 6102, 6201 are full dialogue
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedFullDialogueAss);
      } else if (url.pathname.includes('0000183a')) {
        // 6202 is default track
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(compressedDefaultAss);
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

  it('does not set seriesNotFound when anidbId is present, even if aid, broad, and title searches all miss', async () => {
    const result = await findAnimeToshoSubtitle(99999, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Nonexistent Show',
    });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBeFalsy();
  });

  it('sets seriesNotFound true when anidbId is null and the title search also misses', async () => {
    const result = await findAnimeToshoSubtitle(null, 1, 'eng', {
      feedBaseUrl: baseUrl,
      storageBaseUrl: baseUrl,
      title: 'Totally Unknown Show',
    });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBe(true);
  });

  it('matches expanded episode regex formats in findAnimeToshoSubtitle for [Group] Show 06 [1080p]', async () => {
    const result = await findAnimeToshoSubtitle(29999, 6, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('AnimeTosho fixture line');
  });

  it('does not abort the whole search when one candidate torrent-detail fetch fails', async () => {
    const result = await findAnimeToshoSubtitle(49999, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('AnimeTosho SRT fixture line');
  });

  it('does not set seriesNotFound from an anidbId-scoped episode search alone', async () => {
    const result = await findAnimeToshoSubtitle(18886, 999, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
    expect(result.seriesNotFound).toBeFalsy();
  });

  it('falls back to a broader aid-only search to catch batch releases the q=-filtered search missed', async () => {
    const result = await findAnimeToshoSubtitle(39999, 5, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('AnimeTosho fixture line');
  });

  it('filters out forced tracks and selects the full dialogue subtitle track based on size', async () => {
    // ID 60 has two English attachments: Track 1 (Forced, 6KB) and Track 2 (Full, 35KB)
    const result = await findAnimeToshoSubtitle(69999, 1, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Full dialogue subtitle line');
  });

  it('filters out tracks whose name contains "[Forced]" or "Signs" even if forced flag is 0 or omitted', async () => {
    // ID 61 has Track 1 with name "English [Forced]" (no forced flag) and Track 2 with name "Full Dialogue"
    const result = await findAnimeToshoSubtitle(69999, 2, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Full dialogue subtitle line');
  });

  it('prioritizes default: 1 attachments over non-default attachments', async () => {
    // ID 62 has Track 1 (default: 0, 40KB) and Track 2 (default: 1, 25KB)
    const result = await findAnimeToshoSubtitle(69999, 3, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('Default track subtitle line');
  });

  it('returns found: false when all attachments for the requested language are forced or signs/songs', async () => {
    // ID 63 has only forced/signs attachments for English
    const result = await findAnimeToshoSubtitle(69999, 4, 'eng', { feedBaseUrl: baseUrl, storageBaseUrl: baseUrl });
    expect(result.found).toBe(false);
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

describe('isForcedOrSignsAttachment', () => {
  it('returns false when info is undefined', () => {
    expect(isForcedOrSignsAttachment(undefined)).toBe(false);
  });

  it('returns true when forced === 1', () => {
    expect(isForcedOrSignsAttachment({ forced: 1 })).toBe(true);
  });

  it('returns false when forced === 0 and name does not contain forced/signs/songs', () => {
    expect(isForcedOrSignsAttachment({ forced: 0, name: 'English (Full)' })).toBe(false);
  });

  it('returns true when name contains forced in various casings', () => {
    expect(isForcedOrSignsAttachment({ name: 'CR ASS) English [Forced]' })).toBe(true);
    expect(isForcedOrSignsAttachment({ name: 'FORCED' })).toBe(true);
  });

  it('returns true when name contains sign or signs', () => {
    expect(isForcedOrSignsAttachment({ name: 'Signs & Songs' })).toBe(true);
    expect(isForcedOrSignsAttachment({ name: 'Sign' })).toBe(true);
  });

  it('returns true when name contains song or songs', () => {
    expect(isForcedOrSignsAttachment({ name: 'Songs only' })).toBe(true);
    expect(isForcedOrSignsAttachment({ name: 'Song' })).toBe(true);
  });
});

