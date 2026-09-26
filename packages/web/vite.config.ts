import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served from "/" behind the CloudFront Router (infra/web.ts); the BFF and the upload page live on
// the same origin under /api and /u.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
