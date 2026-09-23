export function assColorToHex(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/^&?[hH]?([0-9a-fA-F]{1,8})&?$/);
  if (!match) return null;
  let hex = match[1].padStart(6, '0');
  if (hex.length === 8) hex = hex.slice(2); // strip alpha if AABBGGRR
  if (hex.length !== 6) return null;
  const b = hex.slice(0, 2);
  const g = hex.slice(2, 4);
  const r = hex.slice(4, 6);
  return '#' + (r + g + b).toUpperCase();
}

function formatAssTime(timeStr: string): string {
  const parts = timeStr.trim().split(':');
  let h = '00';
  let m = '00';
  let s = '00';
  let ms = '000';
  if (parts.length === 3) {
    h = parts[0].padStart(2, '0');
    m = parts[1].padStart(2, '0');
    const secParts = parts[2].split('.');
    s = secParts[0].padStart(2, '0');
    ms = (secParts[1] || '0').padEnd(3, '0').slice(0, 3);
  } else if (parts.length === 2) {
    m = parts[0].padStart(2, '0');
    const secParts = parts[1].split('.');
    s = secParts[0].padStart(2, '0');
    ms = (secParts[1] || '0').padEnd(3, '0').slice(0, 3);
  }
  return `${h}:${m}:${s}.${ms}`;
}

interface AssCue {
  start: string;
  end: string;
  settings: string;
  text: string;
}

export const JAPANESE_CHAR_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF]/;
const SONG_STYLE_REGEX = /^(op|ed|song|karaoke|lyrics|insert|music)\b|kanji|romaji/i;
const KARAOKE_TAG_REGEX = /\{[^}]*\\k[f|o]?[0-9]+[^}]*\}/i;

export function convertAssToVtt(ass: string, targetLang?: string): string {
  if (!ass || typeof ass !== 'string') return 'WEBVTT\n\n';

  const lines = ass.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const styleColors = new Map<string, string>();
  let inStyles = false;
  let inEvents = false;
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];

  const cues: AssCue[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('[V4+ Styles]') || line.startsWith('[V4 Styles]')) {
      inStyles = true;
      inEvents = false;
      continue;
    } else if (line.startsWith('[Events]')) {
      inEvents = true;
      inStyles = false;
      continue;
    } else if (line.startsWith('[')) {
      inStyles = false;
      inEvents = false;
      continue;
    }

    if (inStyles) {
      if (line.startsWith('Format:')) {
        styleFormat = line.substring(7).split(',').map((s) => s.trim().toLowerCase());
      } else if (line.startsWith('Style:')) {
        const values = line.substring(6).split(',').map((s) => s.trim());
        const nameIdx = styleFormat.indexOf('name');
        const colorIdx = styleFormat.indexOf('primarycolour');
        if (nameIdx !== -1 && colorIdx !== -1 && values[nameIdx] && values[colorIdx]) {
          const hex = assColorToHex(values[colorIdx]);
          if (hex && hex !== '#FFFFFF') {
            styleColors.set(values[nameIdx], hex);
          }
        }
      }
    } else if (inEvents) {
      if (line.startsWith('Format:')) {
        eventFormat = line.substring(7).split(',').map((s) => s.trim().toLowerCase());
      } else if (line.startsWith('Dialogue:')) {
        const textIdx = eventFormat.indexOf('text');
        const startIdx = eventFormat.indexOf('start');
        const endIdx = eventFormat.indexOf('end');
        const styleIdx = eventFormat.indexOf('style');

        const commaCount = eventFormat.length - 1;
        const parts: string[] = [];
        let curr = line.substring(9);
        for (let i = 0; i < commaCount; i++) {
          const idx = curr.indexOf(',');
          if (idx === -1) break;
          parts.push(curr.substring(0, idx).trim());
          curr = curr.substring(idx + 1);
        }
        parts.push(curr); // remaining is text

        const start = parts[startIdx];
        const end = parts[endIdx];
        const style = parts[styleIdx] || '';
        let text = parts[textIdx] || '';

        if (targetLang === 'eng') {
          if (SONG_STYLE_REGEX.test(style) || KARAOKE_TAG_REGEX.test(text)) {
            continue;
          }
        }

        // Strip drawing commands: {\p1}...{\p0} or unclosed {\p1}...
        text = text.replace(/\{[^}]*\\p[1-9][^}]*\}.*?(\{[^}]*\\p0[^}]*\}|$)/gis, '');
        if (text.trim() === '') continue;

        // Top alignment: \an7, \an8, \an9
        const isTop = /\{[^}]*\\an[789][^}]*\}/i.test(text);

        // Normalize line breaks
        text = text.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');

        // Convert formatting
        text = text
          .replace(/\{\\i1?\}/gi, '<i>')
          .replace(/\{\\i0\}/gi, '</i>')
          .replace(/\{\\b1?\}/gi, '<b>')
          .replace(/\{\\b0\}/gi, '</b>')
          .replace(/\{\\u1?\}/gi, '<u>')
          .replace(/\{\\u0\}/gi, '</u>');

        // Color handling
        const linesOfText = text.split('\n');
        const processedLines = linesOfText
          .map((l) => {
            let lineText = l;
            let openFont = false;
            lineText = lineText.replace(/\{\\1?c(&?[hH]?[0-9a-fA-F]+&?)\}/gi, (_, colorCode) => {
              const hex = assColorToHex(colorCode);
              const prefix = openFont ? '</font>' : '';
              if (hex && hex !== '#FFFFFF') {
                openFont = true;
                return `${prefix}<font color="${hex}">`;
              }
              openFont = false;
              return prefix;
            });
            lineText = lineText.replace(/\{\\1?c\}/gi, () => {
              if (openFont) {
                openFont = false;
                return '</font>';
              }
              return '';
            });
            if (openFont) {
              lineText += '</font>';
            }

            // Strip remaining override tags
            lineText = lineText.replace(/\{[^}]*\}/g, '').trim();

            // If no inline color, apply style color
            if (!lineText.includes('<font') && styleColors.has(style)) {
              lineText = `<font color="${styleColors.get(style)}">${lineText}</font>`;
            }
            return lineText;
          })
          .filter(Boolean)
          .filter((l) => (targetLang === 'eng' ? !JAPANESE_CHAR_REGEX.test(l) : true));

        if (processedLines.length === 0) continue;

        // Dual speaker detection
        let formattedText = '';
        if (processedLines.length > 1) {
          const hasDifferentColors =
            processedLines.some((l) => l.includes('<font')) &&
            processedLines[0].match(/color="([^"]+)"/)?.[1] !==
              processedLines[1].match(/color="([^"]+)"/)?.[1];
          const hasExistingDash = processedLines.some((l) => l.startsWith('- '));
          if (hasDifferentColors || hasExistingDash) {
            formattedText = processedLines
              .map((l) => (l.startsWith('- ') ? l : `- ${l}`))
              .join('\n');
          } else {
            formattedText = processedLines.join('\n');
          }
        } else {
          formattedText = processedLines[0];
        }

        const settings = isTop ? ' line:10%' : '';
        cues.push({
          start: formatAssTime(start),
          end: formatAssTime(end),
          settings,
          text: formattedText,
        });
      }
    }
  }

  // Sort cues by start timestamp
  cues.sort((a, b) => a.start.localeCompare(b.start));

  if (cues.length === 0) return 'WEBVTT\n\n';
  const cuesContent = cues
    .map((c, i) => `${i + 1}\n${c.start} --> ${c.end}${c.settings}\n${c.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${cuesContent}\n`;
}
