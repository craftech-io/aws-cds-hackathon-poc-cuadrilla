// Playwright specs of the console (docs/test-plan.md §2, level UI): `npm run test:ui`, in CI.
//
// The specs run against the console served by Vite with fake build variables for Cognito; the user
// pool is a route mock inside each spec (support/cognito.ts) whose id tokens are signed with the
// run's ephemeral RSA key (support/tokens.ts, created here, in the main process, so every worker and
// every server the config starts share it). Nothing reaches AWS and no human credential is used.
// Chromium runs every spec; WebKit runs only the tests tagged `@webkit` (the MP4 voice recording of
// the simulator).
import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_CLIENT_ID, E2E_POOL_ID } from "./support/accounts";
import "./support/tokens";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CI = Boolean(process.env.CI);

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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /@webkit/ },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: WEB_ROOT,
    url: `${BASE_URL}/`,
    reuseExistingServer: !CI,
    timeout: 120_000,
    env: { VITE_COGNITO_USER_POOL_ID: E2E_POOL_ID, VITE_COGNITO_CLIENT_ID: E2E_CLIENT_ID },
  },
});
