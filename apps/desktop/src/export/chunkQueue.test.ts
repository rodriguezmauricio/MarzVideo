import { describe, expect, it } from "vitest";
import { createChunkQueue } from "./chunkQueue";

/** A sink write that resolves only when the test lets it. */
function slowSink() {
  const started: Uint8Array[] = [];
  const release: (() => void)[] = [];
  const write = (d: Uint8Array) =>
    new Promise<void>((r) => {
      started.push(d);
      release.push(r);
    });
  const releaseOne = async () => {
    release.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { write, started, releaseOne };
}

const chunk = (n: number) => new Uint8Array([n]);

describe("chunk queue", () => {
  it("holds the encoder back once the cap of pending writes is reached", async () => {
    const sink = slowSink();
    const q = createChunkQueue(sink.write, { max: 3, stopped: () => false, onError: () => {} });
    for (let i = 0; i < 3; i++) q.push(chunk(i));
    expect(q.pending).toBe(3);
    let roomy = false;
    const room = q.room().then(() => (roomy = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(roomy).toBe(false);
    await sink.releaseOne();
    await room;
    expect(roomy).toBe(true);
    expect(q.pending).toBe(2);
  });

  it("writes in order", async () => {
    const got: number[] = [];
    const q = createChunkQueue(async (d) => void got.push(d[0]!), { max: 16, stopped: () => false, onError: () => {} });
    for (let i = 0; i < 5; i++) q.push(chunk(i));
    await q.drain();
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops queued writes once stopped, so cancel does not wait for them", async () => {
    const sink = slowSink();
    let stopped = false;
    const q = createChunkQueue(sink.write, { max: 16, stopped: () => stopped, onError: () => {} });
    for (let i = 0; i < 10; i++) q.push(chunk(i));
    await new Promise((r) => setTimeout(r, 0));
    expect(sink.started).toHaveLength(1);
    stopped = true;
    await sink.releaseOne();
    await q.drain();
    expect(sink.started).toHaveLength(1);
    expect(q.pending).toBe(0);
  });

  it("reports a failed write and skips the rest", async () => {
    const errors: Error[] = [];
    let calls = 0;
    const q = createChunkQueue(
      async () => {
        calls++;
        throw new Error("FFmpeg stopped");
      },
      { max: 16, stopped: () => errors.length > 0, onError: (e) => errors.push(e) },
    );
    for (let i = 0; i < 4; i++) q.push(chunk(i));
    await q.drain();
    expect(calls).toBe(1);
    expect(errors.map((e) => e.message)).toEqual(["FFmpeg stopped"]);
  });

  it("room() returns at once when stopped", async () => {
    const sink = slowSink();
    const q = createChunkQueue(sink.write, { max: 1, stopped: () => true, onError: () => {} });
    q.push(chunk(0));
    await q.room();
  });
});
