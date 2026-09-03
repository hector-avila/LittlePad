import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Vite's default 500kB warning targets pages fetched over a network,
    // where a large single chunk delays first paint. LittlePad is a Tauri
    // desktop app: the bundle loads from local disk into the webview, so
    // that tradeoff doesn't apply — splitting it up would only add
    // complexity (lazy imports, loading states) for no real benefit here.
    // Raised past the current build's size (~1.05MB) rather than disabled
    // outright, so a genuinely runaway bundle would still warn.
    chunkSizeWarningLimit: 2000,
  },
}));
