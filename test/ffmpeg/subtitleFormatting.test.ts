import { describe, it, expect } from 'vitest';
import { resolveLinePosition, resolvePosition } from '../../src/ffmpeg/subtitleFormatting.js';

describe('resolveLinePosition', () => {
  it('returns line:10% for top-aligned cues', () => {
    expect(resolveLinePosition(true)).toBe('line:10%');
  });

  it('returns line:90%,end for non-top-aligned cues', () => {
    expect(resolveLinePosition(false)).toBe('line:90%,end');
  });
});

describe('resolvePosition', () => {
  it('falls back to resolveLinePosition when pos is absent, for top alignment (7-9)', () => {
    expect(resolvePosition(7, undefined, 384, 288)).toBe('line:10%');
    expect(resolvePosition(8, undefined, 384, 288)).toBe('line:10%');
    expect(resolvePosition(9, undefined, 384, 288)).toBe('line:10%');
  });

  it('falls back to resolveLinePosition when pos is absent, for bottom/middle alignment (1-6)', () => {
    expect(resolvePosition(1, undefined, 384, 288)).toBe('line:90%,end');
    expect(resolvePosition(2, undefined, 384, 288)).toBe('line:90%,end');
    expect(resolvePosition(6, undefined, 384, 288)).toBe('line:90%,end');
  });

  it('maps left/center/right alignment groups to percent position, line, and align settings when pos is present', () => {
    expect(resolvePosition(7, { x: 0, y: 0 }, 200, 100)).toBe('position:0% line:0% align:left');
    expect(resolvePosition(8, { x: 100, y: 50 }, 200, 100)).toBe('position:50% line:50% align:center');
    expect(resolvePosition(9, { x: 200, y: 100 }, 200, 100)).toBe('position:100% line:100% align:right');
  });

  it('falls back to resolveLinePosition when width or height is falsy even if pos is present', () => {
    expect(resolvePosition(2, { x: 100, y: 50 }, null, 288)).toBe('line:90%,end');
    expect(resolvePosition(2, { x: 100, y: 50 }, 384, 0)).toBe('line:90%,end');
  });
});
