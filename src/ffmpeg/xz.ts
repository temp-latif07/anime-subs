import { spawn } from 'node:child_process';

export function decompressXz(input: Buffer, timeoutMs = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('xz', ['-d', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`xz decompression timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => {
      // Ignore stdin errors (e.g. EPIPE when xz exits early on invalid data)
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`xz exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
