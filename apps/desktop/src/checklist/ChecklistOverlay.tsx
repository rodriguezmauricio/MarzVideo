// The checklist on the overlay while recording (DESIGN-SYSTEM.md "Recorder: checklist"): the topics
// with their ticks, top right, never captured, no clicks. It also runs the live matcher: words from
// Rust's live transcription tick topics here (LiveChecklist).
import { useEffect, useRef } from "react";
import { Icon } from "../components/Icon";
import { recorderApi } from "../recorder/recorderApi";
import { useRecLive } from "../recorder/recLive";
import { formatTimer } from "../recorder/timer";
import { LiveChecklist } from "./liveChecklist";

export function checklistFooter(note: string | null): string {
  return note ? `${note}. Ctrl+Shift+K ticks the next.` : "Ticks when you talk. Ctrl+Shift+K ticks the next.";
}

export function ChecklistOverlay() {
  const api = recorderApi();
  const items = useRecLive((l) => l.rec.checklist);
  const note = useRecLive((l) => l.rec.checklistNote);
  const drawing = useRecLive((l) => l.rec.drawing);
  const liveRef = useRef<LiveChecklist | null>(null);

  // One matcher per recording; words always meet the latest topics from Rust.
  useEffect(() => {
    const live = new LiveChecklist({
      tick: (id, atUs, by) => api.checklistTick(id, atUs, by).catch(() => undefined),
      askAi: (prompt, schema) => api.checklistAi(prompt, schema),
      nowMs: () => Date.now(),
    });
    liveRef.current = live;
    const off = api.onChecklistWords((words) => live.onWords(words, useRecLive.getState().rec.checklist));
    return () => {
      off();
      liveRef.current = null;
    };
  }, [api]);

  if (items.length === 0 || drawing) return null;
  const done = items.filter((i) => i.atUs !== null).length;
  return (
    <div className="ck-ov" aria-label="Checklist">
      <div className="ck-head">
        <span>Checklist</span>
        <span className="ck-count">
          {done} of {items.length}
        </span>
      </div>
      {items.map((i) => (
        <div key={i.id} className={`ck-row${i.atUs !== null ? " done" : ""}`}>
          <i className="ck-box">{i.atUs !== null && <Icon name="check" size={12} />}</i>
          <span className="ck-text">{i.text}</span>
          {i.atUs !== null && <span className="ck-time">{formatTimer(i.atUs)}</span>}
        </div>
      ))}
      <div className="ck-foot">{checklistFooter(note)}</div>
    </div>
  );
}
