import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./recorder.css";
import { Overlay } from "./Overlay";
import { isFake } from "./recorderApi";
import { Bar } from "./RecordingBar";
import { initSetup } from "./setupInit";
import { loadHotkeys } from "../settings/hotkeyStore";

initSetup();
loadHotkeys();
// `?fake&bar` draws the bar at its design position too, for the 1440 x 900 design check.
const withBar = isFake() && new URLSearchParams(window.location.search).has("bar");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Overlay>{withBar && <Bar placed />}</Overlay>
  </StrictMode>,
);
