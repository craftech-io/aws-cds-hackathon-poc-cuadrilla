import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { RouterOutputs } from "../../lib/trpc-router";
import { OverrideResult, RECENT_SIGN_IN_MS, ReviewQueue, matchesQueue, needsFreshSignIn, percent, reasonProblem, reviewKey } from "./evidence-model";

const NOW = Date.parse("2026-10-20T15:00:00.000Z");

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

const item = (overrides: Record<string, unknown> = {}) => ({
  workOrderId: "wo-24820",
  workOrderNumber: "24820",
  installerId: "inst-karina",
  item: "POWER_READING_PHOTO",
  status: "IN_REVIEW",
  attempts: 0,
  lastRejectReason: null,
  validation: {
    validationId: "val-1",
    verdict: "UNSURE",
    modelVerdict: "PASS",
    reasonCode: null,
    readings: { readingDbm: -21.4, wavelengthNm: 1490 },
    checks: ["VAL-CONFIDENCE"],
    confidence: 0.41,
    evidenceId: "ev-1",
    atSim: "2026-10-13T09:40:00-06:00",
  },
  rubric: { version: "v001", mustShow: ["La pantalla del medidor completa"] },
  ...overrides,
});

describe("evidence.queue at the edge [FL-043]", () => {
  it("[FL-043] an unsure photo comes with the validator's output and the rubric; nothing decides it", () => {
    const queue = ReviewQueue.parse({ day: "2026-10-13", items: [item(), item({ item: "ONU_LABEL_PHOTO", status: "REJECTED", attempts: 1, lastRejectReason: "GLARE" })] });
    expect(queue.items[0]?.validation).toMatchObject({ verdict: "UNSURE", confidence: 0.41, checks: ["VAL-CONFIDENCE"] });
    expect(queue.items[0]?.rubric?.mustShow).toEqual(["La pantalla del medidor completa"]);
    expect(queue.items.filter((found) => matchesQueue(found, "UNSURE"))).toHaveLength(1);
    expect(queue.items.filter((found) => matchesQueue(found, "REJECTED"))).toHaveLength(1);
    expect(queue.items.filter((found) => matchesQueue(found, "ALL"))).toHaveLength(2);
    expect(new Set(queue.items.map(reviewKey)).size).toBe(2);
    expect(percent(0.41)).toBe("41 %");
    expect(percent(null)).toBe("—");
  });

  it("[FL-043] the contract matches the router's answer type", () => {
    expectTypeOf<RouterOutputs["evidence"]["queue"]>().toExtend<z.input<typeof ReviewQueue>>();
    expectTypeOf<RouterOutputs["evidence"]["override"]>().toExtend<z.input<typeof OverrideResult>>();
  });
});

describe("manual validation [FL-044]", () => {
  it("[FL-044] the reason is required (3 to 500 characters, not counting the spaces around it)", () => {
    expect(reasonProblem("")).toBe("short");
    expect(reasonProblem("  ok  ")).toBe("short");
    expect(reasonProblem("Lectura legible en la segunda foto")).toBeNull();
    expect(reasonProblem("x".repeat(501))).toBe("long");
  });

  it("[FL-044] a sign-in older than 15 minutes asks for the password first; a fresh one does not", () => {
    const fresh = idToken({ auth_time: Math.floor((NOW - 5 * 60_000) / 1000) });
    const old = idToken({ auth_time: Math.floor((NOW - RECENT_SIGN_IN_MS - 60_000) / 1000) });
    const almost = idToken({ auth_time: Math.floor((NOW - RECENT_SIGN_IN_MS + 10_000) / 1000) });
    expect(needsFreshSignIn(fresh, NOW)).toBe(false);
    expect(needsFreshSignIn(old, NOW)).toBe(true);
    // Asked a little early, so the request does not cross the line on its way.
    expect(needsFreshSignIn(almost, NOW)).toBe(true);
    // Without a readable sign-in time the BFF decides.
    expect(needsFreshSignIn(undefined, NOW)).toBe(false);
    expect(needsFreshSignIn("not-a-token", NOW)).toBe(false);
    expect(needsFreshSignIn(idToken({ sub: "x" }), NOW)).toBe(false);
  });

  it("[FL-044] the answer of a validation that went through", () => {
    expect(OverrideResult.parse({ workOrderId: "wo-24820", item: "POWER_READING_PHOTO", status: "OVERRIDDEN", overriddenBy: "usr-adriana", atSim: "2026-10-13T09:20:00-06:00", eventId: "e-1" })).toMatchObject({ status: "OVERRIDDEN" });
    expect(OverrideResult.safeParse({ workOrderId: "wo-24820", item: "POWER_READING_PHOTO", status: "PASSED" }).success).toBe(false);
  });
});
