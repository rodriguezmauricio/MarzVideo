import { useEffect, useState } from "react";
import type { Project } from "@marz/format";
import { applyLook, lookOf } from "@marz/timeline";
import { Icon } from "../components/Icon";
import { useEditorStore } from "../state/editorStore";
import { checkLookName, EMPTY_LOOK_FILE, removeLook, upsertLook, type LookFile } from "./lookFile";
import { looksApi } from "./looksApi";
import "./looks.css";

const HINT = "Camera, background and caption style. Apply is one undo step.";

/** Look block, first in the Project panel (DESIGN-SYSTEM.md Inspector, "Look block"): the saved looks
 *  with Apply and Delete, and Save look for the open project. */
export function LookBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const note = useEditorStore((s) => s.lookNote);
  const setNote = useEditorStore((s) => s.setLookNote);
  const [file, setFile] = useState<LookFile>(EMPTY_LOOK_FILE);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    looksApi()
      .get()
      .then((f) => live && setFile(f), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const write = async (next: LookFile) => {
    try {
      await looksApi().set(next);
      setFile(next);
      return true;
    } catch {
      setError("Could not save the looks file.");
      return false;
    }
  };

  const save = async () => {
    const r = checkLookName(name);
    if (!r.ok) return setError(r.why);
    // Read again first: Settings or another window may have changed the file.
    const cur = await looksApi().get().catch(() => file);
    const { file: next, replaced } = upsertLook(cur, lookOf(project, r.name));
    if (!(await write(next))) return;
    setError(null);
    setName("");
    setNote(replaced ? `Replaced ${r.name}.` : `Saved ${r.name}.`);
  };

  const remove = async (n: string) => {
    const cur = await looksApi().get().catch(() => file);
    if (await write(removeLook(cur, n))) setNote(`Deleted ${n}. Takes that use it keep their settings.`);
  };

  const use = (n: string) => {
    const look = file.looks.find((l) => l.name === n);
    if (!look) return;
    const before = useEditorStore.getState().project;
    apply(applyLook(look));
    setNote(useEditorStore.getState().project === before ? `${n} is already applied.` : `Applied ${n}.`);
  };

  return (
    <div className="insp-look">
      <div className="mut insp-sec">Look</div>
      {file.looks.map((l) => (
        <div key={l.name} className="irow k34 look-row">
          <span className="look-name" title={l.name}>
            {l.name}
            {file.default?.name === l.name && <span className="mut look-def">Default</span>}
          </span>
          <span className="look-acts">
            <button type="button" className="ce-link" aria-label={`Apply ${l.name}`} onClick={() => use(l.name)}>
              Apply
            </button>
            <button type="button" className="ce-link" aria-label={`Delete ${l.name}`} onClick={() => void remove(l.name)}>
              Delete
            </button>
          </span>
        </div>
      ))}
      <input
        className="look-input"
        type="text"
        spellCheck={false}
        maxLength={60}
        placeholder="Look name"
        aria-label="Look name"
        value={name}
        onChange={(e) => {
          setName(e.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setName("");
        }}
      />
      <div className="btns">
        <button type="button" className="fb fb-line" onClick={() => void save()}>
          <Icon name="layers" size={14} />
          Save look
        </button>
      </div>
      {error ? <p className="look-err">{error}</p> : <div className="insp-last">{note ?? HINT}</div>}
    </div>
  );
}
