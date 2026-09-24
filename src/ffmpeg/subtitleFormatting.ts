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
