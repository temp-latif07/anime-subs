export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpTimeoutError extends Error {}

async function timedFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: opts.headers, signal: controller.signal });
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
  const res = await timedFetch(url, opts);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<Buffer> {
  const res = await timedFetch(url, opts);
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
