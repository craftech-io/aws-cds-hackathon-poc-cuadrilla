import { describe, expect, it } from "vitest";
import { Caller, CallerKind, PrincipalInput, SESSION_TOKEN_MAX_TTL_SECONDS, isSessionTokenExpired, principalKind, splitSessionToken } from "./caller";
import { readDoc } from "./testing";

const SIGNATURE = "a".repeat(43);
const TOKEN = `sess-01J9ZQX.turn-01.1790000000.${SIGNATURE}`;
const WORLD = { ispId: "isp-demo", clockId: "GLOBAL#isp-demo" } as const;
const QA_WORLD = { ispId: "isp-qa-812-1-sc-02", clockId: "qa-812-1-sc-02" } as const;
const JUDGE_TEST = { ispId: "isp-judge-test", clockId: "JUDGE#isp-judge-test" } as const;

describe("caller", () => {
  it("has the kinds and fields of docs/tool-catalog.md (Invocación directa)", () => {
    const row = /\| Invocación directa \| `caller` en lugar de `sessionToken`: `\{"kind": ([^,]+), ([^}]+)\}`/.exec(readDoc("docs/tool-catalog.md"));
    const kinds = (row?.[1] ?? "").split(/\s*\\\|\s*/).map((kind) => kind.replaceAll('"', ""));
    const fields = (row?.[2] ?? "").split(", ").map((field) => field.replaceAll('"', ""));
    expect(kinds).toEqual(CallerKind.options);
    expect(["kind", ...fields].sort()).toEqual(Object.keys(Caller.shape).sort());
  });

  it("accepts every direct-invocation kind inside its world", () => {
    expect(Caller.safeParse({ kind: "WORKER", ...WORLD, eventId: "evt_01J9ZQXV6M" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "CHANNEL", ...WORLD, eventId: "wamid.SIM.abc=" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "SCHEDULER" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "SCHEDULER", ...WORLD }).success).toBe(true);
    expect(Caller.safeParse({ kind: "CONSOLE", ...WORLD, userId: "usr-adriana", role: "SUPERVISOR" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "CONSOLE", ispId: "isp-judge-07", clockId: "JUDGE#isp-judge-07", userId: "usr-judge-07", role: "JUDGE" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "QA", ...QA_WORLD }).success).toBe(true);
    expect(Caller.safeParse({ kind: "QA", ...QA_WORLD, userId: "usr-qa-sup", role: "SUPERVISOR" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "QA", ...JUDGE_TEST, userId: "usr-qa-judge", role: "JUDGE" }).success).toBe(true);
  });

  it("rejects the Harness, unknown keys and ids of the wrong kind", () => {
    expect(Caller.safeParse({ kind: "HARNESS" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "WORKER", ...WORLD, workOrderId: "wo-24817" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "WORKER", ispId: "inst-rogelio", clockId: "GLOBAL#isp-demo" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", ...WORLD, userId: "sup-adriana", role: "SUPERVISOR" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "WORKER", ispId: "isp-demo", clockId: "isp-demo" }).success).toBe(false);
  });

  it("world-bound callers carry their operator and world, and they match", () => {
    for (const kind of ["WORKER", "CHANNEL", "CONSOLE", "QA"] as const) {
      expect(Caller.safeParse({ kind, userId: "usr-qa-sup", role: "SUPERVISOR" }).success, kind).toBe(false);
    }
    expect(Caller.safeParse({ kind: "WORKER", ispId: "isp-demo" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "WORKER", ispId: "isp-judge-07", clockId: "GLOBAL#isp-demo" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "SCHEDULER", ispId: "isp-judge-07", clockId: "JUDGE#isp-judge-03" }).success).toBe(false);
  });

  it("only console and QA callers carry a user and a role", () => {
    expect(Caller.safeParse({ kind: "WORKER", ...WORLD, role: "SUPERVISOR" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CHANNEL", ...WORLD, userId: "usr-adriana" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", ...WORLD, role: "SUPERVISOR" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", ...WORLD, userId: "usr-adriana" }).success).toBe(false);
  });

  it("a judge acts only in a judge world, and a judge world has only judges", () => {
    expect(Caller.safeParse({ kind: "CONSOLE", ...WORLD, userId: "usr-judge-07", role: "JUDGE" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "CONSOLE", ispId: "isp-judge-07", clockId: "JUDGE#isp-judge-07", userId: "usr-adriana", role: "SUPERVISOR" }).success).toBe(false);
  });

  it("QA reaches only qa-*, eval-* and the judge rehearsal world, with its own principals", () => {
    expect(Caller.safeParse({ kind: "QA", ...WORLD }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", ispId: "isp-judge-07", clockId: "JUDGE#isp-judge-07" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", ispId: "isp-eval-812-1", clockId: "eval-812-1" }).success).toBe(true);
    expect(Caller.safeParse({ kind: "QA", ...QA_WORLD, userId: "usr-adriana", role: "SUPERVISOR" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", ...QA_WORLD, userId: "usr-qa-judge", role: "JUDGE" }).success).toBe(false);
    expect(Caller.safeParse({ kind: "QA", ...JUDGE_TEST, userId: "usr-qa-sup", role: "SUPERVISOR" }).success).toBe(false);
  });
});

describe("session token", () => {
  it("splits and checks expiry against an injected real clock", () => {
    expect(splitSessionToken(TOKEN)).toEqual({ sessionId: "sess-01J9ZQX", turnId: "turn-01", exp: 1790000000, signature: SIGNATURE });
    expect(isSessionTokenExpired(TOKEN, 1789999999_000)).toBe(false);
    expect(isSessionTokenExpired(TOKEN, 1790000000_000)).toBe(true);
    expect(SESSION_TOKEN_MAX_TTL_SECONDS).toBe(900);
  });

  it("rejects malformed tokens", () => {
    for (const token of ["not.a.token", `sess.turn.123.${"a".repeat(42)}`, `sess.turn.abc.${SIGNATURE}`, `se ss.turn.1.${SIGNATURE}`, `a.b.c.d.${SIGNATURE}`]) {
      expect(() => splitSessionToken(token), token).toThrow();
    }
  });
});

describe("principal input", () => {
  it("is exactly one of sessionToken or caller (LAM-CALLER)", () => {
    expect(principalKind(PrincipalInput.parse({ sessionToken: TOKEN, item: "ONU_LABEL_PHOTO" }))).toBe("HARNESS");
    expect(principalKind(PrincipalInput.parse({ caller: { kind: "CHANNEL", ...WORLD } }))).toBe("CHANNEL");
    expect(PrincipalInput.safeParse({}).success).toBe(false);
    expect(PrincipalInput.safeParse({ sessionToken: TOKEN, caller: { kind: "WORKER", ...WORLD } }).success).toBe(false);
    expect(PrincipalInput.safeParse({ sessionToken: "forged" }).success).toBe(false);
    expect(PrincipalInput.safeParse({ caller: { kind: "QA", ...WORLD } }).success).toBe(false);
  });
});
