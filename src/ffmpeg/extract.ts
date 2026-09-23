import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeVtt } from './vttUtils.js';

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
  timeoutMs = 900000,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'animesubs-extract-'));
  const outPath = join(dir, 'out.vtt');
  const isHttp = sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://');
  const httpArgs = isHttp
    ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
    : [];

  try {
    await runFfmpeg(
      [
        '-v', 'error',
        '-probesize', '1M',
        '-analyzeduration', '1M',
        ...httpArgs,
        '-i', sourceUrl,
        '-map', `0:${streamIndex}`,
        '-vn',
        '-an',
        '-dn',
        '-c:s', 'webvtt',
        '-y',
        outPath,
      ],
      timeoutMs,
    );
    return normalizeVtt(readFileSync(outPath, 'utf-8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function convertToVtt(
  inputContent: Buffer,
  inputExt: 'ass' | 'srt',
  timeoutMs = 30000,
): Promise<string> {
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
