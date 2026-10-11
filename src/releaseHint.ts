// What Stremio tells us about the file that is actually playing.
export interface ReleaseHint {
  filename?: string;
  size?: number;
}

export function parseReleaseHint(extra: string | undefined): ReleaseHint | undefined {
  if (!extra) return undefined;
  const params = new URLSearchParams(extra);
  const filename = params.get('filename')?.trim() || undefined;
  const rawSize = Number(params.get('videoSize'));
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : undefined;
  if (!filename && size === undefined) return undefined;
  return { ...(filename ? { filename } : {}), ...(size !== undefined ? { size } : {}) };
}
