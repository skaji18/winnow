import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server proxies API + WebSocket to the Fastify backend.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
