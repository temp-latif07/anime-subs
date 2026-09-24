import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchJson, fetchBuffer, fetchBufferCapped, HttpTimeoutError } from '../../src/http/httpClient.js';

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
      } else if (req.url === '/big-file') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(10 * 1024 * 1024, 0xaa));
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
      } else if (req.url === '/post' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: JSON.parse(body) }));
        });
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

  it('sends POST requests with body', async () => {
    const result = await fetchJson<{ received: { foo: string } }>(`${baseUrl}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });
    expect(result.received).toEqual({ foo: 'bar' });
  });

  it('fetches raw bytes as a Buffer', async () => {
    const buf = await fetchBuffer(`${baseUrl}/bytes`);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  it('fetchBufferCapped stops reading once maxBytes is reached, even if the server ignores Range and sends more', async () => {
    // server route that responds 200 with a 10MB body regardless of the Range header
    const buf = await fetchBufferCapped(`${baseUrl}/big-file`, 1024, { timeoutMs: 5000 });
    expect(buf.length).toBeLessThanOrEqual(1024);
  });

  it('fetchBufferCapped returns all bytes if body is smaller than maxBytes', async () => {
    const buf = await fetchBufferCapped(`${baseUrl}/bytes`, 1024);
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
