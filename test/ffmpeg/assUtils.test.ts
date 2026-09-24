import { describe, it, expect } from 'vitest';
import { convertAssToVtt, assColorToHex } from '../../src/ffmpeg/assUtils.js';

describe('assColorToHex', () => {
  it('converts ASS BGR hex colors to RGB hex colors', () => {
    expect(assColorToHex('&H0000FFFF&')).toBe('#FFFF00'); // Yellow
    expect(assColorToHex('&H00FF0000&')).toBe('#0000FF'); // Blue
    expect(assColorToHex('&H00FFFF00&')).toBe('#00FFFF'); // Cyan
    expect(assColorToHex('&H0000FF00&')).toBe('#00FF00'); // Green
    expect(assColorToHex('&H000000FF&')).toBe('#FF0000'); // Red
    expect(assColorToHex('&H00FFFFFF&')).toBe('#FFFFFF'); // White
  });

  it('handles formats without ampersands or with 6 hex digits', () => {
    expect(assColorToHex('&H00FFFF&')).toBe('#FFFF00');
    expect(assColorToHex('00FFFF')).toBe('#FFFF00');
    expect(assColorToHex('&H00FFFF')).toBe('#FFFF00');
  });

  it('returns null for invalid inputs', () => {
    expect(assColorToHex('')).toBeNull();
    expect(assColorToHex('invalid')).toBeNull();
  });
});

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

  it('converts inline color tags to <font color="#RRGGBB"> tags', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Yellow speaker
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('<font color="#FFFF00">Yellow speaker</font>');
  });

  it('applies non-white style colors to dialogue cues', () => {
    const ass = `[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
Style: CharacterCyan,Arial,20,&H00FFFF00,&H00000000,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,CharacterCyan,,0,0,0,,I am speaking in cyan!
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,I am default white.
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('<font color="#00FFFF">I am speaking in cyan!</font>');
    expect(vtt).toContain('I am default white.');
    expect(vtt).not.toContain('<font color="#FFFFFF">');
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

  it('does not add speaker dashes based on differing colors alone', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Are you ready?\\N{\\c&H00FF00&}Always!
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
    expect(vtt).toContain(
      '<font color="#FFFF00">Are you ready?</font>\n' +
      '<font color="#00FF00">Always!</font>'
    );
  });

  it('does not add speaker dashes when only one of two wrapped lines has a highlighted color', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\c&H00FFFF&}Highlighted word{\\c}\\NPlain second line
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).not.toContain('- ');
    expect(vtt).toContain('<font color="#FFFF00">Highlighted word</font>\nPlain second line');
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

  it('strips residual ASS override tags (pos, fad, k, blur, etc.)', () => {
    const ass = `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(192,200)\\fad(100,100)\\k50\\blur1.5}Clean spoken text
`;
    const vtt = convertAssToVtt(ass);
    expect(vtt).toContain('Clean spoken text');
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

  it('strips Opening and Ending song styles and karaoke cues', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
Style: OP - Romaji,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1
Style: ED - English,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,OP - Romaji,,0,0,0,,{\\k20}A{\\k30}no {\\k40}hi {\\k50}mita {\\k60}hana
Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Hello, how are you?
Dialogue: 0,0:00:20.00,0:00:23.00,ED - English,,0,0,0,,Like a bird in the sky
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Hello, how are you?');
    expect(vtt).not.toContain('Ano hi mita');
    expect(vtt).not.toContain('Like a bird in the sky');
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
    // Check that there are only 2 cues, not 3
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

  it('strips song styles named without a separator, like OP1, Opening, ED2', () => {
    const ass = `[Script Info]
Title: Test
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
Style: OP1,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1
Style: Opening,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,OP1,,0,0,0,,Romanized lyric line one
Dialogue: 0,0:00:04.00,0:00:06.00,Opening,,0,0,0,,Romanized lyric line two
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,Hello, how are you?
`;
    const vtt = convertAssToVtt(ass, 'eng');
    expect(vtt).toContain('Hello, how are you?');
    expect(vtt).not.toContain('Romanized lyric line one');
    expect(vtt).not.toContain('Romanized lyric line two');
  });
});

