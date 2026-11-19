import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./recorder.css";
import { Bar } from "./RecordingBar";
import { initSetup } from "./setupInit";
import { startTheme } from "../theme";

startTheme();
initSetup();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Bar />
  </StrictMode>,
);
