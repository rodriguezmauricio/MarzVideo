import { describe, expect, it } from "vitest";
import type { ExportJobDto } from "./sink";
import { ExportFailure, createTauriSink, type Invoke } from "./tauriSink";

const job = { outPath: "C:/x/a YouTube.mp4" } as ExportJobDto;

function fakeInvoke(handlers: Record<string, (args: unknown, opts: unknown) => unknown>) {
  const calls: { cmd: string; args: unknown; opts: unknown }[] = [];
  const invoke: Invoke = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected ${cmd}`);
    return h(args, opts) as never;
  };
  return { invoke, calls };
}

describe("tauri sink", () => {
  it("cancel without begin does nothing and resolves", async () => {
    const { invoke, calls } = fakeInvoke({});
    await createTauriSink(invoke).cancel();
    expect(calls).toEqual([]);
  });

  it("sends chunks as a raw body with the export id header, then finishes", async () => {
    const report = { outPath: job.outPath, durationUs: 2_000_000, sizeBytes: 9 };
    const { invoke, calls } = fakeInvoke({ export_begin: () => 3, export_chunk: () => undefined, export_finish: () => report });
    const sink = createTauriSink(invoke);
    await sink.begin(job);
    const data = new Uint8Array([0, 0, 0, 1, 0x67]);
    await sink.chunk(data);
    expect(await sink.finish()).toEqual(report);
    expect(calls.map((c) => c.cmd)).toEqual(["export_begin", "export_chunk", "export_finish"]);
    expect(calls[0]!.args).toEqual({ job });
    expect(calls[1]!.args).toBe(data);
    expect(calls[1]!.opts).toEqual({ headers: { "marz-export-id": "3" } });
    expect(calls[2]!.args).toEqual({ id: 3 });
    // Over: a later cancel has nothing to cancel.
    await sink.cancel();
    expect(calls).toHaveLength(3);
  });

  it("cancel after begin cancels that export once", async () => {
    const { invoke, calls } = fakeInvoke({ export_begin: () => 5, export_cancel: () => undefined });
    const sink = createTauriSink(invoke);
    await sink.begin(job);
    await sink.cancel();
    await sink.cancel();
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ["export_begin", { job }],
      ["export_cancel", { id: 5 }],
    ]);
  });

  it("cancel while begin is still running cancels the export it returns", async () => {
    let release!: (id: number) => void;
    const { invoke, calls } = fakeInvoke({ export_begin: () => new Promise<number>((r) => (release = r)), export_cancel: () => undefined });
    const sink = createTauriSink(invoke);
    const begun = sink.begin(job);
    const cancelled = sink.cancel();
    release(9);
    await expect(begun).rejects.toMatchObject({ name: "AbortError" });
    await cancelled;
    expect(calls.map((c) => [c.cmd, c.args])).toEqual([
      ["export_begin", { job }],
      ["export_cancel", { id: 9 }],
    ]);
  });

  it("turns a Rust error into an ExportFailure with its reason", async () => {
    const { invoke } = fakeInvoke({
      export_begin: () => {
        throw { reason: "FFmpeg is missing. Install it or set MARZ_FFMPEG", detail: "ffmpeg was not found" };
      },
    });
    const err = await createTauriSink(invoke).begin(job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportFailure);
    expect((err as ExportFailure).reason).toBe("FFmpeg is missing. Install it or set MARZ_FFMPEG");
    expect((err as ExportFailure).message).toContain("ffmpeg was not found");
  });
});
