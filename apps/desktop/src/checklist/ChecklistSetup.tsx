// The checklist on the setup bar (DESIGN-SYSTEM.md "Recorder: checklist"): the Checklist button and
// the panel where he types the topics, one per line. Saved with the setup.
import { CHECKLIST_MAX, splitTopics } from "@marz/format";
import { Icon } from "../components/Icon";
import { useRecorder } from "../recorder/recorderStore";

export function ChecklistButton({ open, toggle, disabled }: { open: boolean; toggle: () => void; disabled: boolean }) {
  const n = splitTopics(useRecorder((s) => s.checklist)).length;
  return (
    <button type="button" className={`rb-cursor rb-ck${open ? " on" : ""}`} aria-expanded={open} disabled={disabled} onClick={toggle}>
      <Icon name="list" size={16} />
      Checklist
      {n > 0 && <span className="rb-ck-n">{n}</span>}
    </button>
  );
}

export function ChecklistPanel({ close }: { close: () => void }) {
  const text = useRecorder((s) => s.checklist);
  const update = useRecorder((s) => s.update);
  const n = splitTopics(text).length;
  return (
    <div className="rb-ckp">
      <label className="rb-ckp-label" htmlFor="rb-ckp-text">
        Topics to cover, one per line
      </label>
      <textarea
        id="rb-ckp-text"
        className="rb-ckp-text"
        rows={6}
        autoFocus
        spellCheck={false}
        value={text}
        onChange={(e) => update({ checklist: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Esc closes the panel, not the recorder.
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <div className="rb-ckp-note">
        {n} of {CHECKLIST_MAX} topics. They tick when you talk about them.
      </div>
    </div>
  );
}
