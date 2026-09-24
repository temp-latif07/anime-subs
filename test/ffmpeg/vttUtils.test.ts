import { describe, it, expect } from 'vitest';
import { normalizeVtt, isAcceptableSubtitle } from '../../src/ffmpeg/vttUtils.js';

describe('normalizeVtt', () => {
  it('normalizes MM:SS.mmm timestamps to HH:MM:SS.mmm and adds cue numbers', () => {
    const raw = 'WEBVTT\n\n00:04.630 --> 00:06.250\nHmm.\n\n00:06.250 --> 00:07.230\nWhat\'s wrong?\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toBe(
      'WEBVTT\n\n' +
      '1\n00:00:04.630 --> 00:00:06.250 line:90%,end\nHmm.\n\n' +
      '2\n00:00:06.250 --> 00:00:07.230 line:90%,end\nWhat\'s wrong?\n'
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
      '1\n00:00:08.270 --> 00:00:11.580 line:90%,end\nThe milk tea\nstill seems cold.\n'
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

  it('strips residual ASS color tags from cues', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n{c&H00FFFF&}Yellow speaker\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toContain('Yellow speaker');
    expect(normalized).not.toContain('<font');
  });

  it('preserves words with ca, ci, ac, ce, cc letter combinations without corruption', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\nBecause of the accident, I decided to practice and dance in the cinema with a cat.\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toContain('Because of the accident, I decided to\npractice and dance in the cinema with a\ncat.');
  });

  it('does not add speaker dashes based on differing colors alone', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n<font color="#FFFF00">Line A</font>\n<font color="#0000FF">Line B</font>\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).not.toContain('- ');
    expect(normalized).toContain(
      '<font color="#FFFF00">Line A</font>\n' +
      '<font color="#0000FF">Line B</font>'
    );
  });

  it('does not add speaker dashes when only one of two wrapped lines has a highlighted color', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n<font color="#FFFF00">Highlighted word</font>\nPlain second line\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).not.toContain('- ');
    expect(normalized).toContain('<font color="#FFFF00">Highlighted word</font>\nPlain second line');
  });

  it('preserves a dash the source subtitle already wrote on a line', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n- Are you ready?\n- Always!\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toContain('- Are you ready?\n- Always!');
  });

  it('does not synthesize a dash on a second line just because the first line has one', () => {
    const raw = 'WEBVTT\n\n00:01.000 --> 00:03.000\n- Wait!\nI told you\n';
    const normalized = normalizeVtt(raw);
    expect(normalized).toContain('- Wait!\nI told you');
  });

  it('strips Japanese lines from WebVTT cues when target language is English', () => {
    const input = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
こんにちは
Hello world!

2
00:00:04.000 --> 00:00:06.000
さようなら

3
00:00:07.000 --> 00:00:09.000
Goodbye!
`;
    const result = normalizeVtt(input, 'eng');
    expect(result).toContain('Hello world!');
    expect(result).not.toContain('こんにちは');
    expect(result).not.toContain('さようなら');
    expect(result).toContain('Goodbye!');
    const cues = result.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(2);
  });

  it('automatically wraps long bottom dialogue lines in normalizeVtt', () => {
    const input = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nI was thinking that we might find something that could help.\n`;
    const result = normalizeVtt(input, 'eng');
    expect(result).toContain('I was thinking that we might\nfind something that could help.');
  });

  it('does not wrap sign or positioned cues in normalizeVtt', () => {
    const input = `WEBVTT\n\n1\n00:00:04.000 --> 00:00:06.000 position:26% line:17% align:center\nI was thinking that we might find something that could help.\n`;
    const result = normalizeVtt(input, 'eng');
    expect(result).toContain('position:26% line:17% align:center\nI was thinking that we might find something that could help.');
    expect(result).not.toContain('I was thinking that we might\nfind');
  });

  it('preserves top-aligned line:10% cues without wrapping in normalizeVtt', () => {
    const input = `WEBVTT\n\n1\n00:00:04.000 --> 00:00:06.000 line:10%\nI was thinking that we might find something that could help.\n`;
    const result = normalizeVtt(input, 'eng');
    expect(result).toContain('line:10%\nI was thinking that we might find something that could help.');
  });
});

describe('isAcceptableSubtitle', () => {
  it('validates acceptable subtitles for English', () => {
    const goodEnglish = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nThis is a normal English dialogue subtitle track.\n`;
    const pureJapanese = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nこれは日本語の字幕です。英語はありません。\n`;
    const emptyVtt = `WEBVTT\n\n`;

    expect(isAcceptableSubtitle(goodEnglish, 'eng')).toBe(true);
    expect(isAcceptableSubtitle(pureJapanese, 'eng')).toBe(false);
    expect(isAcceptableSubtitle(emptyVtt, 'eng')).toBe(false);
  });

  it('rejects subtitles with fewer than 20 Latin characters for English', () => {
    const tooShort = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nHello!\n`;
    expect(isAcceptableSubtitle(tooShort, 'eng')).toBe(false);
  });

  it('rejects subtitles where Japanese characters exceed 25% of Latin characters', () => {
    // 25 Latin letters, 10 Japanese characters -> 10 > 25 * 0.25 (6.25) -> false
    const mixedPredominantlyJapanese = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nThis is English dialogue. ここにはたくさんの日本語のテキストがあります。\n`;
    expect(isAcceptableSubtitle(mixedPredominantlyJapanese, 'eng')).toBe(false);
  });

  it('accepts subtitles where Japanese characters are within 25% of Latin characters', () => {
    // Over 100 Latin letters with just one Japanese loanword/character
    const mostlyEnglishWithKanji = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nWelcome to our special presentation of the festival today, everyone enjoy!\n\n2\n00:00:04.000 --> 00:00:06.000\nSensei 先生, please wait for us over here!\n`;
    expect(isAcceptableSubtitle(mostlyEnglishWithKanji, 'eng')).toBe(true);
  });

  it('handles non-English target languages by checking for cue timestamps', () => {
    const validJapanese = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nこれは日本語の字幕です。\n`;
    expect(isAcceptableSubtitle(validJapanese, 'jpn')).toBe(true);
    expect(isAcceptableSubtitle('WEBVTT\n\n', 'jpn')).toBe(false);
  });

  it('handles empty or non-string inputs safely', () => {
    expect(isAcceptableSubtitle('', 'eng')).toBe(false);
    expect(isAcceptableSubtitle(null as any, 'eng')).toBe(false);
  });
});

