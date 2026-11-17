import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import type { ExportJobDto, ExportReport, ExportSink } from "./sink";

export type Invoke = <T>(cmd: string, args?: InvokeArgs, opts?: InvokeOptions) => Promise<T>;

/** A failure Rust explained: `reason` is the warning bar sentence (export.rs), `message` the detail. */
export class ExportFailure extends Error {
  constructor(
    readonly reason: string,
    detail: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ExportFailure";
  }
}

function asFailure(e: unknown): unknown {
  if (e && typeof e === "object" && "reason" in e && typeof (e as { reason: unknown }).reason === "string") {
    const { reason, detail } = e as { reason: string; detail?: string };
    return new ExportFailure(reason, detail ?? "");
  }
  return e;
}

function abortError(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

/** The app's sink: FFmpeg through the export commands in src-tauri/src/export.rs. Chunks go as a raw
 *  request body (no JSON) with the export id in a header. `cancel` is safe at any time, also before
 *  or during `begin`. */
export function createTauriSink(invoke: Invoke = tauriInvoke): ExportSink {
  let id: number | null = null;
  let cancelled = false;
  let beginning: Promise<unknown> | null = null;
  const call = async <T>(cmd: string, args?: InvokeArgs, opts?: InvokeOptions): Promise<T> => {
    try {
      return await invoke<T>(cmd, args, opts);
    } catch (e) {
      throw asFailure(e);
    }
  };
  return {
    async begin(job: ExportJobDto) {
      const started = call<number>("export_begin", { job });
      beginning = started.catch(() => {});
      const got = await started;
      if (cancelled) {
        await call("export_cancel", { id: got });
        throw abortError();
      }
      id = got;
    },
    async chunk(data: Uint8Array) {
      if (id === null) throw abortError();
      await call("export_chunk", data, { headers: { "marz-export-id": String(id) } });
    },
    async finish(): Promise<ExportReport> {
      if (id === null) throw abortError();
      const current = id;
      id = null;
      return call<ExportReport>("export_finish", { id: current });
    },
    async cancel() {
      cancelled = true;
      if (beginning) await beginning;
      if (id === null) return;
      const current = id;
      id = null;
      await call("export_cancel", { id: current });
    },
  };
}
