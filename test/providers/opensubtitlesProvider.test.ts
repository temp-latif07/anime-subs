import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { findOpenSubtitlesSubtitle } from '../../src/providers/opensubtitlesProvider.js';

describe('findOpenSubtitlesSubtitle', () => {
  let server: Server;
  let baseUrl: string;
  let lastSearchQuery: URLSearchParams | null = null;
  let lastSearchHeaders: Record<string, string | string[] | undefined> = {};
  let lastDownloadHeaders: Record<string, string | string[] | undefined> = {};
  let lastDownloadBody: string = '';
  let downloadCallCount = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/subtitles' && req.method === 'GET') {
        lastSearchQuery = url.searchParams;
        lastSearchHeaders = req.headers;
        if (url.searchParams.get('parent_imdb_id') === '1111111') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ attributes: { files: [{ file_id: 42 }] } }] }));
        } else if (url.searchParams.get('parent_imdb_id') === '2222222') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ attributes: { files: [{ file_id: 99 }] } }] }));
        } else if (url.searchParams.get('parent_imdb_id') === '3333333') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ attributes: { files: [] } }] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
        }
      } else if (url.pathname === '/download' && req.method === 'POST') {
        downloadCallCount++;
        lastDownloadHeaders = req.headers;
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          lastDownloadBody = body;
          const parsed = JSON.parse(body || '{}');
          if (parsed.file_id === 99) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ link: `${baseUrl}/files/japanese.srt` }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ link: `${baseUrl}/files/subtitle.srt` }));
          }
        });
      } else if (url.pathname === '/files/subtitle.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nOpenSubtitles fixture line\n');
      } else if (url.pathname === '/files/japanese.srt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('1\n00:00:00,000 --> 00:00:01,000\nこれは日本語の字幕です。英語はありません。\n');
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

  it('returns not found immediately when imdbId is null, without any HTTP call', async () => {
    const result = await findOpenSubtitlesSubtitle(null, 1, 5, 'eng', 'test-key', { baseUrl });
    expect(result.found).toBe(false);
    expect(result.quotaSkipped).toBeFalsy();
  });

  it('finds and downloads a subtitle when a search match exists and quota is available', async () => {
    downloadCallCount = 0;
    const result = await findOpenSubtitlesSubtitle('tt1111111', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(true);
    expect(result.vttContent).toContain('OpenSubtitles fixture line');
    expect(downloadCallCount).toBe(1);
    expect(JSON.parse(lastDownloadBody)).toEqual({ file_id: 42 });
  });

  it('searches with numeric parent_imdb_id (the series-level id, not an episode imdb_id), season_number, and episode_number', async () => {
    await findOpenSubtitlesSubtitle('tt1111111', 2, 9, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(lastSearchQuery?.get('parent_imdb_id')).toBe('1111111');
    expect(lastSearchQuery?.get('imdb_id')).toBeNull();
    expect(lastSearchQuery?.get('season_number')).toBe('2');
    expect(lastSearchQuery?.get('episode_number')).toBe('9');
    expect(lastSearchQuery?.get('languages')).toBe('en');
  });

  it('accepts bare numeric imdbId without tt prefix', async () => {
    await findOpenSubtitlesSubtitle('1111111', 2, 9, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(lastSearchQuery?.get('parent_imdb_id')).toBe('1111111');
  });

  it('sends User-Agent and Api-Key headers on search and download', async () => {
    await findOpenSubtitlesSubtitle('tt1111111', 1, 5, 'eng', 'test-api-key', { baseUrl, hasQuota: true });
    expect(lastSearchHeaders['api-key']).toBe('test-api-key');
    expect(lastSearchHeaders['user-agent']).toBeTruthy();
    expect(lastDownloadHeaders['api-key']).toBe('test-api-key');
    expect(lastDownloadHeaders['user-agent']).toBeTruthy();
  });

  it('does not call download and reports quotaSkipped when hasQuota is false, even with a search match', async () => {
    downloadCallCount = 0;
    const result = await findOpenSubtitlesSubtitle('tt1111111', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: false });
    expect(result.found).toBe(false);
    expect(result.quotaSkipped).toBe(true);
    expect(downloadCallCount).toBe(0);
  });

  it('returns a genuine miss (quotaSkipped falsy) when the search itself finds nothing, regardless of quota', async () => {
    const result = await findOpenSubtitlesSubtitle('tt9999999', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: false });
    expect(result.found).toBe(false);
    expect(result.quotaSkipped).toBeFalsy();
  });

  it('returns not found when tvdbSeason or tvdbEpisode could not be resolved', async () => {
    const result = await findOpenSubtitlesSubtitle('tt1111111', null, null, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(false);
  });

  it('returns not found when requested language is unsupported', async () => {
    const result = await findOpenSubtitlesSubtitle('tt1111111', 1, 5, 'xyz', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(false);
  });

  it('returns not found when search result has no files', async () => {
    const result = await findOpenSubtitlesSubtitle('tt3333333', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(false);
  });

  it('rejects a subtitle that fails the acceptability check', async () => {
    const result = await findOpenSubtitlesSubtitle('tt2222222', 1, 5, 'eng', 'test-key', { baseUrl, hasQuota: true });
    expect(result.found).toBe(false);
  });
});
