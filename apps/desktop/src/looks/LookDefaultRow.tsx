import { useEffect, useState } from "react";
import { Picker } from "../settings/rows";
import { EMPTY_LOOK_FILE, setDefaultLook, type LookFile } from "./lookFile";
import { looksApi } from "./looksApi";

const NONE = "";

/** Settings, Devices: the look new recordings get when they first open (DESIGN-SYSTEM.md "Settings"). */
export function LookDefaultRow() {
  const [file, setFile] = useState<LookFile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    looksApi()
      .get()
      .then((f) => live && setFile(f), () => live && setFile(EMPTY_LOOK_FILE));
    return () => {
      live = false;
    };
  }, []);

  const looks = file?.looks ?? [];
  const items = [{ id: NONE, name: looks.length ? "None" : "None. Save a look in the editor" }, ...looks.map((l) => ({ id: l.name, name: l.name }))];

  const pick = async (id: string) => {
    const cur = await looksApi().get().catch(() => file ?? EMPTY_LOOK_FILE);
    const next = setDefaultLook(cur, id === NONE ? null : id);
    try {
      await looksApi().set(next);
      setFile(next);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <div className="st-row">
        <span className="st-label">Look</span>
        <Picker label="Default look" value={file?.default?.name ?? NONE} items={items} empty="Reading..." onChange={(id) => void pick(id)} />
        {failed && <span className="st-why">Could not save the looks file.</span>}
      </div>
      <p className="st-last">Takes recorded from now on open with this look. Older takes keep theirs.</p>
    </>
  );
}
