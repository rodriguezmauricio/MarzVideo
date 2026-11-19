import { aiEdits, captionEdits, type CaptionBreak, type Project, type Word } from "@marz/format";
import { keptSegments } from "@marz/timeline";

export type CaptionLook = "subtitles" | "highlight";
/** A caption word in output time (after cuts). */
export type CaptionWord = { id: string; text: string; startUs: number; endUs: number };
/** One line of caption text. Lines with the same `block` are shown together (at most two for
 * subtitles, always one for highlight). Times are output times. */
export type CaptionLine = { startUs: number; endUs: number; words: CaptionWord[]; block: number };

export const SUBTITLE_MAX_CHARS = 32;
export const HIGHLIGHT_MAX_WORDS = 4;
const HIGHLIGHT_MAX_CHARS = 22;
/** A pause longer than this starts a new line (and a new block). */
export const CAPTION_PAUSE_US = 600_000;
/** A block stays on screen this long after its last word, unless the next one starts sooner. */
export const CAPTION_HOLD_US = 500_000;

const sentenceEnd = (text: string) => /[.!?…]["')\]]*$/.test(text);
const lineChars = (ws: CaptionWord[]) => ws.reduce((n, w, i) => n + w.text.length + (i ? 1 : 0), 0);

/** Caption words in output time: words inside cuts and hidden words are gone, fixes applied. */
export function captionWords(project: Project, words: Word[]): CaptionWord[] {
  const segs = keptSegments(project.durationUs, project.edits.cuts);
  const { overrides, hidden } = captionEdits(project);
  const hide = new Set(hidden);
  const out: CaptionWord[] = [];
  for (const w of words) {
    if (hide.has(w.id)) continue;
    const text = (overrides[w.id] ?? w.text).trim();
    if (!text) continue;
    // A word counts as kept when its middle is kept; its end is clamped to that kept stretch.
    const mid = (w.startUs + w.endUs) / 2;
    const seg = segs.find((s) => mid >= s.srcStartUs && mid < s.srcEndUs);
    if (!seg) continue;
    const a = Math.max(w.startUs, seg.srcStartUs);
    const b = Math.min(w.endUs, seg.srcEndUs);
    out.push({ id: w.id, text, startUs: seg.outStartUs + (a - seg.srcStartUs), endUs: seg.outStartUs + (b - seg.srcStartUs) });
  }
  return out;
}

/** Caption lines for a look. Subtitles: up to 32 characters a line, two lines a block. Highlight:
 * one to four words a line. Both break at sentence ends and pauses. A "split" word always starts a
 * caption; a "join" word never does (a subtitle line still wraps by length, so a joined caption can
 * have more than two lines; a highlight line just grows). Empty when captions are off. */
export function captionLines(project: Project, words: Word[], look: CaptionLook): CaptionLine[] {
  if (!aiEdits(project).kinds.captions) return [];
  const cws = captionWords(project, words);
  const { breaks } = captionEdits(project);
  const lines: CaptionLine[] = [];
  let cur: CaptionWord[] = [];
  let block = 0;
  let linesInBlock = 0;
  const pushLine = () => {
    if (!cur.length) return;
    lines.push({ startUs: cur[0]!.startUs, endUs: cur[cur.length - 1]!.endUs, words: cur, block });
    linesInBlock++;
    cur = [];
  };
  const endBlock = () => {
    pushLine();
    if (linesInBlock > 0) block++;
    linesInBlock = 0;
  };
  for (let i = 0; i < cws.length; i++) {
    const w = cws[i]!;
    const prev = cws[i - 1];
    const brk = breaks[w.id];
    let blockBreak = !!prev && (w.startUs - prev.endUs > CAPTION_PAUSE_US || sentenceEnd(prev.text));
    if (brk === "split" && prev) blockBreak = true;
    if (brk === "join") blockBreak = false;
    if (blockBreak) endBlock();
    else if (cur.length > 0) {
      const tooLong =
        look === "subtitles"
          ? lineChars([...cur, w]) > SUBTITLE_MAX_CHARS
          : cur.length >= HIGHLIGHT_MAX_WORDS || lineChars([...cur, w]) > HIGHLIGHT_MAX_CHARS;
      if (tooLong && brk === "join") {
        // Joined: wrap the subtitle line inside the same caption; a highlight line keeps growing.
        if (look === "subtitles") pushLine();
      } else if (tooLong) {
        if (look === "highlight") endBlock();
        else {
          pushLine();
          if (linesInBlock >= 2) endBlock();
        }
      }
    }
    cur.push(w);
  }
  endBlock();
  return lines;
}

/** The ids of the words that start a caption (the first word of every block). */
export function captionStarts(lines: CaptionLine[]): Set<string> {
  const out = new Set<string>();
  let last = -1;
  for (const l of lines) {
    if (l.block !== last && l.words[0]) out.add(l.words[0].id);
    last = l.block;
  }
  return out;
}

/** The time a block is on screen: its first word to its last word plus the hold, cut short by the
 * next block. */
export function blockSpans(lines: CaptionLine[]): Array<{ block: number; startUs: number; endUs: number; lines: CaptionLine[] }> {
  const blocks: Array<{ block: number; startUs: number; endUs: number; lines: CaptionLine[] }> = [];
  for (const l of lines) {
    const last = blocks[blocks.length - 1];
    if (last && last.block === l.block) {
      last.lines.push(l);
      last.endUs = l.endUs;
    } else blocks.push({ block: l.block, startUs: l.startUs, endUs: l.endUs, lines: [l] });
  }
  for (let i = 0; i < blocks.length; i++) {
    const next = blocks[i + 1];
    blocks[i]!.endUs = Math.min(blocks[i]!.endUs + CAPTION_HOLD_US, next ? next.startUs : Infinity);
  }
  return blocks;
}

/** The `edits.captions.breaks` value that makes `wordId` start a caption (`wantStart`) or not:
 * a hand split or join is removed first when that is enough. Undefined when nothing changes (the
 * word already is, or is not, a start; or it is not in the captions at all). */
export function captionBreakFor(project: Project, words: Word[], look: CaptionLook, wordId: string, wantStart: boolean): CaptionBreak | null | undefined {
  const cur = captionEdits(project).breaks[wordId];
  const without: Project = cur
    ? (() => {
        const breaks = { ...(project.edits.captions?.breaks ?? {}) };
        delete breaks[wordId];
        return { ...project, edits: { ...project.edits, captions: { ...captionEdits(project), ...project.edits.captions, breaks } } };
      })()
    : project;
  const lines = captionLines(without, words, look);
  if (!lines.some((l) => l.words.some((w) => w.id === wordId))) return undefined;
  const startsWithout = captionStarts(lines).has(wordId);
  const want: CaptionBreak | null = wantStart ? (startsWithout ? null : "split") : startsWithout ? "join" : null;
  if (lines[0]!.words[0]!.id === wordId) return undefined;
  return want === (cur ?? null) ? undefined : want;
}

/** All transcript words (cut and hidden ones too) grouped into paragraphs, one per caption: a word
 * in `starts` opens a new paragraph once the current one holds a start. */
export function transcriptParagraphs(words: Word[], starts: Set<string>): Word[][] {
  const out: Word[][] = [];
  let hasStart = false;
  for (const w of words) {
    const start = starts.has(w.id);
    if (out.length === 0 || (start && hasStart)) {
      out.push([]);
      hasStart = false;
    }
    if (start) hasStart = true;
    out[out.length - 1]!.push(w);
  }
  return out;
}
