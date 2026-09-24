export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpTimeoutError';
  }
}

async function timedFetch<T>(
  url: string,
  opts: FetchOptions,
  consume: (res: Response) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`GET ${url} failed: HTTP ${res.status}`);
    }
    return await consume(res);
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
  return timedFetch(url, opts, async (res) => (await res.json()) as T);
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<Buffer> {
  return timedFetch(url, opts, async (res) => Buffer.from(await res.arrayBuffer()));
}

export async function fetchBufferCapped(url: string, maxBytes: number, opts: FetchOptions = {}): Promise<Buffer> {
  return timedFetch(url, opts, async (res) => {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
  });
}

