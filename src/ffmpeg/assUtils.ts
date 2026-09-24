import { compile } from 'ass-compiler';
import { resolvePosition, wrapSubtitleText } from './subtitleFormatting.js';

export const JAPANESE_CHAR_REGEX = /[぀-ゟ゠-ヿ一-鿿㐀-䶿]/;

function formatVttTime(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

interface FragmentTag {
  b?: 0 | 1;
  i?: 0 | 1;
  u?: 0 | 1;
}

function renderFragmentText(tag: FragmentTag, rawText: string): string {
  let text = rawText.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  if (tag.b) text = `<b>${text}</b>`;
  if (tag.i) text = `<i>${text}</i>`;
  if (tag.u) text = `<u>${text}</u>`;
  return text;
}

interface CompiledDialogue {
  start: number;
  end: number;
  alignment: number;
  pos?: { x: number; y: number };
  slices: { fragments: { tag: FragmentTag; text: string }[] }[];
}

function buildCueText(dialogue: CompiledDialogue, targetLang?: string): string | null {
  let combined = '';
  for (const slice of dialogue.slices) {
    for (const fragment of slice.fragments) {
      combined += renderFragmentText(fragment.tag, fragment.text);
    }
  }
  const lines = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => (targetLang === 'eng' ? !JAPANESE_CHAR_REGEX.test(line) : true));
  if (lines.length === 0) return null;
  return lines.join('\n');
}

export function convertAssToVtt(ass: string, targetLang?: string): string {
  if (!ass || typeof ass !== 'string') return 'WEBVTT\n\n';

  let compiled;
  try {
    compiled = compile(ass, { defaultInfo: { PlayResX: 384, PlayResY: 288 } });
  } catch {
    return 'WEBVTT\n\n';
  }

  const cuesContent: string[] = [];
  let index = 1;
  for (const dialogue of compiled.dialogues as CompiledDialogue[]) {
    const rawText = buildCueText(dialogue, targetLang);
    if (!rawText) continue;
    const isSign = Boolean(dialogue.pos);
    const isTop = dialogue.alignment >= 7 && dialogue.alignment <= 9;
    const text = isSign || isTop ? rawText : wrapSubtitleText(rawText);
    const settings = resolvePosition(dialogue.alignment, dialogue.pos, compiled.width, compiled.height);
    const start = formatVttTime(dialogue.start);
    const end = formatVttTime(dialogue.end);
    cuesContent.push(`${index++}\n${start} --> ${end} ${settings}\n${text}`);
  }

  if (cuesContent.length === 0) return 'WEBVTT\n\n';
  return `WEBVTT\n\n${cuesContent.join('\n\n')}\n`;
}
