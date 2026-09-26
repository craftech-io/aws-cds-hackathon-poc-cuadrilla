import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryLeadTable } from "../../packages/bff/src/leads/memory-table";
import type { LeadStore } from "../../packages/bff/src/leads/store";
import { T0, confirmedLead, hashOf, leadHarness } from "../../packages/bff/src/leads/testing";
import { type EmailSource, readEmailInput } from "./email-input";
import { selectLeads } from "./export";
import { main, runUnsubscribe } from "./unsubscribe";

const EMAIL = "ana.prueba@example.com";
const source = (stdin: string, files: Record<string, string> = {}): EmailSource => ({
  readStdin: async () => stdin,
  readFile: async (path) => {
    const content = files[path];
    if (content === undefined) throw new Error("no such file");
    return content;
  },
});

describe("leads:unsubscribe [FL-117]", () => {
  let table: MemoryLeadTable;
  let store: LeadStore;
  beforeEach(() => ({ table, store } = leadHarness()));

  it("[FL-117] adds CONTACT accepted: false to the history, records CONTACT_WITHDRAWN and leaves the account", async () => {
    const before = await confirmedLead(store, { contact: true });
    const result = await runUnsubscribe(EMAIL, { store, emailHash: hashOf, now: () => T0 });
    expect(result).toEqual({ outcome: "WITHDRAWN", leadId: before.leadId });
    const lead = await store.get(hashOf(EMAIL));
    expect(lead?.consentHistory.at(-1)).toEqual({ id: "CONTACT", accepted: false, at: T0.toISOString(), textVersion: "2026-09-26", locale: "es-MX" });
    expect(lead).toMatchObject({ status: "CONFIRMED", cognitoUsername: before.cognitoUsername, userId: before.userId, cognitoSub: before.cognitoSub });
    expect((await store.listEvents(hashOf(EMAIL))).map((event) => event.kind)).toContain("CONTACT_WITHDRAWN");
    expect(table.logs).toEqual([expect.objectContaining({ kind: "CONTACT_WITHDRAWN", leadId: before.leadId, actor: "OPERATOR" })]);
  });

  it("[FL-117] the lead leaves the default export afterwards", async () => {
    await confirmedLead(store, { contact: true });
    expect(selectLeads(await store.scan(), { all: false, origin: "WEB" })).toHaveLength(1);
    await runUnsubscribe(EMAIL, { store, emailHash: hashOf, now: () => T0 });
    expect(selectLeads(await store.scan(), { all: false, origin: "WEB" })).toHaveLength(0);
    expect(selectLeads(await store.scan(), { all: true, origin: "WEB" })).toHaveLength(1);
  });

  it("[FL-117] answers NOT_FOUND and ALREADY_WITHDRAWN without writing", async () => {
    expect(await runUnsubscribe("nadie@example.com", { store, emailHash: hashOf, now: () => T0 })).toEqual({ outcome: "NOT_FOUND" });
    await confirmedLead(store, { contact: false });
    expect((await runUnsubscribe(EMAIL, { store, emailHash: hashOf, now: () => T0 })).outcome).toBe("ALREADY_WITHDRAWN");
    expect(table.logs).toEqual([]);
  });

  it("[FL-117] reads the address from standard input or --email-file, never from an argument", async () => {
    expect(await readEmailInput([], source(`${EMAIL}\n`))).toBe(EMAIL);
    expect(await readEmailInput(["--email-file", "/var/tmp/pedido.txt"], source("", { "/var/tmp/pedido.txt": `  ${EMAIL}  \n\n` }))).toBe(EMAIL);
    await expect(main([EMAIL], source(EMAIL), {})).rejects.toThrow("never from an argument");
    await expect(main(["--email", EMAIL], source(EMAIL), {})).rejects.toThrow("never from an argument");
    await expect(readEmailInput(["--email"], source(EMAIL))).rejects.toThrow("unknown argument");
    await expect(readEmailInput([], source(`${EMAIL}\notra@example.com\n`))).rejects.toThrow("exactly one address");
    await expect(readEmailInput([], source("no-es-un-email\n"))).rejects.toThrow("not an email address");
  });
});
