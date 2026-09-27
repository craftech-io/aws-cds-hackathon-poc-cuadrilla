import { AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { AttributeValue } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CognitoUsers, createCognitoUsers } from "../leads/cognito-users";
import type { DeletionRequestInput } from "../leads/deletion";
import type { Lead } from "../leads/model";
import type { LeadStreamDeps } from "../leads/stream";
import { NOTIFY_FIXTURE, T0, confirmedLead, hashOf, leadHarness, signupUserId, startLead, username } from "../leads/testing";
import type { MemoryLeadTable } from "../leads/memory-table";
import { createLogger } from "../lib/log";
import { handleLeadStream } from "./lead-stream";

const EMAIL = "ana.prueba@example.com";
const DAY = 24 * 60 * 60 * 1000;

function toAttribute(value: unknown): AttributeValue {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (value === null) return { NULL: true };
  if (Array.isArray(value)) return { L: value.map(toAttribute) };
  return { M: toImage(value as Record<string, unknown>) };
}
function toImage(item: Record<string, unknown>): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).map(([key, value]) => [key, toAttribute(value)]));
}
const keys = (lead: Lead) => toImage({ PK: lead.PK, SK: lead.SK });
const modify = (before: Lead, after: Lead) => ({ eventName: "MODIFY", dynamodb: { Keys: keys(after), OldImage: toImage(before), NewImage: toImage(after) } });
const ttlRemove = (lead: Lead) => ({ eventName: "REMOVE", userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" }, dynamodb: { Keys: keys(lead), OldImage: toImage(lead) } });
const userRemove = (lead: Lead) => ({ eventName: "REMOVE", dynamodb: { Keys: keys(lead), OldImage: toImage(lead) } });

interface Harness {
  readonly table: MemoryLeadTable;
  readonly deps: LeadStreamDeps;
  readonly deleted: string[];
  readonly invoked: DeletionRequestInput[];
  readonly sent: SendEmailCommand["input"][];
  readonly lines: string[];
  unconfirmed: Array<{ username: string; createdAt: Date }>;
}

function harness(): Harness {
  const { table, store } = leadHarness();
  const deleted: string[] = [];
  const invoked: DeletionRequestInput[] = [];
  const sent: SendEmailCommand["input"][] = [];
  const lines: string[] = [];
  const h: Harness = { table, deleted, invoked, sent, lines, unconfirmed: [], deps: undefined as unknown as LeadStreamDeps };
  const cognito: CognitoUsers = {
    async deleteUser(name) {
      deleted.push(name);
      return "DELETED";
    },
    listUnconfirmed: async () => h.unconfirmed,
  };
  Object.assign(h, {
    deps: {
      store,
      ses: {
        send: vi.fn(async (command: SendEmailCommand) => {
          sent.push(command.input);
          return { MessageId: `msg-${sent.length}` };
        }),
      } as unknown as LeadStreamDeps["ses"],
      channel: () => ({ identityDomain: "cuadrilla.demo.craftech.io", configurationSetName: "cuadrilla-email-test", sender: "leads@cuadrilla.demo.craftech.io" }),
      config: () => ({ notifyRecipients: [NOTIFY_FIXTURE] }),
      now: () => new Date(T0.getTime() + 60_000),
      stage: "poc",
      log: createLogger({ level: "debug", sink: (line) => lines.push(line) }),
      cognito,
      invokeDeletion: async (request: DeletionRequestInput) => void invoked.push(request),
    } satisfies LeadStreamDeps,
  });
  return h;
}

describe("LeadStream [FL-118]", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("[FL-118] MODIFY to CONFIRMED: the notice, the other pending users out of Cognito and the list emptied", async () => {
    await startLead(h.deps.store, { user: 1 });
    await startLead(h.deps.store, { user: 2 });
    const before = await h.deps.store.get(hashOf(EMAIL));
    const after = await confirmedLead(h.deps.store, { user: 2 });
    const summary = await handleLeadStream({ Records: [modify(before as Lead, after)] }, h.deps);
    expect(summary).toEqual({ confirmed: 1, expired: 0, ignored: 0 });
    expect(h.sent).toHaveLength(1);
    expect(h.deleted).toEqual([username(1)]);
    expect((await h.deps.store.get(hashOf(EMAIL)))?.pendingUsernames).toEqual([]);
  });

  it("[FL-114] users retired by later starts go out of Cognito too, on the confirmation and on the expiry", async () => {
    for (const user of [1, 2, 3, 4]) await startLead(h.deps.store, { user });
    const pending = (await h.deps.store.get(hashOf(EMAIL))) as Lead;
    expect(pending.retiredUsernames).toEqual([username(1)]);
    await handleLeadStream({ Records: [ttlRemove(pending)] }, h.deps);
    expect([...h.deleted].sort()).toEqual([1, 2, 3, 4].map(username).sort());
    h.deleted.length = 0;
    const result = await h.deps.store.confirm({ emailHash: hashOf(EMAIL), username: username(4), sub: "sub-0004", userId: signupUserId(4), at: T0 });
    if (result.outcome !== "CONFIRMED") throw new Error("the lead did not confirm");
    await handleLeadStream({ Records: [modify(pending, result.lead)] }, h.deps);
    expect([...h.deleted].sort()).toEqual([1, 2, 3].map(username).sort());
    const after = await h.deps.store.get(hashOf(EMAIL));
    expect(after?.pendingUsernames).toEqual([]);
    expect(after?.retiredUsernames).toBeUndefined();
  });

  it("[FL-114] a retired user that confirms keeps its Cognito user; the pending ones go", async () => {
    for (const user of [1, 2, 3, 4]) await startLead(h.deps.store, { user });
    const pending = (await h.deps.store.get(hashOf(EMAIL))) as Lead;
    const result = await h.deps.store.confirm({ emailHash: hashOf(EMAIL), username: username(1), sub: "sub-0001", userId: signupUserId(1), at: T0 });
    if (result.outcome !== "CONFIRMED") throw new Error("the retired user did not confirm the lead");
    await handleLeadStream({ Records: [modify(pending, result.lead)] }, h.deps);
    expect(h.sent).toHaveLength(1);
    expect([...h.deleted].sort()).toEqual([2, 3, 4].map(username).sort());
  });

  it("[FL-118] a retried batch does not notify twice, and a change after the confirmation is ignored", async () => {
    await startLead(h.deps.store);
    const before = await h.deps.store.get(hashOf(EMAIL));
    const after = await confirmedLead(h.deps.store);
    await handleLeadStream({ Records: [modify(before as Lead, after)] }, h.deps);
    await handleLeadStream({ Records: [modify(before as Lead, after), modify(after, { ...after, version: after.version + 1 })] }, h.deps);
    expect(h.sent).toHaveLength(1);
  });

  it("[FL-118] REMOVE of a pending lead by TTL: each pending user out of Cognito and LEAD_EXPIRED with the leadId", async () => {
    await startLead(h.deps.store, { user: 1 });
    await startLead(h.deps.store, { user: 2 });
    const lead = (await h.deps.store.get(hashOf(EMAIL))) as Lead;
    expect(await handleLeadStream({ Records: [ttlRemove(lead)] }, h.deps)).toEqual({ confirmed: 0, expired: 1, ignored: 0 });
    expect(h.deleted).toEqual([username(1), username(2)]);
    expect(h.invoked).toEqual([]);
    expect(h.table.logs).toEqual([expect.objectContaining({ kind: "LEAD_EXPIRED", actor: "TTL", leadId: lead.leadId, reason: "NEVER_CONFIRMED" })]);
  });

  it("[FL-118] REMOVE of a CONFIRMED lead by TTL invokes GuestAccountDeletion with the userId of the old image", async () => {
    const lead = await confirmedLead(h.deps.store, { userId: signupUserId(3) });
    await handleLeadStream({ Records: [ttlRemove({ ...lead, pendingUsernames: [] })] }, h.deps);
    expect(h.invoked).toEqual([{ userId: signupUserId(3), actor: "TTL", abuseHash: lead.abuseHash }]);
    expect(h.table.logs).toEqual([expect.objectContaining({ kind: "LEAD_EXPIRED", leadId: lead.leadId, reason: "CONFIRMED_INACTIVE" })]);
  });

  it("[FL-118] ignores a REMOVE that DynamoDB's TTL did not make, an INSERT and items that are not a lead", async () => {
    const lead = await confirmedLead(h.deps.store);
    const log = { eventName: "INSERT", dynamodb: { Keys: toImage({ PK: "LEADLOG#2026-10", SK: "x" }), NewImage: toImage({ PK: "LEADLOG#2026-10", SK: "x" }) } };
    const insert = { eventName: "INSERT", dynamodb: { Keys: keys(lead), NewImage: toImage(lead) } };
    expect(await handleLeadStream({ Records: [userRemove(lead), log, insert] }, h.deps)).toEqual({ confirmed: 0, expired: 0, ignored: 3 });
    expect([h.deleted, h.invoked, h.sent]).toEqual([[], [], []]);
  });

  it("[FL-118] refuses anything that is neither a stream batch nor the sweep, and a lead image that does not parse", async () => {
    await expect(handleLeadStream({ kind: "OTHER" }, h.deps)).rejects.toThrow(RangeError);
    const lead = await confirmedLead(h.deps.store);
    await expect(handleLeadStream({ Records: [ttlRemove({ ...lead, email: 7 } as never)] }, h.deps)).rejects.toThrow();
  });

  it("[FL-118] the daily sweep deletes only gst-* users unconfirmed for more than 7 days, never another user", async () => {
    const now = h.deps.now().getTime();
    h.unconfirmed = [
      { username: username(1), createdAt: new Date(now - 8 * DAY) },
      { username: username(2), createdAt: new Date(now - 6 * DAY) },
      { username: "guest-07", createdAt: new Date(now - 30 * DAY) },
      { username: "adriana", createdAt: new Date(now - 30 * DAY) },
    ];
    expect(await handleLeadStream({ kind: "UNCONFIRMED_SWEEP" }, h.deps)).toEqual({ swept: 1 });
    expect(h.deleted).toEqual([username(1)]);
    expect(h.lines.some((line) => line.includes('"metric":"UnconfirmedUsersSwept"') && line.includes('"value":1'))).toBe(true);
  });

  it("[FL-118] never calls Cognito with an email and never logs one", async () => {
    await startLead(h.deps.store, { user: 1 });
    const lead = (await h.deps.store.get(hashOf(EMAIL))) as Lead;
    await handleLeadStream({ Records: [ttlRemove(lead)] }, h.deps);
    for (const name of h.deleted) expect(name).not.toContain("@");
    expect(h.lines.join("\n")).not.toContain(EMAIL);
  });
});

describe("Cognito calls of the lead lifecycle [FL-118]", () => {
  const cognito = mockClient(CognitoIdentityProviderClient);
  const users = () => createCognitoUsers({ client: new CognitoIdentityProviderClient({}), userPoolId: () => "us-east-1_TESTPOOL1", sleep: async () => undefined });
  beforeEach(() => cognito.reset());

  it("[FL-118] AdminDeleteUser with the gst-* username only; a user already gone is fine", async () => {
    cognito.on(AdminDeleteUserCommand).resolvesOnce({}).rejectsOnce(Object.assign(new Error("gone"), { name: "UserNotFoundException" }));
    expect(await users().deleteUser(username(1))).toBe("DELETED");
    expect(await users().deleteUser(username(2))).toBe("NOT_FOUND");
    expect(cognito.commandCalls(AdminDeleteUserCommand).map((call) => call.args[0].input)).toEqual([
      { UserPoolId: "us-east-1_TESTPOOL1", Username: username(1) },
      { UserPoolId: "us-east-1_TESTPOOL1", Username: username(2) },
    ]);
  });

  it("[FL-118] refuses before the SDK any username that is not gst-<ULID>, an email included", async () => {
    for (const name of ["guest-07", "adriana", EMAIL, "gst-short"]) await expect(users().deleteUser(name), name).rejects.toThrow(RangeError);
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it("[FL-118] lists UNCONFIRMED users page by page with the status filter", async () => {
    cognito
      .on(ListUsersCommand)
      .resolvesOnce({ Users: [{ Username: username(1), UserCreateDate: T0 }], PaginationToken: "next" })
      .resolvesOnce({ Users: [{ Username: username(2), UserCreateDate: T0 }] });
    expect((await users().listUnconfirmed()).map((user) => user.username)).toEqual([username(1), username(2)]);
    const calls = cognito.commandCalls(ListUsersCommand).map((call) => call.args[0].input);
    expect(calls[0]).toMatchObject({ UserPoolId: "us-east-1_TESTPOOL1", Filter: 'cognito:user_status = "UNCONFIRMED"' });
    expect(calls[1]).toMatchObject({ PaginationToken: "next" });
  });
});
