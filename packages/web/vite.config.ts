import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

/** The Latin file of the display face, the only one the hero's H1 needs (docs/landing-spec.md §2.3). */
const DISPLAY_FONT = /space-grotesk-latin-wght-normal-[\w-]+\.woff2$/;

// The build hashes the font's file name, so the preload is added once the bundle exists: a static
// `<link rel="preload">` in index.html could not name it.
function preloadDisplayFont(): Plugin {
  return {
    name: "cuadrilla-preload-display-font",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const file = Object.keys(context.bundle ?? {}).find((name) => DISPLAY_FONT.test(name));
        if (file === undefined) throw new Error("the build has no Latin file of the display face to preload");
        return [{ tag: "link", attrs: { rel: "preload", href: `/${file}`, as: "font", type: "font/woff2", crossorigin: "" }, injectTo: "head-prepend" }];
      },
    },
  };
}

// Served from "/" behind the CloudFront Router (infra/web.ts); the BFF lives on the same origin
// under /api.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss(), preloadDisplayFont()],
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
