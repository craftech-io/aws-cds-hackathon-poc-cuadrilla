// The QaDriver's data access (docs/architecture.md §14, ADR-0007): it reads the app tables, but every
// write is fenced by `dynamodb:LeadingKeys` to the keys of QA, evaluation and the test guest's worlds
// (except `Cases`, fenced in code), and its objects by prefix. The patterns are evaluated here the way
// IAM evaluates `StringLike`, against keys of the live demo world, a real guest and the stage.
import { describe, expect, it } from "vitest";
import { type Grant, type LambdaName, expectedData, expectedGrants } from "./iam-capabilities";
import { ITEM_WRITES, QA_DRIVER_WRITE_KEYS, guestTestObjectPrefix, type QaFencedTable } from "./qa-driver-fence";
import { TABLE_ACTIONS, dataAccessGrants } from "./storage-access";
import { mediaKeySegment } from "../packages/shared/src/media/keys";
import { qaLimitsKey, qaSlotScope } from "../packages/bff/src/guest/slots";
import { guestAccountKey } from "../packages/bff/src/leads/guest-accounts";
import { LEAD_PARTITION_PREFIX } from "../packages/bff/src/leads/model";
import { QA_ACTIONS } from "../packages/bff/src/qa-driver/contract";
import { SIGNUP_ACTIONS } from "../packages/bff/src/qa-driver/guard";
import { globalDayKey, visitorCounters } from "../packages/bff/src/signup/limits";

/** IAM `StringLike`: `*` any run of characters (`#` included), `?` one character. */
function like(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

const writes = (grant: Grant): boolean => grant.actions.some((action) => (ITEM_WRITES as readonly string[]).includes(action));
const allows = (table: QaFencedTable, key: string): boolean => QA_DRIVER_WRITE_KEYS[table].some((pattern) => like(pattern, key));

describe("QaDriver data access [W3 review B1/B4]", () => {
  it("links every app table for reading only: no unconditioned item write and no Media or Evidence object grant in its data access", () => {
    const { storage } = dataAccessGrants("QaDriver");
    for (const grant of storage) {
      expect(grant.actions, JSON.stringify(grant.resources)).toEqual(TABLE_ACTIONS.read);
      expect(grant.conditions).toBeUndefined();
    }
    expect(storage.flatMap((grant) => grant.resources)).not.toContain("{Media}/*");
    expect(storage.flatMap((grant) => grant.resources)).not.toContain("{Evidence}/*");
  });

  it("fences every item write by leading keys, Cases (no world in its key) being the declared exception", () => {
    const tableWrites = expectedGrants("QaDriver").filter((grant) => writes(grant));
    for (const grant of tableWrites) {
      const table = grant.resources[0];
      if (table === "{Cases}") {
        expect(grant.sid).toBe("CasesFencedInCode");
        continue;
      }
      expect(grant.conditions, table).toEqual([{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: QA_DRIVER_WRITE_KEYS[table?.slice(1, -1) as QaFencedTable] }]);
    }
    const fenced = tableWrites.map((grant) => grant.resources[0]).sort();
    expect(fenced).toEqual(["{AuditLog}", "{Cases}", "{Conversations}", "{CuadrillaMetrics}", "{Isps}", "{People}", "{Runtime}", "{WorkOrders}"]);
    expect([...ITEM_WRITES, ...TABLE_ACTIONS.read].sort()).toEqual([...TABLE_ACTIONS.write].sort());
  });

  it("denies the stage's cuts, its global ceiling, the live world, phone leases and the sign-up's keys in Runtime", () => {
    const denied = [
      "KILL#ALL",
      "KILL#AGENT",
      "KILL#SIGNUP",
      "KILL#SIMULATOR",
      "KILL#AGENT#GLOBAL#isp-demo",
      "KILL#AGENT#GUEST#isp-guest-test",
      "KILL#AGENT#eval-812",
      "TURNCAP#GLOBAL#2026-10-13",
      "VALCAP#GLOBAL#2026-10-13",
      "TRANSCRIBE#GLOBAL#2026-10-13",
      "TURNCAP#GUESTSIGNUP#2026-10-13",
      "TURNCAP#isp-demo#2026-10-13",
      "LIVEWORLD",
      "PHONELEASE#0f3a",
      "JOINCODE#K7Q2",
      "CLOCK#GLOBAL#isp-demo",
      "CLOCK#GUEST#isp-guest-07",
      "COUNTER#EPOCH#GLOBAL#isp-demo",
      "WORLDSTATE#GUEST#isp-guest-s261009abcde",
      "INSTSTATE#inst-rogelio",
      "INSTSTATE#inst-rogelio-g03",
      "SIGNUPTICKET#n",
      "GUESTACCOUNT#gst-1",
    ];
    for (const key of denied) expect(allows("Runtime", key), key).toBe(false);
    const allowed = ["KILL#AGENT#qa-812-1-sc-14", "CLOCK#qa-812-1-sc-02", "CLOCK#eval-812", "CLOCK#GUEST#isp-guest-test", "RATE#GUEST#isp-guest-test#h#REAL#2026-10-13T15", "TURNCAP#GLOBAL#qa-812-1-sc-12#2026-10-13", "TURNCAP#isp-qa-812-1-sc-02#2026-10-13", "INSTSTATE#inst-qa-812-1-sc-02-a", "IDEMP#INBOUND#e1"];
    for (const key of allowed) expect(allows("Runtime", key), key).toBe(true);
  });

  it("denies the rows of the demo world and of a real guest in every table it fences by key", () => {
    const cases: ReadonlyArray<[QaFencedTable, string, boolean]> = [
      ["Isps", "ISP#isp-demo", false],
      ["Isps", "ISP#isp-guest-07", false],
      ["Isps", "ISP#isp-guest-s261009abcde", false],
      ["Isps", "ISP#isp-qa-812-1-sc-02", true],
      ["Isps", "ISP#isp-guest-test", true],
      ["AuditLog", "ISP#isp-demo#2026-10", false],
      ["AuditLog", "ISP#isp-guest-test#2026-10", true],
      ["CuadrillaMetrics", "ISP#isp-demo", false],
      ["CuadrillaMetrics", "EVALRUN#LATEST", true],
      ["Runtime", "WORLDSESSION#GUEST#isp-guest-test", true],
      ["Runtime", "WORLDSESSION#GUEST#isp-guest-07", false],
      ["People", "PERSON#inst-rogelio", false],
      ["People", "PERSON#inst-rogelio-g03", false],
      ["People", "CUST#cust-10421", false],
      ["People", "ADDR#GLOBAL#isp-demo#h", false],
      ["People", "ADDR#GUEST#isp-guest-07#h", false],
      ["People", "PERSON#inst-qa-812-1-sc-02-a", true],
      ["People", "PERSON#inst-rogelio-gtest", true],
      ["People", "ADDR#qa-812-1-sc-02#h", true],
      ["Conversations", "PERSON#sup-adriana", false],
      ["Conversations", "OUTBOX#isp-demo", false],
      ["Conversations", "OUTBOX#isp-eval-812", true],
      ["WorkOrders", "WO#wo-24817", false],
      ["WorkOrders", "WO#wo-24817-g03", false],
      ["WorkOrders", "WO#wo-70001", true],
      ["WorkOrders", "WO#wo-24817-gtest", true],
    ];
    for (const [table, key, expected] of cases) expect(allows(table, key), `${table} ${key}`).toBe(expected);
  });

  it("writes and deletes objects only under qa/, eval/ and the test guest's own prefix; never Media/* nor a live wa/ object", () => {
    const objectGrants = expectedGrants("QaDriver").filter((grant) => grant.actions.some((action) => action.startsWith("s3:")));
    const on = (action: string) => objectGrants.filter((grant) => grant.actions.includes(action)).flatMap((grant) => grant.resources);
    expect(on("s3:DeleteObject").sort()).toEqual(["{Evidence}/eval/*", "{Evidence}/qa/*", "{Media}/eval/*", "{Media}/qa/*"]);
    for (const resource of on("s3:PutObject")) expect(resource).toMatch(/^\{Media\}\/(qa\/\*|eval\/\*|sim\/\*|guest\/[0-9a-f]{16}-e\*)$|^\{Evidence\}\/(photos\/wo-[78]\*|guest\/[0-9a-f]{16}-e\*\/photos\/\*)$/);
    // [W4 review B2] the seeded evidence of its presets: only QA and evaluation orders and the test guest's prefix.
    expect(on("s3:PutObject").filter((resource) => resource.startsWith("{Evidence}"))).toEqual(["{Evidence}/photos/wo-7*", "{Evidence}/photos/wo-8*", `{Evidence}/${guestTestObjectPrefix()}/photos/*`]);
    for (const action of ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]) expect(on(action), action).not.toEqual(expect.arrayContaining(["{Media}/*", "{Media}/wa/*", "{Evidence}/*"]));
    expect(like(guestTestObjectPrefix(), `guest/${mediaKeySegment("GUEST#isp-guest-test", 3)}`)).toBe(true);
    expect(like(guestTestObjectPrefix(), `guest/${mediaKeySegment("GUEST#isp-guest-07", 3)}`)).toBe(false);
  });
});

// [W5 review B1/B2] Every key the QA seam writes, with the role that writes it: the QaDriver only where its
// fence opens the key, otherwise the Lambda that owns the write, which the QaDriver may invoke and whose own
// grants reach the key. Built with the bff's own key builders, so a key that moves breaks this test.
type Writer = "QaDriver" | LambdaName;
type SeamWrite = { readonly writer: Writer; readonly table: string; readonly key: string };

const AT = new Date("2026-10-13T15:20:00.000Z");
const RUN_SCOPE = { kind: "QA", runId: "812-1-s8" } as const;
const QA_ROOM = qaSlotScope("812-1") as `QA#qa-${string}`;
const SIGNUP_USER = "usr-g01K80000000000000000000001";

/** The writes of each seam action (the sign-up's actions and the one of its caps); Cognito's own writes are the triggers'. */
const SEAM_WRITES: Readonly<Record<string, readonly SeamWrite[]>> = {
  "signup.start": [
    { writer: "Bff", table: "Leads", key: `${LEAD_PARTITION_PREFIX}${"c".repeat(64)}` },
    ...visitorCounters(RUN_SCOPE, { ipHash: "a".repeat(64), abuseHash: "b".repeat(64), anonymous: true }, AT).map((spec) => ({ writer: "Bff" as const, table: "Runtime", key: spec.key })),
    { writer: "Bff", table: "Runtime", key: globalDayKey(RUN_SCOPE, AT) },
  ],
  "auth.signUp": [],
  "auth.confirmQaSignup": [],
  "auth.qaLogin": [],
  "auth.cleanupQaSignup": [{ writer: "GuestAccountDeletion", table: "Runtime", key: guestAccountKey(SIGNUP_USER).PK }],
  "guest.forceExpire": [{ writer: "GuestWorlds", table: "Runtime", key: guestAccountKey(SIGNUP_USER).PK }],
  "guest.capsOverride": [{ writer: "QaDriver", table: "Runtime", key: qaLimitsKey(QA_ROOM) }],
  "leads.get": [],
};

const PUT = ["dynamodb:PutItem", "dynamodb:UpdateItem"];

/** Whether `role` may put or update the item of `key` in `table`: unconditioned write access, or a grant whose leading keys match. */
function roleWrites(role: LambdaName, table: string, key: string): boolean {
  if ((expectedData(role, "tables") as Record<string, string>)[table] === "write") return true;
  return expectedGrants(role).some(
    (grant) => grant.resources.includes(`{${table}}`) && grant.actions.some((action) => PUT.includes(action)) && (grant.conditions ?? []).every((condition) => condition.variable !== "dynamodb:LeadingKeys" || condition.values.some((pattern) => like(pattern, key))),
  );
}

const invokes = (target: string): boolean => expectedGrants("QaDriver").some((grant) => grant.actions.includes("lambda:InvokeFunction") && grant.resources.includes(`{${target}}`));

describe("the QA seam's writes and who makes them [W5 review B1/B2]", () => {
  it("maps every action of the seam", () => {
    expect(Object.keys(SEAM_WRITES).sort()).toEqual([...SIGNUP_ACTIONS, "guest.capsOverride"].sort());
  });

  it("each key is either inside the QaDriver's fence, or written by an owner the QaDriver invokes and whose grants reach it", () => {
    for (const [action, writes] of Object.entries(SEAM_WRITES)) {
      for (const { writer, table, key } of writes) {
        if (writer === "QaDriver") {
          expect(table in QA_DRIVER_WRITE_KEYS && allows(table as QaFencedTable, key), `${action} ${table} ${key}`).toBe(true);
          continue;
        }
        expect(invokes(writer), `${action}: the QaDriver invokes ${writer}`).toBe(true);
        expect(roleWrites(writer, table, key), `${action}: ${writer} writes ${table} ${key}`).toBe(true);
        expect(table in QA_DRIVER_WRITE_KEYS && allows(table as QaFencedTable, key), `${action}: the QaDriver's own fence keeps ${key} closed`).toBe(false);
      }
    }
    expect(expectedGrants("QaDriver").some((grant) => grant.resources.some((resource) => resource.startsWith("{Leads}")) && grant.actions.some((action) => PUT.includes(action)))).toBe(false);
  });

  it("opens of the sign-up only the limits of a QA run's room: never the public counters, the old shared key, nor a phone lease", () => {
    for (const key of ["GUESTWORLDS#261013", "GUESTWORLDS#QA#LIMITS", "SIGNUPOK#GLOBAL#2026-10-13", "SIGNUPOK#QA#qa-812-1#2026-10-13", "SIGNUP#GLOBAL#2026-10-13", globalDayKey(RUN_SCOPE, AT), "PHONELEASE#0f3a"]) expect(allows("Runtime", key), key).toBe(false);
    expect(allows("Runtime", qaLimitsKey(QA_ROOM))).toBe(true);
    expect(QA_ACTIONS.filter((action) => action.startsWith("lease."))).toEqual([]);
  });
});
