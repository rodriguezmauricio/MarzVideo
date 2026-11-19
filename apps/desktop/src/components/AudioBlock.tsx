import { useEffect, useState } from "react";
import { audioEdits, type AudioTrackKey, type Project } from "@marz/format";
import { setAudioOption, setTrackFade, setTrackMuted, setTrackVolume } from "@marz/timeline";
import { cleanLine, useCleanMic } from "../audio/cleanMic";
import { useEditorStore } from "../state/editorStore";
import { Toggle } from "./Inspector";

/** Fade lengths offered (same length in and out). */
const FADES: Array<[string, number]> = [
  ["Off", 0],
  ["0.5", 500_000],
  ["1", 1_000_000],
  ["2 s", 2_000_000],
];

const TRACK_NAMES: Record<AudioTrackKey, string> = { mic: "Mic", system: "Computer sound" };

/** Volume, mute and fade of one track. One drag of the slider is one undo step (applied on release). */
function TrackRows({ project, track }: { project: Project; track: AudioTrackKey }) {
  const apply = useEditorStore((s) => s.apply);
  const t = project.tracks[track]!;
  const fade = audioEdits(project)[track];
  const pct = Math.round(Math.min(1, Math.max(0, t.volume)) * 100);
  const [shown, setShown] = useState(pct);
  useEffect(() => setShown(pct), [pct]);
  const name = TRACK_NAMES[track];
  const commit = (v: number) => apply(setTrackVolume(track, v / 100));
  return (
    <>
      <div className="irow">
        <span>{name}</span>
        <span className="pace">
          <input
            key={pct}
            type="range"
            min={0}
            max={100}
            step={5}
            defaultValue={pct}
            aria-label={`${name} volume`}
            onChange={(e) => setShown(Number(e.currentTarget.value))}
            onPointerUp={(e) => commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => commit(Number(e.currentTarget.value))}
          />
        </span>
        <span className="pace-val">{t.muted ? "Muted" : `${shown}%`}</span>
      </div>
      <div className="k34-wrap">
        <Toggle label={`Mute ${name.toLowerCase()}`} on={t.muted} onChange={(on) => apply(setTrackMuted(track, on))} compact />
      </div>
      <div className="irow">
        <span>Fade</span>
        <span className="seg" role="radiogroup" aria-label={`${name} fade in and out`}>
          {FADES.map(([label, us]) => {
            const on = fade.fadeInUs === us && fade.fadeOutUs === us;
            return (
              <button key={label} type="button" role="radio" aria-checked={on} className={on ? "on" : ""}
                onClick={() => apply(setTrackFade(track, { fadeInUs: us, fadeOutUs: us }))}>
                {label}
              </button>
            );
          })}
        </span>
      </div>
    </>
  );
}

/** Audio block of the Project panel (DESIGN-SYSTEM.md "Inspector", Audio block). */
export function AudioBlock({ project }: { project: Project }) {
  const apply = useEditorStore((s) => s.apply);
  const audio = audioEdits(project);
  const clean = useCleanMic((s) => s.state);
  const { mic, system } = project.tracks;
  if (!mic && !system) return null;
  return (
    <div className="insp-audio">
      <div className="mut insp-sec">Audio</div>
      {mic && <TrackRows project={project} track="mic" />}
      {system && <TrackRows project={project} track="system" />}
      {mic && (
        <div className="k34-wrap">
          <Toggle label="Remove mic noise" on={audio.denoise} onChange={(on) => apply(setAudioOption("denoise", on))} compact />
        </div>
      )}
      <div className="k34-wrap">
        <Toggle label="Even loudness at export" on={audio.normalize} onChange={(on) => apply(setAudioOption("normalize", on))} compact />
      </div>
      <div className="insp-last">
        {mic ? `${cleanLine(clean, audio.denoise)}. ` : ""}
        {audio.normalize ? "Export at -14 LUFS." : "Export keeps the mix level."}
      </div>
    </div>
  );
}
