/** Encoded chunks on their way to the sink, written one after the other in decode order. At most
 *  `max` wait at a time: the export loop awaits `room()` before it encodes the next frame, so a slow
 *  sink (FFmpeg on a busy disk) holds the encoder back instead of piling chunks up in memory. Once
 *  `stopped()` (cancel or a failure), queued writes are dropped, so a cancel never waits for them. */
export function createChunkQueue(
  write: (data: Uint8Array) => Promise<void>,
  opts: { max: number; stopped: () => boolean; onError: (e: Error) => void },
) {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let waiters: (() => void)[] = [];
  const release = () => {
    pending--;
    const w = waiters;
    waiters = [];
    for (const wake of w) wake();
  };
  return {
    get pending() {
      return pending;
    },
    push(data: Uint8Array): void {
      pending++;
      chain = chain
        .then(() => (opts.stopped() ? undefined : write(data)))
        .catch((e: unknown) => opts.onError(e instanceof Error ? e : new Error(String(e))))
        .finally(release);
    },
    /** Resolves once fewer than `max` writes wait (at once when stopped). */
    async room(): Promise<void> {
      while (pending >= opts.max && !opts.stopped()) await new Promise<void>((r) => waiters.push(r));
    },
    /** Resolves when every queued write is done or dropped. Never rejects. */
    drain(): Promise<void> {
      return chain;
    },
  };
}
