import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseSubtitleStreams, findSubtitleStream } from '../../src/ffmpeg/probe.js';

let mockSpawnChild: any = null;
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => mockSpawnChild),
}));

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

describe('findSubtitleStream fallback timeout', () => {
  it('caps the remote-ffprobe fallback to probeTimeoutMs, not the full extraction timeout', async () => {
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();
    mockSpawnChild = mockChild;

    vi.useFakeTimers();

    try {
      const probePromise = findSubtitleStream('custom://stalled-stream', 'eng', 900000, 50);
      let error: any = null;
      probePromise.catch((err) => {
        error = err;
      });

      await vi.advanceTimersByTimeAsync(50);

      expect(error).not.toBeNull();
      expect(error.message).toContain('ffprobe timed out after 50ms');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      mockSpawnChild = null;
    }
  });

  it('caps the remote-ffprobe fallback to timeoutMs if timeoutMs is smaller than probeTimeoutMs', async () => {
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();
    mockSpawnChild = mockChild;

    vi.useFakeTimers();

    try {
      const probePromise = findSubtitleStream('custom://stalled-stream', 'eng', 30, 5000);
      let error: any = null;
      probePromise.catch((err) => {
        error = err;
      });

      await vi.advanceTimersByTimeAsync(30);

      expect(error).not.toBeNull();
      expect(error.message).toContain('ffprobe timed out after 30ms');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      mockSpawnChild = null;
    }
  });

  it('defaults probeTimeoutMs to 15000ms when omitted', async () => {
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();
    mockSpawnChild = mockChild;

    vi.useFakeTimers();

    try {
      const probePromise = findSubtitleStream('custom://stalled-stream', 'eng', 900000);
      let error: any = null;
      probePromise.catch((err) => {
        error = err;
      });

      // After 5000ms it should NOT have timed out yet
      await vi.advanceTimersByTimeAsync(5000);
      expect(error).toBeNull();

      // At 15000ms it should time out
      await vi.advanceTimersByTimeAsync(10000);
      expect(error).not.toBeNull();
      expect(error.message).toContain('ffprobe timed out after 15000ms');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
      mockSpawnChild = null;
    }
  });
});

