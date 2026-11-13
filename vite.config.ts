import { resolve } from "node:path"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // React Compiler via the stable Babel route (UI_PLAN §1, RESEARCH §6.8).
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 3000,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
})
