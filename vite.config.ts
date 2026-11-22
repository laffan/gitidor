import { defineConfig } from "vite";

// Tauri expects a fixed port and no screen clearing, so its own output stays
// readable. `TAURI_DEV_HOST` is set by `tauri ios dev` when the device needs to
// reach the dev server over the network.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "safari15",
    sourcemap: false,
    // One bundle for a local app: CodeMirror, markdown-it and the two
    // frontmatter parsers are most of it, and all of it is needed at start.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
