import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeVtt } from './vttUtils.js';
import { convertAssToVtt } from './assUtils.js';

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
  });
}

export async function extractSubtitleToVtt(
  sourceUrl: string,
  streamIndex: number,
  codecOrTimeout?: string | number,
  maybeTimeoutMs?: number,
): Promise<string> {
  const codec = typeof codecOrTimeout === 'string' ? codecOrTimeout.toLowerCase() : undefined;
  const timeoutMs = typeof codecOrTimeout === 'number'
    ? codecOrTimeout
    : (maybeTimeoutMs ?? 900000);

  const dir = mkdtempSync(join(tmpdir(), 'animesubs-extract-'));
  const isHttp = sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://');
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

  const baseArgs = [
    '-v', 'error',
    '-probesize', '1M',
    '-analyzeduration', '500k',
    ...httpArgs,
    '-i', sourceUrl,
    '-map', `0:${streamIndex}`,
    '-vn',
    '-an',
    '-dn',
  ];

  try {
    if (codec === 'ass' || codec === 'ssa') {
      const outAssPath = join(dir, 'out.ass');
      try {
        await runFfmpeg([...baseArgs, '-c:s', 'copy', '-y', outAssPath], timeoutMs);
        return convertAssToVtt(readFileSync(outAssPath, 'utf-8'));
      } catch {
        // Fall back to transcoding below
      }
    } else if (codec === 'subrip' || codec === 'srt') {
      const outSrtPath = join(dir, 'out.srt');
      try {
        await runFfmpeg([...baseArgs, '-c:s', 'copy', '-y', outSrtPath], timeoutMs);
        return convertToVtt(readFileSync(outSrtPath), 'srt');
      } catch {
        // Fall back to transcoding below
      }
    }

    // Default or fallback: transcode to WebVTT directly
    const outVttPath = join(dir, 'out.vtt');
    await runFfmpeg([...baseArgs, '-c:s', 'webvtt', '-y', outVttPath], timeoutMs);
    return normalizeVtt(readFileSync(outVttPath, 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function convertToVtt(
  inputContent: Buffer,
  inputExt: 'ass' | 'srt',
  timeoutMs = 30000,
): Promise<string> {
  if (inputExt === 'ass') {
    return convertAssToVtt(inputContent.toString('utf-8'));
  }
  const dir = mkdtempSync(join(tmpdir(), 'animesubs-convert-'));
  const inPath = join(dir, `in.${inputExt}`);
  const outPath = join(dir, 'out.vtt');
  try {
    writeFileSync(inPath, inputContent);
    await runFfmpeg(['-v', 'error', '-i', inPath, outPath], timeoutMs);
    return normalizeVtt(readFileSync(outPath, 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
