// Playwright specs of the web (docs/test-plan.md §2, level UI): `npm run test:ui`.
//
// The specs run against the web served by Vite with fake build variables for Cognito; the user pool is
// a route mock inside each spec (support/cognito.ts) whose id tokens are signed with the run's
// ephemeral RSA key (support/tokens.ts, created here, in the main process, so every worker and every
// server the config starts share it). Nothing reaches AWS and no human credential is used.
//
// Every spec runs in the projects of docs/test-plan.md §3: `mobile-390` (390×844, touch) and
// `desktop-1440` (1440×900), each in `es-MX` and `en`; the specs of the public surfaces also run with
// `reducedMotion: "reduce"`, where they check that all the content is there without animation. A spec
// reads its language from the project's locale (`test.info().project.use.locale`). WebKit runs only the
// tests tagged `@webkit` (the MP4 voice recording of the simulator). Locally the specs use the installed
// Google Chrome (no browser download); CI may set PLAYWRIGHT_CHANNEL or install its own Chromium.
import { defineConfig, devices, type Project } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_CLIENT_ID, E2E_POOL_ID } from "./support/accounts";
import "./support/tokens";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env.CI);
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? (CI ? undefined : "chrome");

const CHROME = { ...devices["Desktop Chrome"], ...(CHANNEL ? { channel: CHANNEL } : {}) };

export const VIEWPORTS = {
  "mobile-390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  "desktop-1440": { viewport: { width: 1440, height: 900 } },
} as const;

export const LOCALES = { es: "es-MX", en: "en" } as const;

/** Specs of the public surfaces: they also run with reduced motion (docs/test-plan.md §3). */
export const PUBLIC_SURFACE_SPECS = /[\\/](?:landing|landing-motion|signup|guest-login|logout|recovery|guest-home|legal|login)\.spec\.ts$/;

function projects(): Project[] {
  const list: Project[] = [];
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      const use = { ...CHROME, ...viewport, locale };
      list.push({ name: `${viewportName}-${lang}`, use });
      list.push({ name: `${viewportName}-${lang}-reduced-motion`, use: { ...use, reducedMotion: "reduce" }, testMatch: PUBLIC_SURFACE_SPECS });
    }
  }
  list.push({ name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@webkit/ });
  return list;
}

export default defineConfig({
  testDir: HERE,
  testMatch: "*.spec.ts",
  outputDir: resolve(WEB_ROOT, "test-results"),
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: resolve(WEB_ROOT, "playwright-report") }]] : "list",
  use: {
    baseURL: BASE_URL,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    trace: "retain-on-failure",
  },
  projects: projects(),
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: WEB_ROOT,
    url: `${BASE_URL}/`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { VITE_COGNITO_USER_POOL_ID: E2E_POOL_ID, VITE_COGNITO_CLIENT_ID: E2E_CLIENT_ID },
  },
});
