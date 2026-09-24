// Line-position logic shared by the ASS->VTT converter and the WebVTT normalizer.

// ",end" anchors the bottom edge at 90% so multi-line cues grow upward instead of overflowing the frame.
export function resolveLinePosition(isTop: boolean): string {
  return isTop ? 'line:10%' : 'line:90%,end';
}

const HORIZONTAL_ALIGN = ['left', 'center', 'right'] as const;

// Maps a resolved ASS numpad alignment (1-9) plus optional \pos coordinates to WebVTT cue
// settings. Dialogue without \pos keeps the top/bottom-only convention (resolveLinePosition);
// \pos-carrying signs get precise position/line/align settings derived from the source
// resolution (compiled.width/height from ass-compiler, which falls back to a default if the
// ASS file's own [Script Info] omits PlayResX/PlayResY).
export function resolvePosition(
  alignment: number,
  pos: { x: number; y: number } | undefined,
  width: number | null,
  height: number | null,
): string {
  const isTop = alignment >= 7 && alignment <= 9;
  if (!pos || !width || !height) {
    return resolveLinePosition(isTop);
  }
  const horizontal = HORIZONTAL_ALIGN[(alignment - 1) % 3];
  const x = Math.round((pos.x / width) * 100);
  const y = Math.round((pos.y / height) * 100);
  return `position:${x}% line:${y}% align:${horizontal}`;
}

function visibleLength(str: string): number {
  return str.replace(/<[^>]+>/g, '').length;
}

function wrapSingleLine(line: string, maxLineLength: number): string {
  if (visibleLength(line) <= maxLineLength) return line;

  const words = line.split(' ');
  if (words.length <= 1) return line;

  const totalVis = visibleLength(line);
  if (totalVis <= maxLineLength * 2) {
    const mid = Math.floor(totalVis / 2);
    let bestWordIdx = -1;
    let minDistance = Infinity;

    let currentVis = 0;
    for (let i = 0; i < words.length - 1; i++) {
      currentVis += visibleLength(words[i]);
      const firstLineVis = currentVis;
      const secondLineVis = totalVis - currentVis - 1;
      if (firstLineVis <= maxLineLength && secondLineVis <= maxLineLength) {
        const dist = Math.abs(currentVis - mid);
        if (dist < minDistance) {
          minDistance = dist;
          bestWordIdx = i;
        }
      }
      currentVis += 1;
    }

    if (bestWordIdx !== -1) {
      const line1 = words.slice(0, bestWordIdx + 1).join(' ');
      const line2 = words.slice(bestWordIdx + 1).join(' ');
      return `${line1}\n${line2}`;
    }
  }

  const lines: string[] = [];
  let currentWords: string[] = [];
  let currentLen = 0;

  for (const word of words) {
    const wLen = visibleLength(word);
    if (currentWords.length === 0) {
      currentWords.push(word);
      currentLen = wLen;
    } else if (currentLen + 1 + wLen <= maxLineLength) {
      currentWords.push(word);
      currentLen += 1 + wLen;
    } else {
      lines.push(currentWords.join(' '));
      currentWords = [word];
      currentLen = wLen;
    }
  }
  if (currentWords.length > 0) {
    lines.push(currentWords.join(' '));
  }

  return lines.join('\n');
}

export function wrapSubtitleText(text: string, maxLineLength = 42): string {
  return text
    .split('\n')
    .map((line) => wrapSingleLine(line, maxLineLength))
    .join('\n');
}
