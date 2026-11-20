// The saved looks file (`looks.json` in the app config folder, localStorage `marz.looks` in the
// browser). Pure rules only; looksApi.ts reads and writes it. Design:
// docs/superpowers/specs/2026-11-19-scene-presets-design.md.
import type { Project } from "@marz/format";
import { isFreshTake, type Look } from "@marz/timeline";

export type LookDefault = { name: string; since: string };
export type LookFile = { version: 1; looks: Look[]; default: LookDefault | null; [k: string]: unknown };

export const EMPTY_LOOK_FILE: LookFile = { version: 1, looks: [], default: null };
export const LOOK_NAME_MAX = 40;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readLook(v: unknown): Look | null {
  if (!isObj(v) || typeof v.name !== "string" || !v.name.trim()) return null;
  const camera = isObj(v.camera) && typeof v.camera.mirror === "boolean" && isObj(v.camera.pip) ? (v.camera as Look["camera"]) : undefined;
  const look: Look = {
    ...v,
    name: v.name,
    savedAt: typeof v.savedAt === "string" ? v.savedAt : "",
    background: isObj(v.background) ? v.background : null,
    captionStyles: isObj(v.captionStyles) ? v.captionStyles : {},
  };
  if (camera) look.camera = camera;
  else delete look.camera;
  return look;
}

/** The file as stored, or empty when it is missing or broken. Broken looks are dropped, unknown keys kept. */
export function parseLookFile(v: unknown): LookFile {
  if (!isObj(v)) return EMPTY_LOOK_FILE;
  const looks = (Array.isArray(v.looks) ? v.looks : []).map(readLook).filter((l): l is Look => l !== null);
  const d = v.default;
  const def = isObj(d) && typeof d.name === "string" && typeof d.since === "string" ? { name: d.name, since: d.since } : null;
  return { ...v, version: 1, looks, default: def };
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The name as it will be saved, or the sentence that says why not. */
export function checkLookName(name: string): { ok: true; name: string } | { ok: false; why: string } {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return { ok: false, why: "Type a name for the look." };
  if (n.length > LOOK_NAME_MAX) return { ok: false, why: `Use ${LOOK_NAME_MAX} characters or fewer.` };
  return { ok: true, name: n };
}

export const findLook = (f: LookFile, name: string): Look | undefined => f.looks.find((l) => same(l.name, name));

/** Add a look, or replace the one with the same name (ignoring case) where it is in the list. */
export function upsertLook(f: LookFile, look: Look): { file: LookFile; replaced: boolean } {
  const i = f.looks.findIndex((l) => same(l.name, look.name));
  if (i < 0) return { file: { ...f, looks: [...f.looks, look] }, replaced: false };
  const looks = f.looks.slice();
  looks[i] = look;
  // A replaced look keeps being the default under its new spelling.
  const def = f.default && same(f.default.name, look.name) ? { ...f.default, name: look.name } : f.default;
  return { file: { ...f, looks, default: def }, replaced: true };
}

/** Remove a look; it stops being the default. */
export function removeLook(f: LookFile, name: string): LookFile {
  return {
    ...f,
    looks: f.looks.filter((l) => !same(l.name, name)),
    default: f.default && same(f.default.name, name) ? null : f.default,
  };
}

/** Pick the default look (null: none). Takes recorded from `now` on get it when they first open. */
export function setDefaultLook(f: LookFile, name: string | null, now: Date = new Date()): LookFile {
  if (name === null || !findLook(f, name)) return { ...f, default: null };
  if (f.default && same(f.default.name, name)) return f;
  return { ...f, default: { name: findLook(f, name)!.name, since: now.toISOString() } };
}

/** The default look a take gets as it opens: set, still saved, recorded at or after the moment it was
 * picked, and nobody styled the take yet. */
export function defaultLookFor(f: LookFile, p: Project): Look | null {
  if (!f.default) return null;
  const look = findLook(f, f.default.name);
  if (!look) return null;
  const made = Date.parse(p.createdAt);
  const since = Date.parse(f.default.since);
  if (!Number.isFinite(made) || !Number.isFinite(since) || made < since) return null;
  return isFreshTake(p) ? look : null;
}
