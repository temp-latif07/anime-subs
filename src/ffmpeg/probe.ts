import { spawn } from 'node:child_process';

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

export async function findSubtitleStream(
  sourceUrl: string,
  lang: string,
  timeoutMs = 30000,
): Promise<FoundSubtitleStream | null> {
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
    timeoutMs,
  );
  const parsed = JSON.parse(output) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const matching = streams.filter((s) => s.tags?.language === lang);
  if (matching.length === 0) return null;
  const dialogue = matching.find((s) => {
    const title = (s.tags?.title ?? '').toLowerCase();
    return !title.includes('sign') && !title.includes('song');
  });
  const selected = dialogue ?? matching[0];
  return {
    index: selected.index,
    codec: (selected.codec_name ?? 'ass').toLowerCase(),
  };
}

export async function findSubtitleStreamIndex(
  sourceUrl: string,
  lang: string,
  timeoutMs = 30000,
): Promise<number | null> {
  const result = await findSubtitleStream(sourceUrl, lang, timeoutMs);
  return result?.index ?? null;
}
