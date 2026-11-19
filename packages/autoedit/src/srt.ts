import { blockSpans, type CaptionLine } from "./captions";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function srtTime(us: number): string {
  const msTotal = Math.max(0, Math.round(us / 1000));
  const h = Math.floor(msTotal / 3_600_000);
  const m = Math.floor((msTotal % 3_600_000) / 60_000);
  const s = Math.floor((msTotal % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msTotal % 1000, 3)}`;
}

/** SubRip text for subtitle lines (one cue per block, its lines on separate rows), CRLF line ends. */
export function toSrt(lines: CaptionLine[]): string {
  return blockSpans(lines)
    .map((b, i) => [String(i + 1), `${srtTime(b.startUs)} --> ${srtTime(b.endUs)}`, ...b.lines.map((l) => l.words.map((w) => w.text).join(" "))].join("\r\n"))
    .map((cue) => cue + "\r\n\r\n")
    .join("");
}

export function vttTime(us: number): string {
  return srtTime(us).replace(",", ".");
}

/** WebVTT text for subtitle lines (one cue per block, its lines on separate rows), LF line ends. */
export function toVtt(lines: CaptionLine[]): string {
  const cues = blockSpans(lines).map(
    (b) => [`${vttTime(b.startUs)} --> ${vttTime(b.endUs)}`, ...b.lines.map((l) => l.words.map((w) => w.text).join(" "))].join("\n") + "\n\n",
  );
  return cues.length ? "WEBVTT\n\n" + cues.join("") : "";
}
