import type { Word } from "@marz/format";

/** Word text without punctuation, lower case. */
export const norm = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}']+/gu, "");

/** Fillers that never carry meaning, in both languages, including stretched forms. */
const PURE = [
  /^u+m+$/, // um, umm, uum
  /^u+h+$/, // uh, uhh
  /^e+r+m+$/, // erm
  /^h+m+$/, // hmm
  /^ã+$/, // ã, ããã
  /^h+u+m+$/, // hum
  /^a+h+n+$/, // ahn
  /^éé+$/, // éé (a short é is the verb "is")
  /^ee+$/, // ee, eee
];

/** A lone "é" held this long between pauses is a filler, not the verb. */
export const LONE_E_MIN_US = 400_000;
const LONE_E_PAUSE_US = 150_000;

/** Words Claude decides on: filler in some places, meaningful in others. */
export const CONTEXT_FILLERS = ["é", "tipo", "né", "like", "you know", "so", "então", "assim", "basically"];

export function isPureFiller(word: Word, prevGapUs: number, nextGapUs: number): boolean {
  const t = norm(word.text);
  if (!t) return false;
  if (PURE.some((re) => re.test(t))) return true;
  if (t === "é" || t === "e")
    return word.endUs - word.startUs >= LONE_E_MIN_US && prevGapUs >= LONE_E_PAUSE_US && nextGapUs >= LONE_E_PAUSE_US;
  return false;
}
