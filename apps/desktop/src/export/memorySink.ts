import type { ExportJobDto, ExportReport, ExportSink } from "./sink";

/** Keeps the encoded stream in memory. For tests and the dev page `?export=memory`. */
export function createMemorySink(): ExportSink & { bytes(): Uint8Array; job(): ExportJobDto | null } {
  let job: ExportJobDto | null = null;
  let parts: Uint8Array[] = [];
  let size = 0;
  return {
    async begin(j) {
      job = j;
      parts = [];
      size = 0;
    },
    async chunk(data) {
      parts.push(data);
      size += data.byteLength;
    },
    async finish(): Promise<ExportReport> {
      return { outPath: job?.outPath ?? "", durationUs: job?.outputDurationUs ?? 0, sizeBytes: size };
    },
    async cancel() {
      parts = [];
      size = 0;
    },
    bytes() {
      const out = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.byteLength;
      }
      return out;
    },
    job: () => job,
  };
}
