// The SMS code of the session for the specs of the views (ADR-0029): they test what comes after it, so
// once the password signed in they pass the session through the local server's test-only seam
// (`POST /api/__e2e/phone/pass`, tests/ui-server/app.ts: the same mark a right code leaves) and reload.
// The screen of the code itself is tested in phone.spec.ts.
import type { Page } from "@playwright/test";
import { TOKENS_KEY } from "../../src/lib/auth/tokens";

export const E2E_PHONE_PASS_PATH = "/api/__e2e/phone/pass";

export async function passPhoneStep(page: Page): Promise<void> {
  const status = await page.evaluate(
    async ({ key, path }) => {
      const raw = sessionStorage.getItem(key);
      const token = raw === null ? undefined : (JSON.parse(raw) as { idToken?: unknown }).idToken;
      if (typeof token !== "string") return 0;
      return (await fetch(path, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status;
    },
    { key: TOKENS_KEY, path: E2E_PHONE_PASS_PATH },
  );
  if (status !== 204) throw new Error(`the local server did not pass the session's SMS code (${status})`);
  await page.reload();
}
