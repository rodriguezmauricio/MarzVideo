import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { projectsPlugin } from "./vite-plugin-projects";

export default defineConfig({
  plugins: [react(), tailwindcss(), projectsPlugin(resolve(__dirname, "../../samples"))],
});
