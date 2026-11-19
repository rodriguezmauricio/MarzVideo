import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./recorder.css";
import { Bar } from "./RecordingBar";
import { initSetup } from "./setupInit";
import { startTheme } from "../theme";
import { loadHotkeys } from "../settings/hotkeyStore";

startTheme();
initSetup();
loadHotkeys();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Bar />
  </StrictMode>,
);
