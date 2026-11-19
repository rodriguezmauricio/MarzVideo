// Which timeline view the editor opens on (DESIGN-SYSTEM.md "Timeline", two views), remembered per
// user in the webview's storage. Main track unless he last chose the lanes.

export const LANES_KEY = "marz.timeline.lanes";
type Store = Pick<Storage, "getItem" | "setItem">;

export function readLanesView(store: Store | null): boolean {
  try {
    return store?.getItem(LANES_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeLanesView(store: Store | null, lanes: boolean): void {
  try {
    store?.setItem(LANES_KEY, lanes ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts for this session only.
  }
}

/** The browser's storage, or null where it cannot be reached. */
export function lanesStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
