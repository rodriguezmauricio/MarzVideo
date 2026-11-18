import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { firstFrameUsFromBytes, readFirstFrameUs } from "./firstFrame";

/** A 1 s fragmented MP4 like screen.mp4 (60 fps, keyframe every 60), with or without B-frames. */
function makeMp4(bf: number): Uint8Array | null {
  const dir = mkdtempSync(join(tmpdir(), "marz-first-"));
  const out = join(dir, `bf${bf}.mp4`);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=60", "-t", "1", "-c:v", "libx264", "-bf", String(bf), "-g", "60",
      "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov+default_base_moof", out]);
  } catch {
    return null;
  }
  return new Uint8Array(readFileSync(out));
}

describe("first frame time", () => {
  const withB = makeMp4(2);
  const withoutB = makeMp4(0);

  test.skipIf(!withB)("a B-frame file starts at the reorder delay", () => {
    expect(firstFrameUsFromBytes(withB!)).toBe(33_333);
  });

  test.skipIf(!withoutB)("a file without B-frames starts at 0", () => {
    expect(firstFrameUsFromBytes(withoutB!)).toBe(0);
  });

  test.skipIf(!withB)("a prefix with the first fragment is enough", () => {
    const head = withB!.slice(0, Math.min(withB!.length, 40_000));
    expect(firstFrameUsFromBytes(head)).toBe(33_333);
  });

  test("unreadable bytes give null", () => {
    expect(firstFrameUsFromBytes(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  test.skipIf(!withB)("readFirstFrameUs asks for a range and grows it when the first fragment is not in it", async () => {
    const ranges: string[] = [];
    const fetchFn = async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range")!;
      ranges.push(range);
      const end = Number(range.split("-")[1]);
      const part = withB!.slice(0, Math.min(withB!.length, end + 1, ranges.length === 1 ? 600 : Infinity));
      return new Response(part, { status: 206 });
    };
    expect(await readFirstFrameUs("x.mp4", fetchFn as typeof fetch, [600, 4_000_000])).toBe(33_333);
    expect(ranges).toEqual(["bytes=0-599", "bytes=0-3999999"]);
  });
});
