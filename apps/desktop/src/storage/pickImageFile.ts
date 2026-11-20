/** Browser path of "Pick image": a file input, then checks and a content-hash name, the same rules as the
 *  app's Rust command (`src-tauri/src/background.rs`). */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

/** "jpg" or "png" from the first bytes, or null. */
export function imageKind(b: Uint8Array): "jpg" | "png" | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return png.every((v, i) => b[i] === v) ? "png" : null;
}

/** `assets/background-<first 8 hex of SHA-256>.<ext>` for these bytes. */
export async function assetName(bytes: Uint8Array, kind: "jpg" | "png"): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const hex = [...hash.slice(0, 4)].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `assets/background-${hex}.${kind}`;
}

/** Open the file chooser; resolves to the chosen file or null (cancelled). */
export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/** Check a picked file and name it. Throws a sentence to show when it is refused. */
export async function checkImage(file: File): Promise<{ bytes: Uint8Array; path: string }> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error("This image is larger than 40 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = imageKind(bytes);
  if (!kind) throw new Error("Pick a JPG or PNG image.");
  return { bytes, path: await assetName(bytes, kind) };
}
