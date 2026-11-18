// The recording as Rust reports it (`recorder://state`, warnings, failures), shared by the bar and
// the overlay window. Each window keeps its own copy, fed by the same events.
import { create } from "zustand";
import { IDLE, recorderApi, type RecState } from "./recorderApi";

type Live = {
  rec: RecState;
  /** The last warning sentence (shown on the bar's error line). */
  warning: string | null;
  /** Why the last recording stopped on an error (shown on the setup bar until the next Record). */
  failed: string | null;
  /** Record was pressed: a new recording starts with a clean error line. */
  clearMessages: () => void;
};

export const useRecLive = create<Live>((set) => ({
  rec: IDLE,
  warning: null,
  failed: null,
  clearMessages: () => set({ failed: null, warning: null }),
}));

/** Subscribe this window to the recording events (once, at start-up). */
export function initLive(): void {
  const api = recorderApi();
  void api.state().then((rec) => useRecLive.setState({ rec }), () => undefined);
  api.onState((rec) => useRecLive.setState({ rec }));
  api.onWarning((warning) => useRecLive.setState({ warning }));
  api.onFailed((failed) => useRecLive.setState({ failed, warning: null, rec: IDLE }));
}
