import { describe, expect, it } from "vitest";
import { backgroundEdits, cameraBorder, cameraEdits, captionStyleFor, parseProject, type Project } from "@marz/format";
import { History } from "./history";
import { setBackground } from "./background";
import { placeCamera, setCaptionStyle, updateCamera } from "./commands";
import { applyLook, isFreshTake, lookOf } from "./looks";

const raw = (camera: boolean) => ({
  version: 1, id: "p", name: "P", createdAt: "2026-11-19T00:00:00Z", durationUs: 10_000_000,
  source: { width: 1920, height: 1080, fps: 30 },
  tracks: {
    screen: { file: "screen.mp4", offsetUs: 0 },
    ...(camera ? { camera: { file: "camera.mp4", offsetUs: 0, width: 1280, height: 720, fps: 30 } } : {}),
  },
  output: { width: 1920, height: 1080, fps: 30 },
});
const withCam = parseProject(raw(true));
const noCam = parseProject(raw(false));

const styled = (p: Project): Project =>
  [
    updateCamera({ pip: { shape: "circle", widthFrac: 0.3 }, border: { width: 3, color: "accent" }, mirror: false }),
    placeCamera({ corner: "topLeft", widthFrac: 0.3, marginFrac: 0.03, shape: "circle", x: 0.4, y: 0.2 }),
    setBackground({ style: "glow", padding: "L" }),
    setCaptionStyle("youtube", { style: "accentBand", size: "L" }),
  ].reduce((acc, c) => c(acc), p);

describe("looks", () => {
  it("saves camera, background and caption styles", () => {
    const look = lookOf(styled(withCam), "Studio", new Date("2026-11-19T18:00:00Z"));
    expect(look.name).toBe("Studio");
    expect(look.savedAt).toBe("2026-11-19T18:00:00.000Z");
    expect(look.camera?.mirror).toBe(false);
    expect(look.camera?.pip).toMatchObject({ shape: "circle", x: 0.4, y: 0.2 });
    expect(look.camera?.border).toEqual({ width: 3, color: "accent" });
    expect(look.background).toEqual({ style: "glow", padding: "L" });
    expect(look.captionStyles).toEqual({ youtube: { style: "accentBand", size: "L" } });
  });

  it("leaves the camera out of a take without one, and saves no background as null", () => {
    const look = lookOf(noCam, "Plain");
    expect(look.camera).toBeUndefined();
    expect(look.background).toBeNull();
    expect(look.captionStyles).toEqual({});
  });

  it("applies a look as one undo step and undo brings the old look back", () => {
    const look = lookOf(styled(withCam), "Studio");
    const h = new History(withCam);
    h.apply(applyLook(look));
    const p = h.current;
    expect(cameraEdits(p).pip).toMatchObject({ shape: "circle", widthFrac: 0.3, x: 0.4 });
    expect(cameraBorder(p)).toEqual({ width: 3, color: "accent" });
    expect(backgroundEdits(p).style).toBe("glow");
    expect(captionStyleFor(p, "youtube").style).toBe("accentBand");
    h.undo();
    expect(h.current).toBe(withCam);
  });

  it("keeps the target's scenes, visibility and caption fixes", () => {
    const target: Project = {
      ...withCam,
      edits: {
        ...withCam.edits,
        camera: { ...cameraEdits(withCam), visible: false, scenes: [{ id: "s1", startUs: 0, endUs: 1, layout: "side", origin: "manual" }], liveImported: true },
        captions: { overrides: { w1: "Hello" }, hidden: ["w2"], styles: { vertical: { size: "S" } } },
      },
    };
    const p = applyLook(lookOf(styled(withCam), "Studio"))(target);
    const cam = cameraEdits(p);
    expect(cam.visible).toBe(false);
    expect(cam.scenes).toHaveLength(1);
    expect(cam.liveImported).toBe(true);
    expect(p.edits.captions?.overrides).toEqual({ w1: "Hello" });
    expect(p.edits.captions?.hidden).toEqual(["w2"]);
    // Caption styles are replaced whole: vertical goes back to its default.
    expect(p.edits.captions?.styles).toEqual({ youtube: { style: "accentBand", size: "L" } });
  });

  it("copies an unknown background whole and a null background removes it", () => {
    const fancy = { ...withCam, edits: { ...withCam.edits, background: { style: "image", file: "bg.png", blur: 12 } } } as Project;
    const look = lookOf(fancy, "Fancy");
    const p = applyLook(look)(withCam);
    expect((p.edits as Record<string, unknown>).background).toEqual({ style: "image", file: "bg.png", blur: 12 });
    const back = applyLook(lookOf(withCam, "Plain"))(p);
    expect("background" in back.edits).toBe(false);
  });

  it("drops a border the look does not have", () => {
    const look = lookOf(updateCamera({ pip: { shape: "rounded" } })(withCam), "NoBorder");
    const p = applyLook(look)(styled(withCam));
    expect(cameraEdits(p).border).toBeUndefined();
  });

  it("returns the same project when the look is already there", () => {
    const s = styled(withCam);
    expect(applyLook(lookOf(s, "Studio"))(s)).toBe(s);
    expect(applyLook(lookOf(noCam, "Plain"))(noCam)).toBe(noCam);
  });

  it("a look without a camera leaves the camera alone", () => {
    const s = styled(withCam);
    const p = applyLook(lookOf(noCam, "Plain"))(s);
    expect(p.edits.camera).toBe(s.edits.camera);
    expect(backgroundEdits(p).style).toBe("off");
  });

  it("knows a fresh take", () => {
    expect(isFreshTake(withCam)).toBe(true);
    expect(isFreshTake(styled(withCam))).toBe(false);
    expect(isFreshTake(setBackground({ style: "ink" })(noCam))).toBe(false);
    expect(isFreshTake({ ...noCam, edits: { ...noCam.edits, captions: { overrides: { a: "b" }, hidden: [] } } })).toBe(true);
  });
});
