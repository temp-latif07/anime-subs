export function normalizeVtt(vtt: string): string {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === 'WEBVTT' || line.startsWith('WEBVTT ') || line.startsWith('NOTE') || line.startsWith('STYLE')) {
      continue;
    }
    const match = line.match(timingRegex);
    if (match) {
      if (currentTiming) {
        result.push(String(cueIndex++));
        result.push(currentTiming);
        result.push(...currentCueText);
        result.push('');
        currentCueText = [];
      }
      const start = formatTimestamp(match[1], match[2], match[3]);
      const end = formatTimestamp(match[4], match[5], match[6]);
      const settings = match[7] ? match[7].trim() : '';
      currentTiming = `${start} --> ${end}${settings ? ` ${settings}` : ''}`;
      inCue = true;
    } else if (inCue) {
      if (line === '') {
        if (currentTiming) {
          result.push(String(cueIndex++));
          result.push(currentTiming);
          result.push(...currentCueText);
          result.push('');
          currentTiming = '';
          currentCueText = [];
          inCue = false;
        }
      } else {
        currentCueText.push(line);
      }
    }
  }

  if (currentTiming) {
    result.push(String(cueIndex++));
    result.push(currentTiming);
    result.push(...currentCueText);
    result.push('');
  }

  return result.join('\n');
}
