import { createFile, type MP4BoxBuffer, type Movie } from "mp4box";

/** The first presentation time (us) of the first video track in `bytes` (the start of an MP4, or all of it):
 *  the smallest composition time among the samples mp4box could index. For screen.mp4 (fragmented,
 *  `empty_moov`) the first fragment is enough. Null when no video sample is in the bytes. */
export function firstFrameUsFromBytes(bytes: Uint8Array): number | null {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as MP4BoxBuffer;
  buf.fileStart = 0;
  const file = createFile();
  let movie: Movie | null = null;
  file.onReady = (m) => (movie = m);
  file.onError = () => {};
  try {
    file.appendBuffer(buf, true);
    file.flush();
  } catch {
    return null;
  }
  const track = (movie as Movie | null)?.videoTracks[0];
  if (!track) return null;
  const samples = file.getTrackById(track.id)?.samples ?? [];
  if (samples.length === 0) return null;
  let min = Infinity;
  for (const s of samples) min = Math.min(min, (s.cts * 1e6) / s.timescale);
  return Math.round(min);
}

const RANGES = [1 << 20, 8 << 20];

/** `firstFrameUsFromBytes` on the start of the file at `url`, read with Range requests (1 MB, then 8 MB, then
 *  the whole file), so the preview does not load the recording. 0 when it cannot be read. */
export async function readFirstFrameUs(url: string, fetchFn: typeof fetch = fetch, ranges: number[] = RANGES): Promise<number> {
  for (const n of ranges) {
    const res = await fetchFn(url, { headers: { Range: `bytes=0-${n - 1}` } });
    if (!res.ok) break;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const first = firstFrameUsFromBytes(bytes);
    if (first !== null) return first;
    if (res.status === 200 || bytes.byteLength < n) return 0; // the whole file, and still nothing
  }
  const res = await fetchFn(url);
  if (!res.ok) return 0;
  return firstFrameUsFromBytes(new Uint8Array(await res.arrayBuffer())) ?? 0;
}
