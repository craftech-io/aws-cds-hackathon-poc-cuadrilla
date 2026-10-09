// The local UI server for the console specs (docs/test-plan.md §3, level UI): tests/ui-server/main.ts
// started once per Playwright worker on a free port (Vite with the real sources and the real `appRouter`
// over the in-memory world seeded from scripts/seed/data), set as the worker's base URL, and the console's
// own sign-in against the route mock of Cognito with one user pool per worker. A spec that shares the
// world between its tests calls `test.describe.configure({ mode: "default" })`.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { type Page, test as base, expect } from "@playwright/test";
import { loginCopy } from "../../src/views/login/copy";
import { type AccountRole, E2E_CLIENT_ID, E2E_POOL_ID, addAccount, createPool } from "./accounts";
import { routeCognito } from "./cognito";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}

/** The UI server of this worker, on a free port; the specs browse it as their base URL. */
export const test = base.extend<object, { uiServer: string }>({
  uiServer: [
    async ({}, use) => {
      const port = await freePort();
      const env = { ...process.env, E2E_UI_SERVER_PORT: String(port), VITE_COGNITO_USER_POOL_ID: E2E_POOL_ID, VITE_COGNITO_CLIENT_ID: E2E_CLIENT_ID };
      const child: ChildProcess = spawn("npx", ["tsx", "tests/ui-server/main.ts"], { cwd: REPO, env, stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve, reject) => {
        child.stdout?.on("data", (chunk: Buffer) => (chunk.toString().includes("ui-server:") ? resolve() : undefined));
        child.once("exit", (code) => reject(new Error(`the UI server exited with ${String(code)}`)));
      });
      await use(`http://127.0.0.1:${port}`);
      child.kill();
    },
    { scope: "worker", timeout: 180_000 },
  ],
  baseURL: async ({ uiServer }, use) => use(uiServer),
});

export { expect };

// One user pool per worker, like the UI server: a sub is never reused, so the server's registry never
// mistakes a new account for one of an earlier test.
const pool = createPool();

/** Signs `role` in through the console's login and lands on `path` (staff skip the TOTP setup). */
export async function signIn(page: Page, role: AccountRole, path: string): Promise<void> {
  const account = await addAccount(pool, { role });
  await routeCognito(page, pool);
  await page.goto(`/login?returnTo=${encodeURIComponent(path)}`);
  await page.getByLabel(loginCopy.credentials.email).fill(account.email);
  await page.getByLabel(loginCopy.credentials.password, { exact: true }).fill(account.password);
  await page.getByRole("button", { name: loginCopy.credentials.submit }).click();
  if (role !== "GUEST") await page.getByRole("button", { name: loginCopy.mfaSetup.skip }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`), { timeout: 30_000 });
}
