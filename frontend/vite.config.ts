import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../web-dist, which server.py serves. base "./" keeps every asset URL
// relative, so the same build works at the site root and under nginx's /readers/.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "../web-dist", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8788", "/media": "http://127.0.0.1:8788" } },
});
