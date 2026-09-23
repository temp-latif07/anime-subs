import { describe, it, expect } from 'vitest';
import { normalizeVtt } from '../../src/ffmpeg/vttUtils.js';

describe('normalizeVtt', () => {
  it('normalizes MM:SS.mmm timestamps to HH:MM:SS.mmm and adds cue numbers', () => {
    const raw = 'WEBVTT\n\n00:04.630 --> 00:06.250\nHmm.\n\n00:06.250 --> 00:07.230\nWhat\'s wrong?\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toBe(
      'WEBVTT\n\n' +
      '1\n00:00:04.630 --> 00:00:06.250\nHmm.\n\n' +
      '2\n00:00:06.250 --> 00:00:07.230\nWhat\'s wrong?\n'
    );
  });

  it('preserves existing hours in timestamps and existing settings', () => {
    const raw = 'WEBVTT\n\n01:22:11.720 --> 01:22:12.660 line:90%\nGood night.\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toBe(
      'WEBVTT\n\n' +
      '1\n01:22:11.720 --> 01:22:12.660 line:90%\nGood night.\n'
    );
  });

  it('handles multiline cue texts and re-indexes cues cleanly', () => {
    const raw = 'WEBVTT\n\n999\n00:08.270 --> 00:11.580\nThe milk tea\nstill seems cold.\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toBe(
      'WEBVTT\n\n' +
      '1\n00:00:08.270 --> 00:00:11.580\nThe milk tea\nstill seems cold.\n'
    );
  });

  it('handles empty or non-string inputs safely', () => {
    expect(normalizeVtt('')).toBe('WEBVTT\n\n');
    expect(normalizeVtt(null as any)).toBe('WEBVTT\n\n');
  });

  it('translates residual top alignment tags to line:10% setting', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n{\\an8}Top of screen\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toBe(
      'WEBVTT\n\n' +
      '1\n00:00:01.000 --> 00:00:03.000 line:10%\nTop of screen\n'
    );
  });

  it('translates residual ASS color tags into font color tags', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n{c&H00FFFF&}Yellow speaker\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toContain('<font color="#FFFF00">Yellow speaker</font>');
  });

  it('formats dual-speaker cues with hyphens when different colors are present', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n<font color="#FFFF00">Line A</font>\n<font color="#0000FF">Line B</font>\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toContain(
      '- <font color="#FFFF00">Line A</font>\n' +
      '- <font color="#0000FF">Line B</font>'
    );
  });
});
