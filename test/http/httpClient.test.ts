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
});
