// `LeadStore`: the only way the app reads and writes the `Leads` table (ADR-0026). It sits OUTSIDE the
// demo's connector: its storage primitive is `LeadTable` (DynamoDB in leads/dynamo-table.ts, a map in
// leads/memory-table.ts for tests), and every change of a lead is a read, a pure transformation
// (leads/transitions.ts) and a conditional put on the lead's `version`, retried a few times when
// another writer got there first.
//
// Why a condition on `version` and never on `status`: the `Bff` may name only the form's attributes on
// `Leads` (`dynamodb:Attributes`, infra/leads-spec.ts), conditions included, so "the lead is still
// pending" is checked by the code on the lead it read, and the version makes that read authoritative.
//
// Who calls what: `signup.start` (Bff) → `get`, `startPending`; post-confirmation → `confirm`;
// post-authentication → `recordLogin`; `LeadStream` → `claimNotice`, `releaseNotice`,
// `setPendingUsernames`, `log`; `GuestAccountDeletion` → `get`, `findBySub`, `deleteLead`, `log`;
// the operator's scripts → `scan`, `withdrawContact`, `recordEvent`.
import { ConnectorError } from "@cuadrilla/shared";
import type { ConsentRecord, Lead, LeadActor, LeadEvent, LeadEventKind, LeadLogEntry, LeadLogInput, NotifyOutcome } from "./model";
import { LEAD_EVENT_PREFIX, LeadLogEntry as LeadLogEntrySchema, emailHashOfPartition, isPending, leadLogPartition, leadSubKey, logExpiresAt } from "./model";
import { type ConfirmInput, type StartPendingInput, confirmedLead, loggedInLead, newLead, restartedLead, withdrawnContactLead } from "./transitions";

export type { ConfirmInput, StartPendingInput } from "./transitions";

/** Storage primitive under the store: keyed items of `Leads`, no business rule. */
export interface LeadTable {
  getMeta(emailHash: string): Promise<Lead | undefined>;
  /**
   * Writes the whole `META` item. `expectedVersion` undefined: only if the lead does not exist;
   * otherwise only if the stored `version` equals it. `false` when the condition failed.
   */
  putMeta(lead: Lead, expectedVersion: number | undefined): Promise<boolean>;
  /** `false` when the lead was not there (or had another version). */
  deleteMeta(emailHash: string, expectedVersion?: number): Promise<boolean>;
  /** `META` items whose `subKey` is `SUB#<sub>` (GSI1). */
  queryBySubKey(subKey: string): Promise<Lead[]>;
  putRecord(item: LeadEvent | LeadLogEntry): Promise<void>;
  listEvents(emailHash: string): Promise<LeadEvent[]>;
  deleteEvents(emailHash: string, sortKeys: readonly string[]): Promise<void>;
  /** Every `META` item (the operator's export; never a request path). */
  scanMeta(): Promise<Lead[]>;
}

export type StartPendingResult =
  | { readonly outcome: "CREATED"; readonly lead: Lead }
  | { readonly outcome: "ADDED"; readonly lead: Lead }
  | { readonly outcome: "EMAIL_TAKEN" }
  | { readonly outcome: "TOO_MANY_PENDING" };

export type ConfirmResult = { readonly outcome: "CONFIRMED"; readonly lead: Lead } | { readonly outcome: "NOT_PENDING" };

export interface LeadStore {
  get(emailHash: string): Promise<Lead | undefined>;
  /** The confirmed lead of a Cognito `sub` (GSI1); `undefined` when none or ambiguous. */
  findBySub(sub: string): Promise<Lead | undefined>;
  /** `signup.start`: a new pending lead, or one more pending user on the existing one (≤ 3). */
  startPending(input: StartPendingInput): Promise<StartPendingResult>;
  /** Post-confirmation: a pending lead that lists `username` → `CONFIRMED`. */
  confirm(input: ConfirmInput): Promise<ConfirmResult>;
  /** Post-authentication: `lastLoginAt` and 24 more months, event `LOGIN`. */
  recordLogin(sub: string, at: Date): Promise<Lead | undefined>;
  /** `LeadStream`: claims the notice (`notifiedAt` absent → set). `false` when it was already claimed. */
  claimNotice(emailHash: string, outcome: NotifyOutcome, at: Date): Promise<boolean>;
  /** A notice that could not be sent: `notifiedAt` out again (the stream retries), `notifyOutcome FAILED`. */
  releaseNotice(emailHash: string, at: Date): Promise<void>;
  /** Replaces the pending users (the confirmed account's siblings go out of Cognito first). */
  setPendingUsernames(emailHash: string, usernames: readonly string[], at: Date): Promise<void>;
  /** `leads:unsubscribe`: `CONTACT` not accepted any more, the account untouched. */
  withdrawContact(emailHash: string, record: ConsentRecord, at: Date): Promise<Lead | undefined>;
  recordEvent(emailHash: string, kind: LeadEventKind, actor: LeadActor, at: Date): Promise<void>;
  listEvents(emailHash: string): Promise<LeadEvent[]>;
  /** The lead and its events; the deleted lead, or `undefined` when it was already gone. */
  deleteLead(emailHash: string): Promise<Lead | undefined>;
  /** An entry of `LEADLOG#<yyyy-mm>`: never the email nor its hash. */
  log(input: LeadLogInput, at: Date): Promise<void>;
  scan(): Promise<Lead[]>;
}

export interface LeadStoreOptions {
  /** Fresh ULIDs (lead ids, event and log sort keys). */
  readonly newId: () => string;
  /** Read-modify-write attempts when another writer changed the lead in between. */
  readonly attempts?: number;
}

const DEFAULT_ATTEMPTS = 4;

function contention(what: string): ConnectorError {
  return new ConnectorError("CONFLICT", `the lead kept changing while ${what}`, "Leads");
}

export function createLeadStore(table: LeadTable, options: LeadStoreOptions): LeadStore {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;

  /** Read, transform, put on the version read; `skip` leaves the lead as it is. */
  async function mutate<T>(emailHash: string, what: string, change: (current: Lead | undefined) => { readonly next: Lead; readonly result: T } | { readonly skip: T }): Promise<T> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await table.getMeta(emailHash);
      const decided = change(current);
      if ("skip" in decided) return decided.skip;
      if (await table.putMeta(decided.next, current?.version)) return decided.result;
    }
    throw contention(what);
  }

  async function event(lead: Pick<Lead, "PK" | "expiresAt">, kind: LeadEventKind, actor: LeadActor, at: Date): Promise<void> {
    await table.putRecord({ PK: lead.PK, SK: `${LEAD_EVENT_PREFIX}${at.toISOString()}#${options.newId()}`, entity: "LeadEvent", kind, actor, createdAt: at.toISOString(), expiresAt: lead.expiresAt });
  }

  const store: LeadStore = {
    get: (emailHash) => table.getMeta(emailHash),

    async findBySub(sub) {
      if (sub === "") return undefined;
      const leads = await table.queryBySubKey(leadSubKey(sub));
      return leads.length === 1 ? leads[0] : undefined;
    },

    async startPending(input) {
      const result = await mutate<StartPendingResult>(input.emailHash, "starting a sign-up", (current) => {
        if (current === undefined) {
          const lead = newLead(input, options.newId());
          return { next: lead, result: { outcome: "CREATED", lead } };
        }
        if (!isPending(current)) return { skip: { outcome: "EMAIL_TAKEN" } };
        const next = restartedLead(current, input);
        if (next === undefined) return { skip: { outcome: "TOO_MANY_PENDING" } };
        return { next, result: { outcome: "ADDED", lead: next } };
      });
      if (result.outcome === "CREATED" || result.outcome === "ADDED") await event(result.lead, "STARTED", "GUEST", input.at);
      return result;
    },

    async confirm(input) {
      const result = await mutate<ConfirmResult>(input.emailHash, "confirming", (current) => {
        const next = current === undefined ? undefined : confirmedLead(current, input);
        return next === undefined ? { skip: { outcome: "NOT_PENDING" } } : { next, result: { outcome: "CONFIRMED", lead: next } };
      });
      if (result.outcome === "CONFIRMED") await event(result.lead, "CONFIRMED", "GUEST", input.at);
      return result;
    },

    async recordLogin(sub, at) {
      const found = await store.findBySub(sub);
      if (found === undefined) return undefined;
      const emailHash = emailHashOfPartition(found.PK);
      const lead = await mutate<Lead | undefined>(emailHash, "recording a sign-in", (current) => {
        const next = current === undefined ? undefined : loggedInLead(current, at);
        return next === undefined ? { skip: undefined } : { next, result: next };
      });
      if (lead !== undefined) await event(lead, "LOGIN", "GUEST", at);
      return lead;
    },

    async claimNotice(emailHash, outcome, at) {
      const claimed = await mutate<boolean>(emailHash, "claiming the notice", (current) => {
        if (current === undefined || current.notifiedAt !== undefined) return { skip: false };
        return { next: { ...current, notifiedAt: at.toISOString(), notifyOutcome: outcome, version: current.version + 1, updatedAt: at.toISOString() }, result: true };
      });
      if (claimed) {
        const lead = await table.getMeta(emailHash);
        if (lead !== undefined) await event(lead, "NOTIFIED", "SYSTEM", at);
      }
      return claimed;
    },

    async releaseNotice(emailHash, at) {
      await mutate<void>(emailHash, "releasing the notice", (current) => {
        if (current === undefined) return { skip: undefined };
        const { notifiedAt: _released, ...rest } = current;
        return { next: { ...rest, notifyOutcome: "FAILED", version: current.version + 1, updatedAt: at.toISOString() }, result: undefined };
      });
    },

    async setPendingUsernames(emailHash, usernames, at) {
      await mutate<void>(emailHash, "updating the pending users", (current) => {
        if (current === undefined) return { skip: undefined };
        const same = current.pendingUsernames.length === usernames.length && current.pendingUsernames.every((name, index) => name === usernames[index]);
        return same ? { skip: undefined } : { next: { ...current, pendingUsernames: [...usernames], version: current.version + 1, updatedAt: at.toISOString() }, result: undefined };
      });
    },

    async withdrawContact(emailHash, record, at) {
      const lead = await mutate<Lead | undefined>(emailHash, "withdrawing the contact consent", (current) => {
        if (current === undefined) return { skip: undefined };
        const next = withdrawnContactLead(current, record, at);
        return { next, result: next };
      });
      if (lead !== undefined) {
        await event(lead, "CONTACT_WITHDRAWN", "OPERATOR", at);
        await store.log({ kind: "CONTACT_WITHDRAWN", actor: "OPERATOR", leadId: lead.leadId }, at);
      }
      return lead;
    },

    async recordEvent(emailHash, kind, actor, at) {
      const lead = await table.getMeta(emailHash);
      if (lead !== undefined) await event(lead, kind, actor, at);
    },

    listEvents: (emailHash) => table.listEvents(emailHash),

    async deleteLead(emailHash) {
      const lead = await table.getMeta(emailHash);
      const events = await table.listEvents(emailHash);
      if (events.length > 0) await table.deleteEvents(emailHash, events.map((item) => item.SK));
      if (lead === undefined) return undefined;
      await table.deleteMeta(emailHash);
      return lead;
    },

    async log(input, at) {
      const entry = LeadLogEntrySchema.parse({
        PK: leadLogPartition(at),
        SK: `${at.toISOString()}#${options.newId()}`,
        entity: "LeadLog",
        kind: input.kind,
        actor: input.actor,
        ...(input.leadId === undefined ? {} : { leadId: input.leadId }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.sub === undefined ? {} : { sub: input.sub }),
        createdAt: at.toISOString(),
        expiresAt: logExpiresAt(at),
      });
      await table.putRecord(entry);
    },

    scan: () => table.scanMeta(),
  };
  return store;
}
