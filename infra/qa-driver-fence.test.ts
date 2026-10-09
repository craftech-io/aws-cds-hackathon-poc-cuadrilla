// The QaDriver's data access (docs/architecture.md §14, ADR-0007): it reads the app tables, but every
// write is fenced by `dynamodb:LeadingKeys` to the keys of QA, evaluation and the test guest's worlds
// (except `Cases`, fenced in code), and its objects by prefix. The patterns are evaluated here the way
// IAM evaluates `StringLike`, against keys of the live demo world, a real guest and the stage.
import { describe, expect, it } from "vitest";
import { expectedGrants, type Grant } from "./iam-capabilities";
import { ITEM_WRITES, QA_DRIVER_WRITE_KEYS, guestTestObjectPrefix, type QaFencedTable } from "./qa-driver-fence";
import { TABLE_ACTIONS, dataAccessGrants } from "./storage-access";
import { mediaKeySegment } from "../packages/shared/src/media/keys";

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
