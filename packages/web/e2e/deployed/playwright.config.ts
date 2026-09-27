// Deployed verification of the public surfaces (docs/test-plan.md §6.1, WP-62): `npm run qa:deployed`
// against the stage's URL, never in `npm test` nor in CI. Chrome installed on the operator's machine
// (no browser download); the stage's real edge, pool, WAF and BFF, nothing mocked.
//
// Projects: 390×844 and 1440×900, es-MX and en, with and without reduced motion. The read-only specs
// (`@public`) run in all eight; the sign-ups (`@evidence`, `@full`) and the anti-abuse check (`@abuse`)
// pick their own projects, because every sign-up spends the real per-IP limit (5 starts per clock hour)
// and §6.1 fixes their order: the evidence sign-up first, then the four full ones in the same hour, the
// anti-abuse check at the end in a new hour. Run each phase with its tag (see support.ts, PHASES).
//
// Screenshots go to QA_SHOTS_DIR (outside the repository; never committed). The sign-up specs call the
// operator's QA seam (`npm run qa:confirm-signup`) and lead scripts, so they need AWS_PROFILE of the
// stage's account; the rest needs no credentials.
import { defineConfig, devices, type Project } from "@playwright/test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.QA_BASE_URL ?? "https://cuadrilla.demo.craftech.io").replace(/\/$/, "");
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
const OUTPUT = process.env.QA_OUTPUT_DIR ?? join(tmpdir(), "cuadrilla-qa-deployed", "test-results");

const CHROME = { ...devices["Desktop Chrome"], channel: CHANNEL };

const VIEWPORTS = {
  "mobile-390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  "desktop-1440": { viewport: { width: 1440, height: 900 } },
} as const;

const LOCALES = { es: "es-MX", en: "en" } as const;

function projects(): Project[] {
  const list: Project[] = [];
  for (const [viewportName, viewport] of Object.entries(VIEWPORTS)) {
    for (const [lang, locale] of Object.entries(LOCALES)) {
      const use = { ...CHROME, ...viewport, locale };
      list.push({ name: `${viewportName}-${lang}`, use });
      list.push({ name: `${viewportName}-${lang}-reduced-motion`, use: { ...use, reducedMotion: "reduce" } });
    }
  }
  return list;
}

export default defineConfig({
  testDir: HERE,
  testMatch: "*.spec.ts",
  outputDir: resolve(OUTPUT),
  // Sign-ups share the per-IP limit and the lead table: one at a time, never retried (a retry spends
  // another start of the hour).
  fullyParallel: false,
  workers: Number(process.env.QA_WORKERS ?? 1),
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    // Traces and videos would keep passwords typed into the forms: never on this run.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: projects(),
});
