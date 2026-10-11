import { describe, it, expect } from 'vitest';
import { parseReleaseHint } from '../src/releaseHint.js';

describe('parseReleaseHint', () => {
  it('reads filename and videoSize from the Stremio extra segment', () => {
    const hint = parseReleaseHint('filename=[sam] Kusuriya no Hitorigoto - 03v2 [BD 1080p FLAC] [4A303FE1].mkv&videoSize=3107610609&videoHash=7e897bdd8f60bffb');
    expect(hint).toEqual({
      filename: '[sam] Kusuriya no Hitorigoto - 03v2 [BD 1080p FLAC] [4A303FE1].mkv',
      size: 3107610609,
    });
  });

  it('returns undefined when there is no usable data', () => {
    expect(parseReleaseHint(undefined)).toBeUndefined();
    expect(parseReleaseHint('videoHash=abc')).toBeUndefined();
    expect(parseReleaseHint('videoSize=notanumber')).toBeUndefined();
  });

  it('keeps a filename-only hint', () => {
    expect(parseReleaseHint('filename=Show - 01.mkv')).toEqual({ filename: 'Show - 01.mkv' });
  });

  it('keeps a size-only hint', () => {
    expect(parseReleaseHint('videoSize=1000')).toEqual({ size: 1000 });
  });
});
