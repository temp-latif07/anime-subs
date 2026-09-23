import { fetchJson, fetchBuffer } from '../http/httpClient.js';
import { convertToVtt } from '../ffmpeg/extract.js';
import type { ProviderResult } from '../types.js';

interface JimakuEntry {
  id: number;
  flags?: { anime: boolean; adult: boolean };
}

interface JimakuFile {
  name: string;
  url: string;
}

const LANGUAGE_TOKENS: Record<string, RegExp> = {
  eng: /\b(english|eng)\b|\[en\]/i,
};
const SUBTITLE_EXTENSIONS = /\.(srt|ass|vtt)$/i;
const EXCLUDED_LANGUAGE_TOKENS = /\b(japanese|jpn|jp)\b/i;

function matchesLanguage(filename: string, lang: string): boolean {
  if (!SUBTITLE_EXTENSIONS.test(filename)) return false;
  if (EXCLUDED_LANGUAGE_TOKENS.test(filename)) return false;
  const pattern = LANGUAGE_TOKENS[lang];
  return pattern ? pattern.test(filename) : false;
}

function extToVttInput(filename: string): 'ass' | 'srt' | 'vtt' | null {
  if (/\.ass$/i.test(filename)) return 'ass';
  if (/\.srt$/i.test(filename)) return 'srt';
  if (/\.vtt$/i.test(filename)) return 'vtt';
  return null;
}

export interface JimakuOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export async function findJimakuSubtitle(
  anilistId: number,
  episode: number,
  lang: string,
  apiKey: string,
  opts: JimakuOptions = {},
): Promise<ProviderResult> {
  const baseUrl = opts.baseUrl ?? 'https://jimaku.cc';
  const timeoutMs = opts.timeoutMs ?? 8000;

  const entries = await fetchJson<JimakuEntry[]>(
    `${baseUrl}/api/entries/search?anilist_id=${anilistId}`,
    { headers: { Authorization: apiKey }, timeoutMs },
  );
  const entry = entries.find((e) => e.flags?.anime && !e.flags?.adult);
  if (!entry) return { found: false, seriesNotFound: true };

  const files = await fetchJson<JimakuFile[]>(
    `${baseUrl}/api/entries/${entry.id}/files?episode=${episode}`,
    { headers: { Authorization: apiKey }, timeoutMs },
  );
  const match = files.find((f) => matchesLanguage(f.name, lang));
  if (!match) return { found: false };

  const ext = extToVttInput(match.name);
  if (!ext) return { found: false };

  const raw = await fetchBuffer(match.url, { timeoutMs });
  const vttContent = ext === 'vtt' ? raw.toString('utf-8') : await convertToVtt(raw, ext);
  return { found: true, vttContent };
}
