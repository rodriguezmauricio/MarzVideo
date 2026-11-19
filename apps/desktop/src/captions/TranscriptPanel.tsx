import { transcriptParagraphs } from "@marz/autoedit";
import { captionEdits, type Word } from "@marz/format";
import { setCaptionText } from "@marz/timeline";
import { useEffect, useMemo, useRef, useState } from "react";
import { mmsst } from "../components/timecode";
import { useEditorStore } from "../state/editorStore";
import { useCaptionFacts } from "./captionActions";

// design-check-ignore: HTMLElement.blur() drops keyboard focus; it is not a visual blur
const leaveField = (el: HTMLInputElement) => el.blur();

/** The word under the playhead: the last word that started at or before it, while it lasts. */
function wordAt(words: Word[], us: number): string | null {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid]!.startUs <= us) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const w = found >= 0 ? words[found]! : null;
  return w && us < w.endUs ? w.id : null;
}

/** Transcript tab of the inspector (DESIGN-SYSTEM.md Inspector, "Transcript panel"): the whole talk,
 * one caption per paragraph. Click a word to jump there; double-click or Enter to fix it in place. */
export function TranscriptPanel() {
  const project = useEditorStore((s) => s.project)!;
  const words = useEditorStore((s) => s.words);
  const selection = useEditorStore((s) => s.selection);
  const playheadUs = useEditorStore((s) => s.playheadUs);
  const playing = useEditorStore((s) => s.playing);
  const editingId = useEditorStore((s) => s.transcriptEditing);
  const setEditing = useEditorStore((s) => s.setTranscriptEditing);
  const { select, seek, apply } = useEditorStore.getState();
  const facts = useCaptionFacts();
  const caps = captionEdits(project);
  const hidden = useMemo(() => new Set(caps.hidden), [caps.hidden]);
  const paragraphs = useMemo(() => transcriptParagraphs(words, facts.starts), [words, facts.starts]);
  const speaking = wordAt(words, playheadUs);
  const selectedId = selection?.kind === "word" ? selection.id : null;
  const scroller = useRef<HTMLDivElement>(null);

  // While playing, keep the word being said in view (instantly: no smooth scroll).
  useEffect(() => {
    if (!playing || !speaking) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-word="${CSS.escape(speaking)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [playing, speaking]);

  const [draft, setDraft] = useState("");
  const startEdit = (w: Word) => {
    setDraft(caps.overrides[w.id] ?? w.text);
    setEditing(w.id);
  };
  const commit = (w: Word, value: string) => {
    setEditing(null);
    const v = value.trim();
    if (!v) return;
    apply(setCaptionText(w.id, v === w.text ? null : v));
  };
  // Enter on the selected word (App's key handler) asks for an edit through the store.
  useEffect(() => {
    if (!editingId) return;
    const w = words.find((x) => x.id === editingId);
    if (w) setDraft(caps.overrides[w.id] ?? w.text);
  }, [editingId]);

  return (
    <div className="tr" data-testid="transcript">
      <h2 className="insp-title">Transcript</h2>
      <div className="mut insp-sub">{facts.starts.size} captions. Click a word to jump there.</div>
      <div className="tr-scroll" ref={scroller}>
        {paragraphs.map((para) => (
          <p key={para[0]!.id} className="tr-par">
            <span className="tr-time">{mmsst(para[0]!.startUs)}</span>
            {para.map((w, i) => {
              const text = caps.overrides[w.id] ?? w.text;
              const fixed = caps.overrides[w.id] !== undefined && caps.overrides[w.id] !== w.text;
              const mid = (w.startUs + w.endUs) / 2;
              const cut = project.edits.cuts.some((c) => mid >= c.startUs && mid < c.endUs);
              const cls = [
                "tr-w",
                cut ? "cut" : "",
                hidden.has(w.id) ? "hid" : "",
                fixed ? "is-fixed" : "",
                selectedId === w.id ? "sel" : "",
                speaking === w.id ? "now" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <span key={w.id}>
                  {i > 0 && " "}
                  {editingId === w.id ? (
                    <input
                      autoFocus
                      className="tr-input"
                      aria-label="Caption text"
                      spellCheck={false}
                      value={draft}
                      size={Math.max(2, draft.length)}
                      onChange={(e) => setDraft(e.currentTarget.value)}
                      onBlur={(e) => commit(w, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") leaveField(e.currentTarget);
                        if (e.key === "Escape") {
                          setDraft(text);
                          setEditing(null);
                        }
                      }}
                    />
                  ) : (
                    <span
                      className={cls}
                      data-word={w.id}
                      data-testid={`tr-${w.id}`}
                      title={cut ? "Cut from the video" : hidden.has(w.id) ? "Hidden from captions" : undefined}
                      onClick={() => {
                        select({ kind: "word", id: w.id });
                        seek(w.startUs);
                      }}
                      onDoubleClick={() => startEdit(w)}
                    >
                      {text}
                    </span>
                  )}
                </span>
              );
            })}
          </p>
        ))}
      </div>
    </div>
  );
}
