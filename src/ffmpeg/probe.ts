import { spawn } from 'node:child_process';
import { fetchBufferCapped } from '../http/httpClient.js';

export interface FoundSubtitleStream {
  index: number;
  codec: string;
}

interface FfprobeStream {
  index: number;
  codec_name?: string;
  tags?: { language?: string; title?: string };
}
interface FfprobeOutput {
  streams: FfprobeStream[];
}

export function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export function runCommandWithInput(
  command: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();
  });
}

const TEXT_SUBTITLE_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text']);

export function parseSubtitleStreams(output: string, lang: string): FoundSubtitleStream | null {
  try {
    const parsed = JSON.parse(output) as FfprobeOutput;
    const streams = parsed.streams ?? [];
    const matching = streams.filter((s) => s.tags?.language === lang);
    if (matching.length === 0) return null;

    const textStreams = matching.filter((s) => TEXT_SUBTITLE_CODECS.has((s.codec_name ?? '').toLowerCase()));
    const pool = textStreams.length > 0 ? textStreams : matching;

    const dialogue = pool.find((s) => {
      const title = (s.tags?.title ?? '').toLowerCase();
      return !title.includes('sign') && !title.includes('song');
    });
    const selected = dialogue ?? pool[0];
    return {
      index: selected.index,
      codec: (selected.codec_name ?? 'ass').toLowerCase(),
    };
  } catch {
    return null;
  }
}

export async function findSubtitleStreamFromBuffer(
  buffer: Buffer,
  lang: string,
  timeoutMs = 10000,
): Promise<FoundSubtitleStream | null> {
  try {
    const output = await runCommandWithInput(
      'ffprobe',
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-select_streams', 's',
        '-i', 'pipe:0',
      ],
      buffer,
      timeoutMs,
    );
    return parseSubtitleStreams(output, lang);
  } catch {
    return null;
  }
}

export async function findSubtitleStream(
  sourceUrl: string,
  lang: string,
  timeoutMs = 30000,
  probeTimeoutMs = 15000,
): Promise<FoundSubtitleStream | null> {
  const isHttp = sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://');

  if (isHttp) {
    try {
      const rangeBuffer = await fetchBufferCapped(sourceUrl, 2097152, {
        headers: { Range: 'bytes=0-2097151' },
        timeoutMs: Math.min(timeoutMs, 5000),
      });
      if (rangeBuffer.length > 0) {
        const fromBuffer = await findSubtitleStreamFromBuffer(rangeBuffer, lang, 5000);
        if (fromBuffer !== null) return fromBuffer;
      }
    } catch {
      // Fall through to remote URL ffprobe
    }
  }

  const httpArgs = isHttp
    ? [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '2',
        '-reconnect_on_network_error', '1',
        '-multiple_requests', '1',
        '-short_seek_size', '2097152',
        '-tcp_nodelay', '1',
        '-recv_buffer_size', '4194304',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ]
    : [];

  const output = await runCommand(
    'ffprobe',
    [
      '-v', 'quiet',
      '-probesize', '1M',
      '-analyzeduration', '1M',
      ...httpArgs,
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 's',
      sourceUrl,
    ],
    Math.min(timeoutMs, probeTimeoutMs),
  );
  return parseSubtitleStreams(output, lang);
}

export async function findSubtitleStreamIndex(
  sourceUrl: string,
  lang: string,
  timeoutMs = 30000,
  probeTimeoutMs = 15000,
): Promise<number | null> {
  const result = await findSubtitleStream(sourceUrl, lang, timeoutMs, probeTimeoutMs);
  return result?.index ?? null;
}
