import { describe, it, expect } from 'vitest';
import { resolveLinePosition, resolvePosition, wrapSubtitleText } from '../../src/ffmpeg/subtitleFormatting.js';

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

describe('wrapSubtitleText', () => {
  it('leaves short lines untouched', () => {
    const text = 'Hello world, this is short.';
    expect(wrapSubtitleText(text, 42)).toBe(text);
  });

  it('balances a 2-line wrap at natural space boundaries', () => {
    // 59 characters
    const text = 'I was thinking that we might find something that could help.';
    const wrapped = wrapSubtitleText(text, 42);
    const lines = wrapped.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0].length).toBeLessThanOrEqual(42);
    expect(lines[1].length).toBeLessThanOrEqual(42);
    expect(wrapped).toBe('I was thinking that we might\nfind something that could help.');
  });

  it('wraps very long lines into multiple lines under max line length', () => {
    const text = 'This is a very long line without any explicit break that would wrap in libass because it exceeds the playres margins.';
    const wrapped = wrapSubtitleText(text, 42);
    const lines = wrapped.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(42);
    }
  });

  it('disregards HTML tags when measuring visual line length', () => {
    const text = '<i>I was thinking that we might find something that could help.</i>';
    const wrapped = wrapSubtitleText(text, 42);
    const lines = wrapped.split('\n');
    expect(lines.length).toBe(2);
  });

  it('handles existing newlines by wrapping each line independently', () => {
    const text = 'Short line\nI was thinking that we might find something that could help.';
    const wrapped = wrapSubtitleText(text, 42);
    expect(wrapped).toBe('Short line\nI was thinking that we might\nfind something that could help.');
  });
});
