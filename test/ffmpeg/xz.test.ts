import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { decompressXz } from '../../src/ffmpeg/xz.js';

describe('decompressXz', () => {
  it('decompresses real xz-compressed data back to the original bytes', async () => {
    const original = Buffer.from('[Script Info]\nTitle: test subtitle\n');
    const compressed = execFileSync('xz', ['-c'], { input: original });
    const result = await decompressXz(compressed);
    expect(result.toString('utf-8')).toBe(original.toString('utf-8'));
  });

  it('rejects when given non-xz data', async () => {
    await expect(decompressXz(Buffer.from('not xz data'))).rejects.toThrow(/exited with code/);
  });
});
