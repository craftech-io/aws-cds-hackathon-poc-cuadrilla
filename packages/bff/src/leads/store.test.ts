import { beforeEach, describe, expect, it } from "vitest";
import { BFF_LEAD_ATTRIBUTES } from "../../../../infra/leads-spec";
import { contactWithdrawal } from "./consent";
import { MemoryLeadTable } from "./memory-table";
import { CONFIRMED_TTL_MONTHS, LEAD_LOG_PREFIX, PENDING_TTL_SECONDS, addMonths, epochSeconds } from "./model";
import { type LeadStore, createLeadStore } from "./store";
import { EMAIL_KEY, T0, confirmedLead, hashOf, leadHarness, sequentialIds, signupUserId, startLead, username } from "./testing";
import { leadAbuseHash } from "./keys";

const EMAIL = "ana.prueba@example.com";
const later = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 3_600_000;

describe("LeadStore [FL-115]", () => {
  let table: MemoryLeadTable;
  let store: LeadStore;
  beforeEach(() => ({ table, store } = leadHarness()));

  it("[FL-115] keeps a new lead under LEAD#<emailHash> with every field, pending (no status) and 7 days of life", async () => {
    const result = await startLead(store, { name: "Ana Prueba", company: "Fibra Demo", jobTitle: "Jefa de campo", contact: true });
    expect(result.outcome).toBe("CREATED");
    const lead = await store.get(hashOf(EMAIL));
    expect(lead).toMatchObject({
      PK: `LEAD#${hashOf(EMAIL)}`,
      SK: "META",
      email: EMAIL,
      name: "Ana Prueba",
      company: "Fibra Demo",
      jobTitle: "Jefa de campo",
      locale: "es-MX",
      originPoc: "cuadrilla",
      origin: "WEB",
      utm: { source: "linkedin", campaign: "fibra-2026" },
      referrerOrigin: "https://example.org",
      abuseHash: leadAbuseHash(EMAIL_KEY, EMAIL),
      pendingUsernames: [username(1)],
      signupStartedAt: T0.toISOString(),
      expiresAt: epochSeconds(T0) + PENDING_TTL_SECONDS,
      version: 1,
    });
    expect(lead?.status).toBeUndefined();
    expect(lead?.consents.TERMS_PRIVACY).toEqual({ id: "TERMS_PRIVACY", accepted: true, at: T0.toISOString(), textVersion: "2026-09-26", locale: "es-MX" });
    expect(lead?.consents.CONTACT.accepted).toBe(true);
    expect(lead?.consentHistory).toHaveLength(2);
    expect(lead?.leadId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await store.listEvents(hashOf(EMAIL))).toEqual([expect.objectContaining({ kind: "STARTED", actor: "GUEST" })]);
  });

  it("[FL-115] a pending lead writes only attributes the Bff may name on Leads (dynamodb:Attributes)", async () => {
    await startLead(store, { name: "Ana", company: "Fibra Demo", jobTitle: "Jefa" });
    await startLead(store, { user: 2, at: later(HOUR) });
    const allowed = new Set<string>(BFF_LEAD_ATTRIBUTES);
    for (const item of table.allItems()) for (const attribute of Object.keys(item)) expect(allowed.has(attribute), attribute).toBe(true);
  });

  it("[FL-115] another start for a pending email adds its user, keeps the first start and expiry, and takes the last form and consents", async () => {
    await startLead(store, { contact: true, company: "Primera" });
    const second = await startLead(store, { user: 2, contact: false, at: later(2 * HOUR) });
    expect(second.outcome).toBe("ADDED");
    const lead = await store.get(hashOf(EMAIL));
    expect(lead?.pendingUsernames).toEqual([username(1), username(2)]);
    expect(lead?.signupStartedAt).toBe(T0.toISOString());
    expect(lead?.expiresAt).toBe(epochSeconds(T0) + PENDING_TTL_SECONDS);
    expect(lead?.company).toBeUndefined();
    expect(lead?.consents.CONTACT.accepted).toBe(false);
    expect(lead?.consentHistory.map((record) => [record.id, record.accepted])).toEqual([
      ["TERMS_PRIVACY", true],
      ["CONTACT", true],
      ["TERMS_PRIVACY", true],
      ["CONTACT", false],
    ]);
  });

  it("[FL-115] a fourth pending user of the same email is refused; a confirmed email is taken", async () => {
    for (const user of [1, 2, 3]) expect((await startLead(store, { user })).outcome).not.toBe("TOO_MANY_PENDING");
    expect((await startLead(store, { user: 4 })).outcome).toBe("TOO_MANY_PENDING");
    const other = "otra.persona@example.com";
    await confirmedLead(store, { email: other, user: 5 });
    expect((await startLead(store, { email: other, user: 6 })).outcome).toBe("EMAIL_TAKEN");
  });

  it("[FL-105] confirmation: only a pending lead that lists the user becomes CONFIRMED, with its sub, user and 24 months", async () => {
    await startLead(store);
    expect(await store.confirm({ emailHash: hashOf(EMAIL), username: username(9), sub: "sub-x", userId: signupUserId(1), at: T0 })).toEqual({ outcome: "NOT_PENDING" });
    const confirmed = await store.confirm({ emailHash: hashOf(EMAIL), username: username(1), sub: "sub-0001", userId: signupUserId(1), at: later(HOUR) });
    expect(confirmed.outcome).toBe("CONFIRMED");
    const lead = await store.findBySub("sub-0001");
    expect(lead).toMatchObject({ status: "CONFIRMED", cognitoSub: "sub-0001", cognitoUsername: username(1), userId: signupUserId(1), subKey: "SUB#sub-0001", confirmedAt: later(HOUR).toISOString() });
    expect(lead?.expiresAt).toBe(epochSeconds(addMonths(later(HOUR), CONFIRMED_TTL_MONTHS)));
    expect(await store.confirm({ emailHash: hashOf(EMAIL), username: username(1), sub: "sub-0001", userId: signupUserId(1), at: later(HOUR) })).toEqual({ outcome: "NOT_PENDING" });
    expect((await store.listEvents(hashOf(EMAIL))).map((event) => event.kind)).toEqual(["STARTED", "CONFIRMED"]);
  });

  it("[FL-115] a sign-in renews the confirmed lead for 24 months and records LOGIN", async () => {
    await confirmedLead(store);
    const at = new Date("2027-03-15T10:00:00.000Z");
    const lead = await store.recordLogin("sub-0001", at);
    expect(lead).toMatchObject({ lastLoginAt: at.toISOString(), expiresAt: epochSeconds(addMonths(at, 24)) });
    expect(await store.recordLogin("sub-unknown", at)).toBeUndefined();
    expect((await store.listEvents(hashOf(EMAIL))).map((event) => event.kind)).toContain("LOGIN");
  });

  it("[FL-115] the notice is claimed once; a released claim can be claimed again", async () => {
    await confirmedLead(store);
    expect(await store.claimNotice(hashOf(EMAIL), "SENT", T0)).toBe(true);
    expect(await store.claimNotice(hashOf(EMAIL), "SENT", T0)).toBe(false);
    await store.releaseNotice(hashOf(EMAIL), T0);
    expect((await store.get(hashOf(EMAIL)))?.notifyOutcome).toBe("FAILED");
    expect(await store.claimNotice(hashOf(EMAIL), "SENT", T0)).toBe(true);
  });

  it("[FL-115] withdrawing the contact adds a record and leaves the account as it was", async () => {
    const before = await confirmedLead(store);
    const lead = await store.withdrawContact(hashOf(EMAIL), contactWithdrawal("es-MX", later(HOUR)), later(HOUR));
    expect(lead?.consents.CONTACT).toMatchObject({ accepted: false, textVersion: "2026-09-26" });
    expect(lead?.consentHistory.at(-1)).toMatchObject({ id: "CONTACT", accepted: false });
    expect(lead).toMatchObject({ status: "CONFIRMED", cognitoUsername: before.cognitoUsername, userId: before.userId, expiresAt: before.expiresAt });
    expect(table.logs.map((entry) => entry.kind)).toEqual(["CONTACT_WITHDRAWN"]);
  });

  it("[FL-115] never stores the email, nor its hash, outside the lead's META item", async () => {
    await confirmedLead(store);
    await store.log({ kind: "LEAD_DELETED", actor: "OPERATOR", leadId: (await store.get(hashOf(EMAIL)))?.leadId }, T0);
    for (const item of table.allItems()) {
      if (item.SK === "META") continue;
      const text = JSON.stringify(item);
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain("@");
      if (String(item.PK).startsWith(LEAD_LOG_PREFIX)) expect(text).not.toContain(hashOf(EMAIL));
    }
  });

  it("[FL-115] deleteLead removes the lead and its events, and answers undefined the second time", async () => {
    await confirmedLead(store);
    expect((await store.deleteLead(hashOf(EMAIL)))?.email).toBe(EMAIL);
    expect(await store.get(hashOf(EMAIL))).toBeUndefined();
    expect(await store.listEvents(hashOf(EMAIL))).toEqual([]);
    expect(await store.deleteLead(hashOf(EMAIL))).toBeUndefined();
  });

  it("[FL-115] retries a write another writer beat, and gives up after its attempts", async () => {
    const racing = new MemoryLeadTable();
    let losses = 1;
    const put = racing.putMeta.bind(racing);
    racing.putMeta = async (lead, expected) => (losses-- > 0 ? false : put(lead, expected));
    const racingStore = createLeadStore(racing, { newId: sequentialIds() });
    expect((await startLead(racingStore)).outcome).toBe("CREATED");
    racing.putMeta = async () => false;
    await expect(startLead(racingStore, { user: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
