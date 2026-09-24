import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  parseSubtitleStreams,
  isForcedOrSignsStream,
  findSubtitleStream,
  findSubtitleStreamFromBuffer,
  findSubtitleStreamFromBufferDetailed,
} from '../../src/ffmpeg/probe.js';
import { fetchBufferCapped } from '../../src/http/httpClient.js';

vi.mock('../../src/http/httpClient.js', () => ({
  fetchBufferCapped: vi.fn(),
}));

let mockSpawnChild: any = null;
vi.mock('node:child_process', () => ({
  spawn: vi.fn((...args: any[]) => {
    if (typeof mockSpawnChild === 'function') {
      return mockSpawnChild(...args);
    }
    return mockSpawnChild;
  }),
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

  it('rejects sign/song text stream and chooses full dialogue stream even if bitmap', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'subrip', tags: { language: 'eng', title: 'Songs & Signs' } },
        { index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng', title: 'Full' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'hdmv_pgs_subtitle' });
  });

  it('ignores streams with disposition: { forced: 1 } in favor of full dialogue stream', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', disposition: { forced: 1 }, tags: { language: 'eng', title: 'English' } },
        { index: 2, codec_name: 'ass', disposition: { forced: 0 }, tags: { language: 'eng', title: 'English' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('ignores streams with title containing "[Forced]" or "signs" in favor of full dialogue stream', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', tags: { language: 'eng', title: 'English [Forced]' } },
        { index: 2, codec_name: 'ass', tags: { language: 'eng', title: 'English Dialogue' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('prioritizes streams with disposition: { default: 1 } among dialogue streams', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', disposition: { default: 0 }, tags: { language: 'eng', title: 'Secondary Dialogue' } },
        { index: 2, codec_name: 'ass', disposition: { default: 1 }, tags: { language: 'eng', title: 'Default Dialogue' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toEqual({ index: 2, codec: 'ass' });
  });

  it('returns null when all streams for requested language are forced or signs/songs', () => {
    const output = JSON.stringify({
      streams: [
        { index: 1, codec_name: 'ass', disposition: { forced: 1 }, tags: { language: 'eng', title: 'Signs & Songs' } },
        { index: 2, codec_name: 'subrip', tags: { language: 'eng', title: 'English [Forced]' } },
      ],
    });
    const result = parseSubtitleStreams(output, 'eng');
    expect(result).toBeNull();
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

describe('isForcedOrSignsStream', () => {
  it('returns true when disposition.forced === 1', () => {
    expect(isForcedOrSignsStream({ index: 0, disposition: { forced: 1 } })).toBe(true);
  });

  it('returns true when title contains forced (case-insensitive)', () => {
    expect(isForcedOrSignsStream({ index: 0, tags: { title: 'English [FORCED]' } })).toBe(true);
  });

  it('returns true when title contains sign or song', () => {
    expect(isForcedOrSignsStream({ index: 0, tags: { title: 'Signs & Songs' } })).toBe(true);
    expect(isForcedOrSignsStream({ index: 0, tags: { title: 'Insert Song' } })).toBe(true);
    expect(isForcedOrSignsStream({ index: 0, tags: { title: 'Signs only' } })).toBe(true);
  });

  it('returns false for full dialogue streams', () => {
    expect(isForcedOrSignsStream({ index: 0, disposition: { forced: 0 }, tags: { title: 'English Dialogue' } })).toBe(false);
    expect(isForcedOrSignsStream({ index: 0, tags: { title: 'Full' } })).toBe(false);
    expect(isForcedOrSignsStream({ index: 0 })).toBe(false);
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

function createMockProcess(stdoutText = '', exitCode = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdoutText) {
      child.stdout.emit('data', stdoutText);
    }
    child.emit('close', exitCode);
  });
  return child;
}

describe('findSubtitleStreamFromBufferDetailed', () => {
  it('returns hasStreams: true and stream: null when streams exist but none match requested language', async () => {
    mockSpawnChild = () =>
      createMockProcess(
        JSON.stringify({
          streams: [{ index: 0, codec_name: 'subrip', tags: { language: 'fre', title: 'French' } }],
        }),
      );

    const result = await findSubtitleStreamFromBufferDetailed(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toEqual({ stream: null, hasStreams: true });
    mockSpawnChild = null;
  });

  it('returns hasStreams: true and matching stream when language matches', async () => {
    mockSpawnChild = () =>
      createMockProcess(
        JSON.stringify({
          streams: [{ index: 2, codec_name: 'ass', tags: { language: 'eng', title: 'Dialogue' } }],
        }),
      );

    const result = await findSubtitleStreamFromBufferDetailed(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toEqual({ stream: { index: 2, codec: 'ass' }, hasStreams: true });
    mockSpawnChild = null;
  });

  it('returns hasStreams: false and stream: null when buffer probe yields 0 streams', async () => {
    mockSpawnChild = () => createMockProcess(JSON.stringify({ streams: [] }));

    const result = await findSubtitleStreamFromBufferDetailed(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toEqual({ stream: null, hasStreams: false });
    mockSpawnChild = null;
  });

  it('returns hasStreams: false and stream: null when ffprobe fails on pipe:0', async () => {
    mockSpawnChild = () => createMockProcess('', 1);

    const result = await findSubtitleStreamFromBufferDetailed(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toEqual({ stream: null, hasStreams: false });
    mockSpawnChild = null;
  });
});

describe('findSubtitleStreamFromBuffer (backward compatibility)', () => {
  it('returns FoundSubtitleStream when matching language is present', async () => {
    mockSpawnChild = () =>
      createMockProcess(
        JSON.stringify({
          streams: [{ index: 1, codec_name: 'ass', tags: { language: 'eng', title: 'Dialogue' } }],
        }),
      );

    const result = await findSubtitleStreamFromBuffer(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toEqual({ index: 1, codec: 'ass' });
    mockSpawnChild = null;
  });

  it('returns null when streams exist but none match requested language', async () => {
    mockSpawnChild = () =>
      createMockProcess(
        JSON.stringify({
          streams: [{ index: 1, codec_name: 'ass', tags: { language: 'jpn', title: 'Japanese' } }],
        }),
      );

    const result = await findSubtitleStreamFromBuffer(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toBeNull();
    mockSpawnChild = null;
  });

  it('returns null when buffer probe fails', async () => {
    mockSpawnChild = () => createMockProcess('', 1);

    const result = await findSubtitleStreamFromBuffer(Buffer.from('dummy-mkv'), 'eng');
    expect(result).toBeNull();
    mockSpawnChild = null;
  });
});

describe('findSubtitleStream buffer fast-rejection', () => {
  it('does not fall through to remote ffprobe when buffer has valid stream headers for other languages', async () => {
    vi.mocked(fetchBufferCapped).mockResolvedValue(Buffer.from('mkv-2mb-buffer'));

    const spawnCalls: { command: string; args: string[] }[] = [];
    mockSpawnChild = (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      if (args.includes('pipe:0')) {
        return createMockProcess(
          JSON.stringify({
            streams: [
              { index: 0, codec_name: 'subrip', tags: { language: 'fre', title: 'French' } },
              { index: 1, codec_name: 'ass', tags: { language: 'jpn', title: 'Japanese' } },
            ],
          }),
        );
      }
      return createMockProcess('', 0);
    };

    const result = await findSubtitleStream('http://example.com/video.mkv', 'eng');

    expect(result).toBeNull();
    // Only pipe:0 should be probed, remote ffprobe URL should NOT have been invoked
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('pipe:0');
    expect(spawnCalls.some((c) => c.args.includes('http://example.com/video.mkv'))).toBe(false);

    mockSpawnChild = null;
  });

  it('returns buffer stream directly without calling remote ffprobe when match found', async () => {
    vi.mocked(fetchBufferCapped).mockResolvedValue(Buffer.from('mkv-2mb-buffer'));

    const spawnCalls: { command: string; args: string[] }[] = [];
    mockSpawnChild = (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      if (args.includes('pipe:0')) {
        return createMockProcess(
          JSON.stringify({
            streams: [{ index: 1, codec_name: 'ass', tags: { language: 'eng', title: 'Dialogue' } }],
          }),
        );
      }
      return createMockProcess('', 0);
    };

    const result = await findSubtitleStream('http://example.com/video.mkv', 'eng');

    expect(result).toEqual({ index: 1, codec: 'ass' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain('pipe:0');

    mockSpawnChild = null;
  });

  it('falls through to remote ffprobe when buffer probe yields hasStreams: false (e.g. truncated buffer)', async () => {
    vi.mocked(fetchBufferCapped).mockResolvedValue(Buffer.from('mkv-corrupt-buffer'));

    const spawnCalls: { command: string; args: string[] }[] = [];
    mockSpawnChild = (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      if (args.includes('pipe:0')) {
        // Buffer probe fails / cannot parse streams
        return createMockProcess('', 1);
      }
      // Remote URL probe succeeds
      return createMockProcess(
        JSON.stringify({
          streams: [{ index: 3, codec_name: 'subrip', tags: { language: 'eng', title: 'English' } }],
        }),
      );
    };

    const result = await findSubtitleStream('http://example.com/video.mkv', 'eng');

    expect(result).toEqual({ index: 3, codec: 'subrip' });
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].args).toContain('pipe:0');
    expect(spawnCalls[1].args).toContain('http://example.com/video.mkv');

    mockSpawnChild = null;
  });
});


