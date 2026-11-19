import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { maxLevel, meanLevel, micLevels } from "./levels";

/** A 48 kHz s16 mono WAV: 0.5 s of a loud tone then 0.5 s of silence. */
function wav(): ArrayBuffer {
  const rate = 48000;
  const n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n / 2; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 200 * i) / rate) * 16000), true);
  return buf;
}

describe("micLevels", () => {
  test("reads 10 ms steps with the offset", () => {
    const l = micLevels(wav(), 12_400);
    expect(l.rms.length).toBe(100);
    expect(l.stepUs).toBe(10_000);
    expect(meanLevel(l, 12_400, 512_400)).toBeGreaterThan(0.3);
    expect(maxLevel(l, 600_000, 1_000_000)).toBe(0);
    expect(l.floor).toBeGreaterThan(0);
    expect(l.floor).toBeLessThan(0.05);
  });

  test("rejects a non-WAV file", () => {
    expect(() => micLevels(new ArrayBuffer(64), 0)).toThrow();
  });

  const sample = new URL("../../../samples/demo.marz/mic.wav", import.meta.url);
  test.skipIf(!existsSync(sample))("reads the sample mic.wav at 10 ms steps", () => {
    const b = readFileSync(sample);
    const l = micLevels(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 12_400);
    expect(Math.abs(l.rms.length - 3000)).toBeLessThanOrEqual(2);
    expect(Math.max(...l.rms)).toBeGreaterThan(l.floor * 5);
  });
});
