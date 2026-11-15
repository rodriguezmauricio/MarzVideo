import type { Cut, Zoom } from "@marz/format";
import { setCursorHidden, updateCut, updateZoom } from "@marz/timeline";
import { deleteSelection, MIN_US } from "../state/actions";
import { useEditorStore } from "../state/editorStore";

function NumField(props: { label: string; value: number; step: number; suffix: string; onCommit: (v: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
      {props.label}
      <span className="flex items-center gap-1">
        <input
          key={props.value}
          type="number"
          step={props.step}
          defaultValue={props.value}
          onBlur={(e) => {
            const v = parseFloat(e.currentTarget.value);
            if (!Number.isNaN(v)) props.onCommit(v);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="w-20 rounded bg-zinc-900 px-2 py-1 text-right tabular-nums text-zinc-100 outline-none focus:ring-1 focus:ring-sky-500"
        />
        <span className="w-5 text-zinc-500">{props.suffix}</span>
      </span>
    </label>
  );
}

const ORIGIN_LABEL: Record<Zoom["origin"], string> = { live: "Live", auto: "Auto", manual: "Manual" };
const sec = (us: number) => Math.round(us / 10_000) / 100;

function ZoomInspector({ zoom, durationUs }: { zoom: Zoom; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Zoom>) => apply(updateZoom(zoom.id, p));
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Zoom</h2>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{ORIGIN_LABEL[zoom.origin]}</span>
      </div>
      <NumField label="Start" value={sec(zoom.startUs)} step={0.1} suffix="s"
        onCommit={(v) => patch({ startUs: Math.max(0, Math.min(Math.round(v * 1e6), zoom.endUs - MIN_US)) })} />
      <NumField label="End" value={sec(zoom.endUs)} step={0.1} suffix="s"
        onCommit={(v) => patch({ endUs: Math.min(durationUs, Math.max(Math.round(v * 1e6), zoom.startUs + MIN_US)) })} />
      <NumField label="Ease in" value={Math.round(zoom.easeInUs / 1000)} step={50} suffix="ms"
        onCommit={(v) => patch({ easeInUs: Math.max(0, Math.round(v * 1000)) })} />
      <NumField label="Ease out" value={Math.round(zoom.easeOutUs / 1000)} step={50} suffix="ms"
        onCommit={(v) => patch({ easeOutUs: Math.max(0, Math.round(v * 1000)) })} />
      <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
        Easing
        <select
          value={zoom.easing}
          onChange={(e) => patch({ easing: e.target.value as Zoom["easing"] })}
          className="rounded bg-zinc-900 px-2 py-1 text-zinc-100"
        >
          <option value="easeInOutCubic">Smooth</option>
          <option value="linear">Linear</option>
        </select>
      </label>
      <p className="text-xs text-zinc-500">Drag the dashed box on the preview to change the zoom area.</p>
      <button onClick={deleteSelection} className="rounded bg-zinc-800 py-1.5 text-sm text-red-300 hover:bg-zinc-700">
        Delete zoom
      </button>
    </>
  );
}

function CutInspector({ cut, durationUs }: { cut: Cut; durationUs: number }) {
  const apply = useEditorStore((s) => s.apply);
  const patch = (p: Partial<Cut>) => apply(updateCut(cut.id, p));
  return (
    <>
      <h2 className="text-sm font-semibold">Cut</h2>
      <NumField label="Start" value={sec(cut.startUs)} step={0.1} suffix="s"
        onCommit={(v) => patch({ startUs: Math.max(0, Math.min(Math.round(v * 1e6), cut.endUs - MIN_US)) })} />
      <NumField label="End" value={sec(cut.endUs)} step={0.1} suffix="s"
        onCommit={(v) => patch({ endUs: Math.min(durationUs, Math.max(Math.round(v * 1e6), cut.startUs + MIN_US)) })} />
      <p className="text-xs text-zinc-500">This part is skipped in preview and export.</p>
      <button onClick={deleteSelection} className="rounded bg-zinc-800 py-1.5 text-sm text-red-300 hover:bg-zinc-700">
        Delete cut
      </button>
    </>
  );
}

export function Inspector() {
  const project = useEditorStore((s) => s.project)!;
  const selection = useEditorStore((s) => s.selection);
  const apply = useEditorStore((s) => s.apply);

  const zoom = selection?.kind === "zoom" ? project.edits.zooms.find((z) => z.id === selection.id) : undefined;
  const cut = selection?.kind === "cut" ? project.edits.cuts.find((c) => c.id === selection.id) : undefined;

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 border-l border-zinc-800 p-4">
      {zoom ? (
        <ZoomInspector zoom={zoom} durationUs={project.durationUs} />
      ) : cut ? (
        <CutInspector cut={cut} durationUs={project.durationUs} />
      ) : (
        <>
          <h2 className="text-sm font-semibold">Recording</h2>
          <label className="flex items-center justify-between gap-2 text-xs text-zinc-400">
            Hide cursor
            <input
              type="checkbox"
              checked={project.edits.cursor.hidden}
              onChange={(e) => apply(setCursorHidden(e.target.checked))}
              className="h-4 w-4 accent-sky-500"
            />
          </label>
          <p className="text-xs text-zinc-500">Select a zoom or a cut on the timeline to edit it.</p>
        </>
      )}
    </aside>
  );
}
