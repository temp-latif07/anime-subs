import { spawn } from 'node:child_process';

interface FfprobeStream {
  index: number;
  tags?: { language?: string };
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

export async function findSubtitleStreamIndex(
  sourceUrl: string,
  lang: string,
  timeoutMs = 30000,
): Promise<number | null> {
  const output = await runCommand(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 's', sourceUrl],
    timeoutMs,
  );
  const parsed = JSON.parse(output) as FfprobeOutput;
  const match = (parsed.streams ?? []).find((s) => s.tags?.language === lang);
  return match ? match.index : null;
}
