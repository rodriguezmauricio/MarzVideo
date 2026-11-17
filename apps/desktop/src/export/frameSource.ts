import { createFile, DataStream, Endianness, type MP4BoxBuffer, type Movie, type Sample, type VisualSampleEntry } from "mp4box";

/** Frame-exact access to screen.mp4 for export. */
export interface FrameSource {
  /** The frame shown at media time `mediaUs`: the latest with timestamp at or before it (the first frame before
   *  the first timestamp). The caller owns the returned frame and must close it. */
  frameAt(mediaUs: number): Promise<VideoFrame>;
  /** Presentation time of the first frame (the smallest cts): 0 without B-frames, the reorder delay with them. */
  readonly firstFrameUs: number;
  close(): void;
}

const MAX_DECODE_QUEUE = 8;
const RESEEK_GAP = 16;

type Indexed = { ptsUs: number; sync: boolean; offset: number; size: number; durUs: number; dtsUs: number };

/** avcC (or hvcC) bytes for VideoDecoderConfig.description, without the 8-byte box header. */
function codecDescription(entry: VisualSampleEntry): Uint8Array | undefined {
  const box = entry.avcC ?? entry.hvcC;
  if (!box) return undefined;
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  (box.write as (s: DataStream) => void).call(box, stream); // the types want MultiBufferStream; a DataStream writes the same bytes
  return new Uint8Array(stream.buffer, 8);
}

/** Read and index the whole file (moov is at the end of screen.mp4, so the samples cannot stream before it). */
async function demux(url: string): Promise<{ bytes: Uint8Array; samples: Indexed[]; config: VideoDecoderConfig }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read the screen recording (${res.status})`);
  const ab = await res.arrayBuffer();
  // MP4BoxBuffer is an ArrayBuffer with fileStart; tag this one instead of copying it.
  const buf = ab as MP4BoxBuffer;
  buf.fileStart = 0;

  const file = createFile();
  let info: Movie | null = null;
  let parseError: string | null = null;
  file.onReady = (m) => (info = m);
  file.onError = (mod, msg) => (parseError = `${mod}: ${msg}`);
  file.appendBuffer(buf, true);
  file.flush();
  const movie = info as Movie | null;
  if (!movie) throw new Error(`Could not read the screen recording${parseError ? ` (${parseError})` : ""}`);
  const track = movie.videoTracks[0];
  if (!track) throw new Error("The screen recording has no video track");

  const trak = file.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as VisualSampleEntry;
  const toUs = (t: number, scale: number) => Math.round((t * 1e6) / scale);
  // Media time is the container's presentation time (cts), as video.currentTime in Chromium, which Preview
  // reads. screen.mp4 has no edit list; older recordings (B-frames) start at the reorder delay, which
  // `firstFrameUs` reports so callers map source time with `mediaTimeUs(project, srcUs, firstFrameUs)`.
  const samples: Indexed[] = trak.samples.map((s: Sample) => ({
    ptsUs: toUs(s.cts, s.timescale),
    dtsUs: toUs(s.dts, s.timescale),
    durUs: toUs(s.duration, s.timescale),
    sync: s.is_sync,
    offset: s.offset,
    size: s.size,
  }));
  if (samples.length === 0) throw new Error("The screen recording has no frames");
  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width ?? entry.width,
    codedHeight: track.video?.height ?? entry.height,
    description: codecDescription(entry),
    hardwareAcceleration: "prefer-hardware",
  };
  return { bytes: new Uint8Array(ab), samples, config };
}

/** mp4box demux + WebCodecs decode. Decodes forward; a backwards request, or a jump past the next keyframe,
 *  re-seeks from the keyframe at or before the requested time. */
export async function createFrameSource(url: string): Promise<FrameSource> {
  const { bytes, samples, config } = await demux(url);
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`This computer cannot decode the screen recording (${config.codec})`);

  // Keyframe (decode-order index) to start from for each time: the last sync sample with pts <= t.
  const keys = samples.map((s, i) => (s.sync ? i : -1)).filter((i) => i >= 0);
  const keyFor = (t: number) => {
    let found = keys[0] ?? 0;
    for (const i of keys) {
      if (samples[i]!.ptsUs <= t) found = i;
      else break;
    }
    return found;
  };

  let current: VideoFrame | null = null; // latest output with timestamp <= the last request
  let ahead: VideoFrame[] = []; // outputs past the last request, in presentation order
  let target = -Infinity; // the request being served
  let feedIdx = 0;
  let flushing = false; // flush() called on the current decoder
  let drained = false; // ...and it has output everything
  let error: Error | null = null;
  let wake: (() => void) | null = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const nextEvent = () => new Promise<void>((r) => (wake = r));

  // A re-seek closes the decoder and makes a new one (a clean start at a keyframe).
  const makeDecoder = () => {
    const d = new VideoDecoder({
      output: (f) => {
        // Settle right away: a frame at or before the request replaces `current` (closing the older one), so
        // the decoder's small frame pool is not held up.
        if (ahead.length === 0 && f.timestamp <= target) {
          current?.close();
          current = f;
        } else ahead.push(f);
        poke();
      },
      error: (e) => {
        error = e instanceof Error ? e : new Error(String(e));
        poke();
      },
    });
    d.addEventListener("dequeue", poke);
    d.configure(config);
    return d;
  };
  let decoder = makeDecoder();

  const dropAll = () => {
    current?.close();
    current = null;
    for (const f of ahead) f.close();
    ahead = [];
  };

  const reseek = (k: number) => {
    decoder.close();
    dropAll();
    decoder = makeDecoder();
    feedIdx = k;
    flushing = false;
    drained = false;
  };

  const feed = () => {
    const s = samples[feedIdx++]!;
    decoder.decode(
      new EncodedVideoChunk({
        type: s.sync ? "key" : "delta",
        timestamp: s.ptsUs,
        duration: s.durUs,
        data: bytes.subarray(s.offset, s.offset + s.size),
      }),
    );
  };

  return {
    firstFrameUs: samples.reduce((m, s) => Math.min(m, s.ptsUs), Infinity),
    async frameAt(mediaUs) {
      if (error) throw error;
      const k = keyFor(mediaUs);
      const backwards = current !== null && mediaUs < current.timestamp;
      // Forward: keep decoding through a short gap; re-seek only when that skips more than RESEEK_GAP samples.
      if (backwards || k - feedIdx > RESEEK_GAP) reseek(k);
      target = mediaUs;

      for (;;) {
        if (error) throw error;
        while (ahead.length > 0 && ahead[0]!.timestamp <= mediaUs) {
          current?.close();
          current = ahead.shift()!;
        }
        if (ahead.length > 0) break;
        if (feedIdx >= samples.length) {
          if (drained) break;
          // End of file: flush, but do not wait on it. The decoder needs its output frames back to finish,
          // so the loop returns as soon as a later frame arrives and the next request releases it.
          if (!flushing) {
            flushing = true;
            const d = decoder;
            d.flush().then(
              () => {
                if (d !== decoder) return;
                drained = true;
                poke();
              },
              (e: unknown) => {
                if (d !== decoder || d.state === "closed") return;
                error = e instanceof Error ? e : new Error(String(e));
                poke();
              },
            );
          }
          await nextEvent();
          continue;
        }
        if (decoder.decodeQueueSize < MAX_DECODE_QUEUE) {
          feed();
          continue;
        }
        await nextEvent();
      }
      const shown = current ?? ahead[0];
      if (!shown) throw new Error("The screen recording has no frame at this time");
      return shown.clone();
    },
    close() {
      dropAll();
      if (decoder.state !== "closed") decoder.close();
    },
  };
}
