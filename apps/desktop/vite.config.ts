import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { projectsPlugin } from "./vite-plugin-projects";

export default defineConfig({
  plugins: [react(), tailwindcss(), projectsPlugin(resolve(__dirname, "../../samples"))],
  // Tauri prints Rust errors in the same terminal; do not wipe them.
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: { index: resolve(__dirname, "index.html") },
    },
  },
});
