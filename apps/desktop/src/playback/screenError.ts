/** MediaError.MEDIA_ERR_DECODE: the file is there but its video cannot be decoded. */
const DECODE = 3;

/** The Warning bar sentence when `screen.mp4` cannot be played (DESIGN-SYSTEM.md "Warning bar").
 *  A missing file reaches the video element as MEDIA_ERR_SRC_NOT_SUPPORTED, like an unknown format. */
export function screenErrorText(code: number | undefined): string {
  return code === DECODE
    ? "The screen recording is damaged and cannot be played. Check screen.mp4 in the project folder."
    : "The screen recording is missing or cannot be played. Check screen.mp4 in the project folder.";
}
