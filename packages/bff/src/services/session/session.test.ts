import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_MAX_TTL_SECONDS, SESSION_TOKEN_PATTERN, ToolError, isSessionTokenExpired, splitSessionToken } from "@cuadrilla/shared";
import { deriveSubkey } from "../../lib/crypto";
import { SESSION_TTL_SECONDS, type SessionRecord, type SessionStore, issueSessionToken, openSession, resolveSession, verifySessionToken } from "./session";

const MASTER = "test-master-key-test-master-key-00000000";
const KEY = deriveSubkey(MASTER, "session");
const NOW = Date.parse("2026-11-02T15:00:00.000Z");
const SESSION_ID = "01JB8Z9Q2W3E4R5T6Y7V8X9ABC";
const TURN_ID = "01JB8Z9Q2W3E4R5T6Y7V8X9TRN";

// Rogelio's voice note at 09:20 on 13/10 (docs/design-brief.md §4): the turn of wo-24817.
const RECORD: SessionRecord = {
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  ispId: "isp-demo",
  installerId: "inst-rogelio",
  workOrderId: "wo-24817",
  trigger: "INSTALLER_MESSAGE",
  clockId: "GLOBAL#isp-demo",
  eventAtSim: "2026-10-13T09:20:00-06:00",
  sourceMessageId: "wamid.SIM.01JB8Z9Q2W3E4R5T6Y7V8X9MSG",
};

function store(overrides: { session?: unknown; turn?: unknown } = {}): SessionStore {
  return {
    getSession: async (sessionId) => ("session" in overrides ? overrides.session : sessionId === SESSION_ID ? { ...RECORD, PK: `SESSION#${sessionId}`, SK: "META", expiresAt: 1 } : undefined),
    getTurn: async () => overrides.turn,
  };
}

async function reason(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).code).toBe("FORBIDDEN");
    return (error as ToolError).reason;
  }
}

describe("session tokens", () => {
  it("are <sessionId>.<turnId>.<exp>.<signature> and live at most 15 minutes of real time", () => {
    const { token, exp } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);
    expect(token).toMatch(SESSION_TOKEN_PATTERN);
    expect(exp).toBe(NOW / 1000 + SESSION_TOKEN_MAX_TTL_SECONDS);
    expect(SESSION_TOKEN_MAX_TTL_SECONDS).toBe(900);
    expect(splitSessionToken(token)).toMatchObject({ sessionId: SESSION_ID, turnId: TURN_ID, exp });
    expect(isSessionTokenExpired(token, NOW + 899_000)).toBe(false);
    expect(isSessionTokenExpired(token, NOW + 900_000)).toBe(true);
  });

  it("never outlive 15 minutes and refuse malformed ids", () => {
    expect(() => issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID, ttlSeconds: 901 }, NOW)).toThrow(RangeError);
    expect(() => issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID, ttlSeconds: 0 }, NOW)).toThrow(RangeError);
    expect(() => issueSessionToken(KEY, { sessionId: "a.b", turnId: TURN_ID }, NOW)).toThrow();
    expect(() => issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, Number.NaN)).toThrow(RangeError);
  });

  it("verify with the session subkey only", () => {
    const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID, ttlSeconds: 60 }, NOW);
    expect(verifySessionToken(KEY, token, NOW)).toMatchObject({ sessionId: SESSION_ID, turnId: TURN_ID });
    expect(() => verifySessionToken(deriveSubkey(MASTER, "nonce"), token, NOW)).toThrow(/signature/);
    expect(() => verifySessionToken(MASTER, token, NOW)).toThrow(/signature/);
  });

  it("reject tampering: another turn, a later expiry or a forged signature, without echoing the token", () => {
    const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);
    const [sessionId, , exp, signature] = token.split(".");
    const otherTurn = [sessionId, "01JB8Z9Q2W3E4R5T6Y7V8X9XXX", exp, signature].join(".");
    const later = [sessionId, TURN_ID, String(Number(exp) + 3_600), signature].join(".");
    for (const forged of [otherTurn, later, `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`]) {
      expect(() => verifySessionToken(KEY, forged, NOW)).toThrow(ToolError);
      try {
        verifySessionToken(KEY, forged, NOW);
      } catch (error) {
        expect((error as Error).message).not.toContain(signature ?? "");
      }
    }
    expect(() => verifySessionToken(KEY, undefined, NOW)).toThrow(/malformed/);
    expect(() => verifySessionToken(KEY, `${token}.x`, NOW)).toThrow(/malformed/);
  });

  it("report SESSION_EXPIRED once the token expired and SESSION_INVALID for one signed too far ahead", async () => {
    const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);
    expect(await reason(resolveSession(KEY, token, store(), NOW + 900_000))).toBe("SESSION_EXPIRED");
    // A token issued by a container whose clock ran an hour ahead is refused, not trusted for an hour.
    const ahead = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW + 3_600_000).token;
    expect(await reason(resolveSession(KEY, ahead, store(), NOW))).toBe("SESSION_INVALID");
  });
});

describe("resolveSession", () => {
  const { token } = issueSessionToken(KEY, { sessionId: SESSION_ID, turnId: TURN_ID }, NOW);

  it("derives operator, installer, order, world, event time and source message from the stored session", async () => {
    const session = await resolveSession(KEY, token, store(), NOW + 1_000);
    expect(session).toEqual({ ...RECORD, exp: NOW / 1000 + 900 });
    expect(session).not.toHaveProperty("PK");
  });

  it("accepts an open turn and refuses one closed before the token expires", async () => {
    await expect(resolveSession(KEY, token, store({ turn: { openedAtReal: "2026-11-02T15:00:00Z" } }), NOW)).resolves.toMatchObject({ workOrderId: "wo-24817" });
    expect(await reason(resolveSession(KEY, token, store({ turn: { closedAtReal: "2026-11-02T15:02:00Z" } }), NOW + 180_000))).toBe("SESSION_EXPIRED");
  });

  it("refuses a turn whose close instant is unreadable", async () => {
    expect(await reason(resolveSession(KEY, token, store({ turn: { closedAtReal: "yesterday" } }), NOW))).toBe("SESSION_INVALID");
  });

  it("refuses a missing, malformed, foreign or cross-operator session record", async () => {
    expect(await reason(resolveSession(KEY, token, store({ session: undefined }), NOW))).toBe("SESSION_INVALID");
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, workOrderId: "24817" } }), NOW))).toBe("SESSION_INVALID");
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, turnId: "01JB8Z9Q2W3E4R5T6Y7V8X9XXX" } }), NOW))).toBe("SESSION_INVALID");
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, sessionId: "01JB8Z9Q2W3E4R5T6Y7V8X9XXX" } }), NOW))).toBe("SESSION_INVALID");
    // The operator must be the one of the world: a record cannot pair a judge's clock with the demo operator.
    expect(await reason(resolveSession(KEY, token, store({ session: { ...RECORD, clockId: "JUDGE#isp-judge-07" } }), NOW))).toBe("SESSION_INVALID");
  });

  it("accepts a day session without an active order or a source message", async () => {
    const { workOrderId: _order, sourceMessageId: _message, ...daySession } = RECORD;
    await expect(resolveSession(KEY, token, store({ session: { ...daySession, trigger: "ORDERS_REQUESTED" } }), NOW)).resolves.not.toHaveProperty("workOrderId");
  });
});

describe("openSession", () => {
  it("stores the record with a one-hour TTL and returns a token bound to that turn", async () => {
    const written: Array<{ record: SessionRecord; expiresAt: number }> = [];
    const { sessionId: _unused, ...fields } = RECORD;
    const opened = await openSession({ sessionKey: KEY, nowMs: NOW, store: { putSession: async (record, expiresAt) => void written.push({ record, expiresAt }) } }, { ...fields, ttlSeconds: 600 });
    expect(written).toHaveLength(1);
    expect(written[0]?.expiresAt).toBe(NOW / 1000 + SESSION_TTL_SECONDS);
    expect(opened.record).toMatchObject({ ...fields });
    expect(opened.exp).toBe(NOW / 1000 + 600);
    const reading: SessionStore = { getSession: async () => written[0]?.record, getTurn: async () => undefined };
    await expect(resolveSession(KEY, opened.token, reading, NOW)).resolves.toMatchObject({ sessionId: opened.record.sessionId, turnId: TURN_ID, installerId: "inst-rogelio" });
  });

  it("refuses to open a session whose operator is not the world's", async () => {
    const { sessionId: _unused, ...fields } = RECORD;
    const putSession = async () => undefined;
    await expect(openSession({ sessionKey: KEY, nowMs: NOW, store: { putSession } }, { ...fields, ispId: "isp-judge-07" })).rejects.toThrow();
  });
});
