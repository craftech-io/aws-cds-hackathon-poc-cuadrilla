// The anti-abuse check of the deployed sign-up (docs/test-plan.md §6.1, row "Anti abuso"; FL-113), run
// LAST and in a NEW clock hour, so the per-IP counter of the hour starts empty: from the browser, the way
// the sign-up's own client calls it (one `POST /api/signup.start`, through the AWS WAF SDK's `fetch` when
// the page has it), an address whose domain has neither MX nor A → INVALID (EMAIL_DOMAIN, before any
// counter); then six starts in a row with six QA addresses → the first five start, the sixth is
// RATE_LIMITED (5 per IP and clock hour). The pending leads of the five are recorded for the cleanup
// with `npm run leads:delete`. The edge probes without a browser (challenge, batch, encoded path,
// Function URL, SignUp without a ticket) are `npm run qa:edge-probes`.
import { type Page, expect, test } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONSENTS_VERSION } from "@cuadrilla/shared/legal/consents";
import { SHOTS_DIR, onlyIn, projectContext, qaAddress, runTag } from "./support";

interface StartAnswer {
  readonly status: number;
  readonly wafAction: string | null;
  readonly reason: string | null;
}

/** One start as the sign-up's client sends it (`httpLink`, no batch), from inside the page. */
async function start(page: Page, email: string): Promise<StartAnswer> {
  const input = {
    email,
    locale: "es-MX",
    consents: { TERMS_PRIVACY: { accepted: true, textVersion: CONSENTS_VERSION }, CONTACT: { accepted: false, textVersion: CONSENTS_VERSION } },
  };
  return page.evaluate(async (body) => {
    const sdk = (window as unknown as { AwsWafIntegration?: { fetch: typeof fetch } }).AwsWafIntegration;
    const send = sdk ? sdk.fetch.bind(sdk) : window.fetch.bind(window);
    const response = await send("/api/signup.start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let reason: string | null = null;
    try {
      const json = (await response.clone().json()) as { error?: { data?: { reason?: string } } };
      reason = json.error?.data?.reason ?? null;
    } catch {
      reason = null;
    }
    return { status: response.status, wafAction: response.headers.get("x-amzn-waf-action"), reason };
  }, input);
}

test.describe("deployed anti-abuse", () => {
  test("[FL-113] an address without MX nor A is INVALID; six starts in a row, the sixth RATE_LIMITED @abuse", async ({ page }) => {
    onlyIn("abuse");
    test.setTimeout(240_000);
    const runFile = join(dirname(SHOTS_DIR), `run-${runTag()}.json`);
    mkdirSync(dirname(runFile), { recursive: true });
    await page.goto(`/signup?lang=${projectContext().param}`);
    await page.waitForLoadState("networkidle");

    const invalid = await start(page, `qa-${runTag()}@sin-dominio-${runTag()}.invalid`);
    expect(invalid, "a domain that cannot receive mail").toMatchObject({ status: 400, reason: "EMAIL_DOMAIN" });

    const answers: StartAnswer[] = [];
    for (let n = 1; n <= 6; n += 1) {
      const email = qaAddress(`abuse-${n}`);
      const answer = await start(page, email);
      answers.push(answer);
      appendFileSync(runFile, `${JSON.stringify({ at: new Date().toISOString(), step: "abuse-start", n, email, status: answer.status, reason: answer.reason, wafAction: answer.wafAction })}\n`, { mode: 0o600 });
    }
    console.log(`anti-abuse starts: ${answers.map((answer) => `${answer.status}${answer.reason ? `/${answer.reason}` : ""}${answer.wafAction ? `/waf:${answer.wafAction}` : ""}`).join(" ")}`);
    expect(answers.slice(0, 5).map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(answers[5]).toMatchObject({ status: 429, reason: "RATE_LIMITED" });
  });
});
