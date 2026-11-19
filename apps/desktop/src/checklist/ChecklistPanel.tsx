// Checklist tab of the inspector (DESIGN-SYSTEM.md Inspector, "Checklist panel"): the topics with
// the time each was covered; a click jumps there. Open topics say "Not covered".
import { checklistItems, type ChecklistBy } from "@marz/format";
import { clearChecklistItem, coverChecklistItem } from "@marz/timeline";
import { Icon } from "../components/Icon";
import { mmsst } from "../components/timecode";
import { useEditorStore } from "../state/editorStore";

const BY_LABEL: Record<ChecklistBy, string> = { auto: "Live", ai: "AI", hand: "By hand", transcript: "Transcript", editor: "Marked" };

export function ChecklistPanel() {
  const project = useEditorStore((s) => s.project)!;
  const { seek, apply } = useEditorStore.getState();
  const items = checklistItems(project);
  const done = items.filter((i) => i.atUs !== null).length;
  return (
    <div className="ckl">
      <h2 className="insp-title">Checklist</h2>
      <div className="mut insp-sub">
        {done} of {items.length} covered. Click a topic to jump there.
      </div>
      <div className="ckl-list">
        {items.map((i) => {
          const covered = i.atUs !== null;
          return (
            <div key={i.id} className={`ckl-row${covered ? " done" : ""}`} data-testid={`ck-${i.id}`}>
              <i className="ckl-box">{covered && <Icon name="check" size={12} />}</i>
              <div className="ckl-main">
                <button type="button" className="ckl-text" disabled={!covered} onClick={() => covered && seek(i.atUs!)}>
                  {i.text}
                </button>
                <button
                  type="button"
                  className="ckl-act"
                  onClick={() => apply(covered ? clearChecklistItem(i.id) : coverChecklistItem(i.id, useEditorStore.getState().playheadUs, "editor"))}
                >
                  {covered ? "Clear" : "Mark here"}
                </button>
              </div>
              {covered ? (
                <button type="button" className="ckl-when" onClick={() => seek(i.atUs!)}>
                  <span className="ckl-time">{mmsst(i.atUs!)}</span>
                  <span className="ckl-by">{i.by ? BY_LABEL[i.by] : ""}</span>
                </button>
              ) : (
                <span className="badge badge-open">Not covered</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="insp-note ckl-note">Ticked live while recording. The AI pass checks open topics again.</p>
    </div>
  );
}
