import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSubtitleStreamIndex, findSubtitleStream } from '../../src/ffmpeg/probe.js';
import { extractSubtitleToVtt, convertToVtt } from '../../src/ffmpeg/extract.js';

describe('ffmpeg subtitle extraction (real ffmpeg/ffprobe subprocess)', () => {
  let dir: string;
  let mkvPath: string;
  let assMkvPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'animesubs-fixture-'));
    const srtPath = join(dir, 'sample.srt');
    writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:02,000\nHello from a test fixture\n');
    mkvPath = join(dir, 'sample.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2',
      '-f', 'srt', '-i', srtPath,
      '-map', '0:v', '-map', '1:s',
      '-c:v', 'libx264', '-c:s', 'srt',
      '-metadata:s:s:0', 'language=eng',
      mkvPath,
    ]);

    const assPath = join(dir, 'sample.ass');
    writeFileSync(
      assPath,
      '[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Hello from ASS fixture\n',
    );
    assMkvPath = join(dir, 'sample-ass.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2',
      '-i', assPath,
      '-map', '0:v', '-map', '1:s',
      '-c:v', 'libx264', '-c:s', 'ass',
      '-metadata:s:s:0', 'language=eng',
      assMkvPath,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the English subtitle stream index via ffprobe', async () => {
    expect(await findSubtitleStreamIndex(mkvPath, 'eng')).toBe(1);
  });

  it('finds subtitle stream with codec name via findSubtitleStream', async () => {
    const stream = await findSubtitleStream(mkvPath, 'eng');
    expect(stream).toEqual({ index: 1, codec: 'subrip' });
  });

  it('finds ASS subtitle stream with codec name via findSubtitleStream', async () => {
    const stream = await findSubtitleStream(assMkvPath, 'eng');
    expect(stream).toEqual({ index: 1, codec: 'ass' });
  });

  it('returns null when no stream matches the requested language', async () => {
    expect(await findSubtitleStreamIndex(mkvPath, 'spa')).toBeNull();
    expect(await findSubtitleStream(mkvPath, 'spa')).toBeNull();
  });

  it('extracts the subtitle stream as WebVTT containing the known text', async () => {
    const vtt = await extractSubtitleToVtt(mkvPath, 1, 'subrip');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Hello from a test fixture');
  });

  it('extracts ASS subtitle stream via stream copy as WebVTT', async () => {
    const vtt = await extractSubtitleToVtt(assMkvPath, 1, 'ass');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Hello from ASS fixture');
  });

  it('converts a standalone SRT buffer to WebVTT', async () => {
    const srtContent = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nStandalone conversion\n');
    const vtt = await convertToVtt(srtContent, 'srt');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Standalone conversion');
  });

  it('converts a standalone ASS buffer to WebVTT', async () => {
    const assContent = Buffer.from(
      '[Script Info]\nTitle: Test\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Standalone ASS conversion\n',
    );
    const vtt = await convertToVtt(assContent, 'ass');
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Standalone ASS conversion');
  });

  it('rejects when ffprobe fails on non-existent file', async () => {
    await expect(findSubtitleStreamIndex(join(dir, 'nonexistent.mkv'), 'eng')).rejects.toThrow();
  });

  it('rejects when extractSubtitleToVtt fails on invalid stream index or file', async () => {
    await expect(extractSubtitleToVtt(join(dir, 'nonexistent.mkv'), 99)).rejects.toThrow();
  });
});
