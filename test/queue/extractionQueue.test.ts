import { describe, it, expect } from 'vitest';
import { ExtractionQueue } from '../../src/queue/extractionQueue.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ExtractionQueue', () => {
  it('runs a job immediately while under the concurrency limit', async () => {
    const queue = new ExtractionQueue(2);
    expect(await queue.run(async () => 42)).toBe(42);
  });

  it('queues a job beyond the concurrency limit until a slot frees up', async () => {
    const queue = new ExtractionQueue(1);
    const order: string[] = [];
    const first = deferred<void>();

    const jobA = queue.run(async () => {
      order.push('a-start');
      await first.promise;
      order.push('a-end');
    });
    await new Promise((r) => setTimeout(r, 10));

    const jobB = queue.run(async () => { order.push('b-start'); });

    expect(order).toEqual(['a-start']);
    first.resolve();
    await Promise.all([jobA, jobB]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('propagates a rejected job without blocking the next one', async () => {
    const queue = new ExtractionQueue(1);
    await expect(queue.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await queue.run(async () => 'still works')).toBe('still works');
  });

  it('respects concurrency limit greater than 1 with FIFO queueing', async () => {
    const queue = new ExtractionQueue(2);
    const order: string[] = [];
    const d1 = deferred<void>();
    const d2 = deferred<void>();

    const job1 = queue.run(async () => {
      order.push('1-start');
      await d1.promise;
      order.push('1-end');
    });

    const job2 = queue.run(async () => {
      order.push('2-start');
      await d2.promise;
      order.push('2-end');
    });

    const job3 = queue.run(async () => {
      order.push('3-start');
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['1-start', '2-start']);

    d1.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['1-start', '2-start', '1-end', '3-start']);

    d2.resolve();
    await Promise.all([job1, job2, job3]);
  });
});
