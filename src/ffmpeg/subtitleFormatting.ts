// Line-position logic shared by the ASS->VTT converter and the WebVTT normalizer.

// ",end" anchors the bottom edge at 90% so multi-line cues grow upward instead of overflowing the frame.
export function resolveLinePosition(isTop: boolean): string {
  return isTop ? 'line:10%' : 'line:90%,end';
}
