import { describe, expect, it } from "vitest";
import { assetName, checkImage, imageKind } from "./pickImageFile";
import { isBackgroundImagePath } from "@marz/format";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("background image file", () => {
  it("tells JPG and PNG from their first bytes", () => {
    expect(imageKind(PNG)).toBe("png");
    expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(imageKind(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  it("names it by content, a path the format accepts", async () => {
    const a = await assetName(PNG, "png");
    expect(a).toMatch(/^assets\/background-[0-9a-f]{8}\.png$/);
    expect(isBackgroundImagePath(a)).toBe(true);
    expect(await assetName(PNG, "png")).toBe(a);
  });

  it("refuses other files", async () => {
    await expect(checkImage(new File(["not an image"], "x.png"))).rejects.toThrow("JPG or PNG");
    expect((await checkImage(new File([PNG], "x.png"))).path).toMatch(/\.png$/);
  });
});
