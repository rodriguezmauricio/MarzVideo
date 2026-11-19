import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { openStoppedRecordings, saveBeforeClose } from "./state/appStore";
import { startTheme } from "./theme";

startTheme();

openStoppedRecordings();
saveBeforeClose();

// Dev only: `?export=memory` runs the export pipeline into memory (Task 15 check). Not in the build.
if (import.meta.env.DEV) {
  const params = new URLSearchParams(location.search);
  if (params.get("export") === "memory") void import("./export/devExport").then((m) => m.runDevExport(params));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
