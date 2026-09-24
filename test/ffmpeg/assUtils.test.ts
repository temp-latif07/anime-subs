import { describe, it, expect } from 'vitest';
import { convertAssToVtt } from '../../src/ffmpeg/assUtils.js';

describe('convertAssToVtt', () => {
  it('converts basic dialogue with normalized timestamps and sequential cue numbers', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:23.45,0:01:25.10,Default,,0,0,0,,Hello world!
Dialogue: 0,0:01:26.00,0:01:28.00,Default,,0,0,0,,Second line.
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toBe(
      'WEBVTT\n\n' +
      '1\n00:01:23.450 --> 00:01:25.100 line:90%,end\nHello world!\n\n' +
      '2\n00:01:26.000 --> 00:01:28.000 line:90%,end\nSecond line.\n'
    );
  });

  it('translates top-alignment \\an8 / \\an7 / \\an9 to line:10% cue position', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}Sign on top of screen
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Bottom dialogue
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000 line:10%\nSign on top of screen');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000 line:90%,end\nBottom dialogue');
  });

  it('preserves italics and bold tags cleanly', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Internal thought{\\i0} and {\\b1}shouting{\\b0}
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('<i>Internal thought</i> and <b>shouting</b>');
  });

  it('wraps underlined text in <u> tags', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\u1}Underlined{\\u0} text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('<u>Underlined</u> text');
  });

  it('does not add speaker dashes based on differing colors alone', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Are you ready?\\N{\\c&H00FF00&}Always!
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
    expect(vtt).toContain('Are you ready?\nAlways!');
  });

  it('does not add speaker dashes when only one of two wrapped lines has a highlighted color', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Highlighted word{\\c}\\NPlain second line
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
    expect(vtt).toContain('Highlighted word\nPlain second line');
  });

  it('preserves a dash the source subtitle already wrote on a line', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,- Are you ready?\\N- Always!
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('- Are you ready?\n- Always!');
  });

  it('does not synthesize a dash on a second line just because the first line has one', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,- Wait!\\NI told you
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('- Wait!\nI told you');
  });

  it('does not add dashes when a style color and an inline emphasis color both land on the same cue', () => {
    const ass = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CharacterCyan,Arial,20,&H00FFFF00,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,CharacterCyan,,0,0,0,,Some {\\c&H00FFFF&}word{\\c} here\\NPlain second line
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
  });

  it('extracts \\pos coordinates into position/line/align cue settings and strips other residual tags cleanly', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(192,200)\\fad(100,100)\\k50\\blur1.5}Clean spoken text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000 position:50% line:69% align:center\nClean spoken text');
    expect(vtt).not.toContain('\\pos');
    expect(vtt).not.toContain('\\fad');
    expect(vtt).not.toContain('{');
  });

  it('ignores drawing commands (\\p1)', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Actual text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('m 0 0');
    expect(vtt).toContain('Actual text');
  });

  it('filters out Japanese script lines from dual-language cues and drops pure Japanese cues', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,こんにちは\\NHello there!
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,おはようございます
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,I am doing well.
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Hello there!');
    expect(vtt).not.toContain('こんにちは');
    expect(vtt).not.toContain('おはようございます');
    expect(vtt).toContain('I am doing well.');
    const cues = vtt.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(2);
  });

  it('does not treat fullwidth Latin punctuation as Japanese', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Wait！ What was that？
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Wait！ What was that？');
  });

  it('maps \\pos-based signs to percent position/line/align across left, center, and right alignment', () => {
    const ass = `[Script Info]
PlayResX: 200
PlayResY: 100

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an7\\pos(0,0)}Top left sign
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\an8\\pos(100,50)}Top center sign
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\an9\\pos(200,100)}Top right sign
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.000 position:0% line:0% align:left\nTop left sign');
    expect(vtt).toContain('00:00:04.000 --> 00:00:06.000 position:50% line:50% align:center\nTop center sign');
    expect(vtt).toContain('00:00:07.000 --> 00:00:09.000 position:100% line:100% align:right\nTop right sign');
  });

  it('reads PlayResX/PlayResY from [Script Info] when present', () => {
    const ass = `[Script Info]
PlayResX: 1280
PlayResY: 720

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(640,360)}Centered sign
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('position:50% line:50% align:center');
  });

  it('falls back to 384x288 when [Script Info] omits PlayResX/PlayResY', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(192,144)}Centered sign
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('position:50% line:50% align:center');
  });

  it('returns an empty VTT document instead of throwing for malformed non-ASS input', () => {
    const garbage = 'this is not ass content at all\n{{{';
    expect(() => convertAssToVtt(garbage)).not.toThrow();
    expect(convertAssToVtt(garbage)).toBe('WEBVTT\n\n');
  });

  it('drops dialogue lines with zero or negative duration', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:03.00,Default,,0,0,0,,Reversed duration
Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,Zero duration
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Valid cue
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('Reversed duration');
    expect(vtt).not.toContain('Zero duration');
    expect(vtt).toContain('Valid cue');
    const cues = vtt.trim().split('\n\n').slice(1);
    expect(cues.length).toBe(1);
  });

  it('concatenates text across a mid-line style reset (\\r) into a single cue', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,First part {\\r}Second part
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('First part Second part');
  });
});
