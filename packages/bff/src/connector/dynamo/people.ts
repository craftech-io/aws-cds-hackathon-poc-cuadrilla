// `People` repository: staff, customers, consent, measured profile, shift windows and the per-world
// phone claims. Identity goes through `GSI1` (`<clockId>#<phoneHash>`), which does not enforce
// uniqueness: the `ADDR#<clockId>#<phoneHash>` rows do, written in the same transaction as the
// person, and the lookup refuses to choose if it still finds two people (never guess an identity).
import { ConnectorError, type Symptom } from "@cuadrilla/shared";
import { AddressClaim, AmbiguousIdentityError, Consent, Customer, InstallerProfile, PROFILE_EVENT_LIMIT, Person, ShiftWindow, type ProfileEvent } from "../../domain/people";
import { encodeRow } from "../codecs";
import { ispKindKey, personKey, phoneKey } from "../keys";
import type { PeoplePort, PersonPatch } from "../ports-data";
import type { Patch, TransactOp } from "../table-client";
import {
  createEntity,
  entityPatch,
  entityRow,
  getEntity,
  nowIso,
  parseRows,
  patchEntity,
  patchRow,
  requireEntity,
  retryOnConflict,
  upsertEntity,
  withHistory,
  type RepoContext,
} from "./repo";

const TABLE = "People";

function checkContact(phone: unknown, phoneHash: unknown): void {
  if ((phone === undefined) !== (phoneHash === undefined)) throw new ConnectorError("VALIDATION", "phone and phoneHash go together", TABLE);
}

export function peopleRepo(ctx: RepoContext): PeoplePort {
  const { client } = ctx;
  const requirePerson = (personId: string): Promise<Person> => requireEntity(ctx, Person, "Person", { personId }, `person ${personId}`);

  const claimOp = (clockId: string, phoneHash: string, personId: string): TransactOp => {
    const { item } = entityRow(ctx, AddressClaim, "AddressClaim", { clockId, phoneHash, personId });
    return { op: "put", table: TABLE, item, condition: { ifNotExists: true } };
  };

  async function releaseClaimOp(clockId: string, phoneHash: string, personId: string): Promise<TransactOp | undefined> {
    const claim = await getEntity(ctx, AddressClaim, "AddressClaim", { clockId, phoneHash });
    if (claim?.personId !== personId) return undefined;
    return { op: "delete", table: TABLE, key: encodeRow("AddressClaim", claim).key, condition: { ifVersion: claim.version } };
  }

  async function changeContact(current: Person, patch: PersonPatch, expectedVersion: number): Promise<Person> {
    const contact = patch.contact;
    const fields: Patch = { ...patch, contact: undefined };
    if (contact === null) Object.assign(fields, { phone: null, phoneHash: null });
    else if (contact !== undefined) Object.assign(fields, { phone: contact.phone, phoneHash: contact.phoneHash });
    const built = entityPatch("Person", current, fields);
    const ops: TransactOp[] = [{ op: "update", table: TABLE, key: built.key, patch: built.patch, condition: { ifVersion: expectedVersion } }];
    const wanted = contact?.phoneHash;
    if (wanted !== current.phoneHash) {
      if (wanted !== undefined) ops.push(claimOp(current.clockId, wanted, current.personId));
      if (current.phoneHash !== undefined) {
        const release = await releaseClaimOp(current.clockId, current.phoneHash, current.personId);
        if (release) ops.push(release);
      }
    }
    await client.transact(ops, nowIso(ctx));
    return requirePerson(current.personId);
  }

  const mutateProfile = (installerId: string, clockId: string, event: ProfileEvent) =>
    retryOnConflict(3, async () => {
      const current = await getEntity(ctx, InstallerProfile, "InstallerProfile", { installerId });
      const base = current ?? { rejects: {}, stepsBySymptom: {}, casesByReason: {}, events: [] };
      const next = { rejects: { ...base.rejects }, stepsBySymptom: { ...base.stepsBySymptom }, casesByReason: { ...base.casesByReason } };
      if (event.kind === "REJECT") next.rejects = bump(next.rejects, event.code);
      if (event.kind === "STEP") next.stepsBySymptom = bump(next.stepsBySymptom, event.code as Symptom);
      if (event.kind === "CASE") next.casesByReason = bump(next.casesByReason, event.code);
      const events = [...base.events, event].slice(-PROFILE_EVENT_LIMIT);
      if (current === undefined) return createEntity(ctx, InstallerProfile, "InstallerProfile", { installerId, clockId, ...next, events });
      return patchEntity(ctx, InstallerProfile, "InstallerProfile", current, { ...next, events });
    });

  return {
    getPerson: (personId) => getEntity(ctx, Person, "Person", { personId }),
    requirePerson,
    async listPeople(ispId, role) {
      return parseRows(Person, await client.query(TABLE, { index: "GSI2", hashValue: ispKindKey(ispId, role) }), TABLE);
    },
    async findByPhone(clockId, phoneHash) {
      const people = parseRows(Person, await client.query(TABLE, { index: "GSI1", hashValue: phoneKey(clockId, phoneHash), limit: 2 }), TABLE);
      if (people.length > 1) throw new AmbiguousIdentityError(people.map((person) => person.personId));
      return people[0];
    },

    async createPerson(person) {
      checkContact(person.phone, person.phoneHash);
      const built = entityRow(ctx, Person, "Person", { history: [], ...person });
      const ops: TransactOp[] = [{ op: "put", table: TABLE, item: built.item, condition: { ifNotExists: true } }];
      if (person.phoneHash !== undefined) ops.push(claimOp(person.clockId, person.phoneHash, person.personId));
      await client.transact(ops, nowIso(ctx));
      return built.value;
    },

    async updatePerson(personId, patch, options = {}) {
      const current = await requirePerson(personId);
      const expectedVersion = options.expectedVersion ?? current.version;
      if (patch.contact !== undefined) return changeContact(current, patch, expectedVersion);
      return patchEntity(ctx, Person, "Person", current, { ...patch }, { ifVersion: expectedVersion });
    },

    async setActive(personId, active, transition) {
      const current = await requirePerson(personId);
      const history = withHistory(ctx, current.history, "active", current.active, active, transition);
      return patchEntity(ctx, Person, "Person", current, { active, history });
    },

    async recordInbound(personId, at) {
      return patchRow(ctx, TABLE, Person, personKey(personId), { lastInboundAtSim: at.atSim, lastInboundAtReal: at.atReal }, { ifExists: true });
    },

    getAddressClaim: (clockId, phoneHash) => getEntity(ctx, AddressClaim, "AddressClaim", { clockId, phoneHash }),

    getCustomer: (customerId) => getEntity(ctx, Customer, "Customer", { customerId }),
    async listCustomers(ispId) {
      return parseRows(Customer, await client.query(TABLE, { index: "GSI2", hashValue: ispKindKey(ispId, "CUSTOMER") }), TABLE);
    },
    putCustomer: (customer) => upsertEntity(ctx, Customer, "Customer", customer),

    getConsent: (personId) => getEntity(ctx, Consent, "Consent", { personId }),
    async grantConsent(input, transition) {
      const current = await getEntity(ctx, Consent, "Consent", { personId: input.personId });
      const history = withHistory(ctx, current?.history ?? [], "consent", current?.status, "GRANTED", transition);
      const fields = { ...input, kind: "WHATSAPP_OPT_IN" as const, status: "GRANTED" as const, grantedAtSim: transition.atSim, history };
      if (current === undefined) return createEntity(ctx, Consent, "Consent", fields);
      return patchEntity(ctx, Consent, "Consent", current, { ...fields, revokedAtSim: null });
    },
    async revokeConsent(personId, transition) {
      const current = await requireEntity(ctx, Consent, "Consent", { personId }, `consent of ${personId}`);
      const history = withHistory(ctx, current.history, "consent", current.status, "REVOKED", transition);
      return patchEntity(ctx, Consent, "Consent", current, { status: "REVOKED", revokedAtSim: transition.atSim, history });
    },

    getProfile: (installerId) => getEntity(ctx, InstallerProfile, "InstallerProfile", { installerId }),
    putProfile: (profile) => upsertEntity(ctx, InstallerProfile, "InstallerProfile", profile),
    recordProfileEvent: mutateProfile,

    getShiftWindow: (personId) => getEntity(ctx, ShiftWindow, "ShiftWindow", { personId }),
    openShiftWindow: (window) => upsertEntity(ctx, ShiftWindow, "ShiftWindow", window),
  };
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): Partial<Record<K, number>> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}
