import { describe, it, expect } from 'vitest';
import { parseSubtitleStreams } from '../../src/ffmpeg/probe.js';

describe('parseSubtitleStreams', () => {
  it('prefers a text-based subtitle codec over a bitmap codec for the same language', () => {
    const output = JSON.stringify({
      streams: [
        { index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'Full' } },
        { index: 3, codec_name: 'ass', tags: { language: 'eng', title: 'Dialogue' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 3, codec: 'ass' });
  });

  it('still picks the only available stream when it is bitmap-only', () => {
    const output = JSON.stringify({
      streams: [{ index: 2, codec_name: 'dvd_subtitle', tags: { language: 'eng', title: 'Full' } }],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'dvd_subtitle' });
  });

  it('applies sign/song exclusion within text streams', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', tags: { language: 'eng', title: 'Signs & Songs' } },
        { index: 2, codec_name: 'ass', tags: { language: 'eng', title: 'Full Subtitles' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('returns null when no stream matches language', () => {
    const output = JSON.stringify({
      streams: [{ index: 1, codec_name: 'ass', tags: { language: 'jpn', title: 'Japanese' } }],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toBeNull();
  });

  it('handles case-insensitive codec names', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'HDMV_PGS_SUBTITLE', tags: { language: 'eng', title: 'Full' } },
        { index: 2, codec_name: 'ASS', tags: { language: 'eng', title: 'Full' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('falls back to first text stream if all text streams are sign/song titled', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'subrip', tags: { language: 'eng', title: 'Songs & Signs' } },
        { index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'Full' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 1, codec: 'subrip' });
  });

  it('applies sign/song exclusion when only bitmap streams are available', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'dvd_subtitle', tags: { language: 'eng', title: 'Signs' } },
        { index: 2, codec_name: 'dvd_subtitle', tags: { language: 'eng', title: 'Full' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'dvd_subtitle' });
  });

  it('returns null on invalid JSON or empty streams', () => {
    expect(parseSubtitleStreams('not-json', 'eng')).toBeNull();
    expect(parseSubtitleStreams('{}', 'eng')).toBeNull();
    expect(parseSubtitleStreams(JSON.stringify({ streams: [] }), 'eng')).toBeNull();
  });
});
