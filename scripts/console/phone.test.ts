// The operator's side of the account's phone (ADR-0029): the AUTOMATION mark one account at a time, the
// mark taken away and the reset of a lost number, over memory; and the flags of `console:phone`.
import { describe, expect, it } from "vitest";
import { MemoryTableClient } from "../../packages/bff/src/connector/memory/table-client";
import { adminPhone } from "../../packages/bff/src/phone/admin";
import { ownerKey } from "../../packages/bff/src/phone/enrolment";
import { accountPhoneHash } from "../../packages/bff/src/phone/number";
import { parsePhoneAdminArgs } from "./phone";

const KEY = "test-account-phone-key";
const NOW = new Date("2026-11-27T15:00:00.000Z");
const ROW = { PK: "ISP#isp-guest-07", SK: "USER#usr-guest-07" };

async function setup() {
  const client = new MemoryTableClient();
  await client.put("Isps", { ...ROW, entity: "ConsoleUser", ispId: "isp-guest-07", userId: "usr-guest-07", role: "GUEST", name: "Invitado 07", cognitoSub: "sub-7", cognitoSubKey: "SUB#sub-7", active: true, phone: "+525512345678", phoneVerifiedAt: NOW.toISOString(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), version: 1 });
  await client.put("Runtime", { ...ownerKey(accountPhoneHash(KEY, "+525512345678")), entity: "PhoneOwner", userId: "usr-guest-07" });
  return { client, deps: { client, phoneKey: () => KEY, now: () => NOW, wait: async () => undefined } };
}

describe("console:phone [FL-125]", () => {
  it("[FL-125] marks one account AUTOMATION and takes the mark away, by its sub", async () => {
    const { client, deps } = await setup();
    expect(await adminPhone(deps, "sub-7", "AUTOMATION")).toEqual({ outcome: "DONE", userId: "usr-guest-07", ispId: "isp-guest-07" });
    expect(await client.get("Isps", ROW)).toMatchObject({ phoneCheck: "AUTOMATION" });
    await adminPhone(deps, "sub-7", "HUMAN");
    expect((await client.get("Isps", ROW))?.phoneCheck).toBeUndefined();
    expect(await adminPhone(deps, "sub-nobody", "AUTOMATION")).toEqual({ outcome: "NO_ROW" });
  });

  it("[FL-125] the reset forgets the verified number and frees it for another account", async () => {
    const { client, deps } = await setup();
    await adminPhone(deps, "sub-7", "RESET");
    const row = await client.get("Isps", ROW);
    expect(row?.phone).toBeUndefined();
    expect(row?.phoneVerifiedAt).toBeUndefined();
    expect(await client.get("Runtime", ownerKey(accountPhoneHash(KEY, "+525512345678")))).toBeUndefined();
  });

  it("[FL-125] takes one Cognito user and exactly one action, never an address", () => {
    expect(parsePhoneAdminArgs(["--stage", "poc", "--username", "guest-07", "--automation"])).toEqual({ username: "guest-07", action: "AUTOMATION" });
    expect(parsePhoneAdminArgs(["--stage", "poc", "--username", "gst-01K80000000000000000000001", "--reset-phone"])).toEqual({ username: "gst-01K80000000000000000000001", action: "RESET" });
    expect(() => parsePhoneAdminArgs(["--stage", "poc", "--username", "ana@example.com", "--automation"])).toThrow(/never an address/);
    expect(() => parsePhoneAdminArgs(["--stage", "poc", "--username", "guest-07"])).toThrow(/exactly one/);
    expect(() => parsePhoneAdminArgs(["--stage", "poc", "--username", "guest-07", "--automation", "--human"])).toThrow(/exactly one/);
    expect(() => parsePhoneAdminArgs(["--username", "guest-07", "--automation"])).toThrow(/--stage poc/);
  });
});
