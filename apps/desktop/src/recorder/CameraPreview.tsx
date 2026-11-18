// The live camera on the overlay during setup, where the picture-in-picture will be (bottom right of
// the capture area, 22% of its width, mirrored). DESIGN-SYSTEM.md "Recorder: camera preview".
// WebView2 opens the camera with getUserMedia; the bar asks the overlay to let it go before Record
// so the engine can open it (`cameraPreview(false)`), and nothing is drawn while recording.
import { pipRect } from "@marz/compositor";
import { DEFAULT_CAMERA_EDITS } from "@marz/format";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useRecLive } from "./recLive";
import { CAMERA_BUSY, CAMERA_FAILED, recorderApi, type Camera } from "./recorderApi";
import { useRecorder } from "./recorderStore";
import type { PxRect } from "./regionMath";

/** The `getUserMedia` device for camera `name` (Media Foundation's friendly name is the label). */
async function openCamera(name: string): Promise<MediaStream> {
  const want = { width: { ideal: 1280 }, height: { ideal: 720 } };
  let stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false });
  // Labels are only filled in once a camera is open.
  const devices = await navigator.mediaDevices.enumerateDevices();
  const match = devices.find((d) => d.kind === "videoinput" && (d.label === name || d.label.startsWith(name) || name.startsWith(d.label)));
  const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
  if (match && match.deviceId !== current) {
    stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...want, deviceId: { exact: match.deviceId } }, audio: false });
  }
  return stream;
}

function errorText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  return name === "NotReadableError" || name === "TrackStartError" ? CAMERA_BUSY : CAMERA_FAILED;
}

export function CameraPreview({ area }: { area: PxRect }) {
  const api = recorderApi();
  const cameraOn = useRecorder((s) => s.cameraOn);
  const cameraId = useRecorder((s) => s.cameraId);
  const recording = useRecLive((l) => l.rec.recording);
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [held, setHeld] = useState(false);
  const [size, setSize] = useState({ width: 16, height: 9 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    api.info().then((i) => setCameras(i.cameras), () => setCameras([]));
  }, [api]);

  const release = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Record asks for the camera: stop it now, then say so.
  useEffect(
    () =>
      api.onCameraPreview((on, released) => {
        if (!on) release();
        setHeld(!on);
        if (!on) released();
      }),
    [api],
  );

  const camera = cameras?.find((c) => c.id === cameraId) ?? cameras?.[0] ?? null;
  const active = cameraOn && camera !== null && !held && !recording;
  const name = camera?.name ?? "";

  useEffect(() => {
    if (!active || api.fake) return;
    let live = true;
    openCamera(name).then(
      (stream) => {
        if (!live) return stream.getTracks().forEach((t) => t.stop());
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          void v.play().catch(() => undefined);
        }
        api.cameraError(null);
      },
      (e: unknown) => live && api.cameraError(errorText(e)),
    );
    return () => {
      live = false;
      release();
    };
  }, [api, active, name]);

  // Turning the camera off clears its error on the bar.
  useEffect(() => {
    if (!cameraOn) api.cameraError(null);
  }, [api, cameraOn]);

  if (!active) return null;
  const r = pipRect({ width: area.w, height: area.h }, size, DEFAULT_CAMERA_EDITS.pip);
  return (
    <div className="ro-cam" style={{ left: area.x + r.x, top: area.y + r.y, width: r.w, height: r.h }}>
      <span className="ro-cam-tag">
        <Icon name="camera" size={13} />
        Camera
      </span>
      {!api.fake && (
        <video
          ref={videoRef}
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setSize({ width: v.videoWidth, height: v.videoHeight });
          }}
        />
      )}
    </div>
  );
}
