import { JAPANESE_CHAR_REGEX } from './assUtils.js';
import { resolveLinePosition, wrapSubtitleText } from './subtitleFormatting.js';

function finalizeCue(
  timing: string,
  rawTextLines: string[],
  targetLang = 'eng',
): { timing: string; textLines: string[] } | null {
  let isTop = timing.includes('line:10%');
  const isSignOrPositionedCue = timing.includes('position:') || (timing.includes('line:') && !timing.includes('line:90%,end'));
  const processedLines: string[] = [];

  const linesToProcess =
    targetLang === 'eng'
      ? rawTextLines.filter((l) => !JAPANESE_CHAR_REGEX.test(l))
      : rawTextLines;

  for (const rawLine of linesToProcess) {
    let line = rawLine;
    if (/\{[^}]*\\?an[789][^}]*\}/i.test(line)) {
      isTop = true;
      line = line.replace(/\{[^}]*\\?an[789][^}]*\}/gi, '');
    }

    // Strip remaining residual {...}
    line = line.replace(/\{[^}]*\}/g, '').trim();
    if (line) {
      if (!isTop && !isSignOrPositionedCue) {
        processedLines.push(...wrapSubtitleText(line).split('\n'));
      } else {
        processedLines.push(line);
      }
    }
  }

  if (processedLines.length === 0) return null;

  let finalTiming = timing;
  if (!finalTiming.includes('line:') && !finalTiming.includes('position:')) {
    finalTiming += ` ${resolveLinePosition(isTop)}`;
  }

  return { timing: finalTiming, textLines: processedLines };
}

export function normalizeVtt(vtt: string, targetLang = 'eng'): string {
  if (!vtt || typeof vtt !== 'string') return 'WEBVTT\n\n';
  if (!vtt.includes('-->')) return vtt;
  const lines = vtt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result: string[] = ['WEBVTT', ''];

  let cueIndex = 1;
  let inCue = false;
  let currentCueText: string[] = [];
  let currentTiming = '';

  const timingRegex = /^(\d{1,2}:)?(\d{2}):(\d{2}\.\d{3})\s+-->\s+(\d{1,2}:)?(\d{2}):(\d{2}\.\d{3})(.*)$/;

  function formatTimestamp(hours: string | undefined, minutes: string, secondsAndMillis: string): string {
    const h = hours ? hours.replace(':', '').padStart(2, '0') : '00';
    const m = minutes.padStart(2, '0');
    return `${h}:${m}:${secondsAndMillis}`;
  }

  function flushCue(): void {
    if (!currentTiming) return;
    const finalized = finalizeCue(currentTiming, currentCueText, targetLang);
    if (finalized) {
      result.push(String(cueIndex++));
      result.push(finalized.timing);
      result.push(...finalized.textLines);
      result.push('');
    }
    currentTiming = '';
    currentCueText = [];
    inCue = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === 'WEBVTT' || line.startsWith('WEBVTT ') || line.startsWith('NOTE') || line.startsWith('STYLE')) {
      continue;
    }
    const match = line.match(timingRegex);
    if (match) {
      flushCue();
      const start = formatTimestamp(match[1], match[2], match[3]);
      const end = formatTimestamp(match[4], match[5], match[6]);
      const settings = match[7] ? match[7].trim() : '';
      currentTiming = `${start} --> ${end}${settings ? ` ${settings}` : ''}`;
      inCue = true;
    } else if (inCue) {
      if (line === '') {
        flushCue();
      } else {
        currentCueText.push(line);
      }
    }
  }

  flushCue();

  return result.join('\n');
}

export function isAcceptableSubtitle(vtt: string, targetLang: string): boolean {
  if (!vtt || typeof vtt !== 'string') return false;
  if (targetLang !== 'eng') return vtt.includes('-->');

  const latinMatches = vtt.match(/[a-zA-Z]/g);
  const latinCount = latinMatches ? latinMatches.length : 0;
  if (latinCount < 20) return false;

  const jpMatches = vtt.match(new RegExp(JAPANESE_CHAR_REGEX.source, 'g'));
  const jpCount = jpMatches ? jpMatches.length : 0;

  // If Japanese characters are more than 25% of Latin characters, reject
  if (jpCount > latinCount * 0.25) return false;

  return true;
}

