// From a filled template to the rows of one guest world (ADR-0025 §2, docs/seed-spec.md §3 and §13):
// what the template cannot know is added here, and every row is checked to belong to the world.
//
//   Isps/META          the visible name of the operator (`resolveBrand`, never a literal of the seed)
//   Isps/SETTINGS      the caps of the world's origin, and the guest a sign-up generation belongs to
//   People/PERSON      the phone hash of each person (identity by phone within the world)
//   WorkOrders         the world's epoch on orders and evidence; evidence under `guest/<seg>/`;
//                      historical certificates `pdfPending` until the factory can render them (WP-39)
//   every row          `world` and `expiresAt` of the world's policy (the end of the creation day plus
//                      9 days for a sign-up generation), its real creation time
//
// Nothing outside the guest's operator: a row whose operator, clock or key names anything but the
// world's own ids makes the whole world fail before a single row is written.
import { type GuestOrigin, clockIdOfIsp } from "@cuadrilla/shared";
import { evidencePhotoKey } from "@cuadrilla/shared/media/keys";
import { DOMAIN_TABLES, type DomainTable } from "../domain/registry";
import type { WorldPolicy } from "../connector/world";
import type { Item, MockTable, Table } from "../connector/table-client";
import { type FilledTemplate, type TemplateRow, type WorldMarkers, TemplateError, capsOf } from "./template";

export const MOCK_TABLES: readonly MockTable[] = ["Network", "Dispatch"];

export interface CloneInput {
  readonly template: FilledTemplate;
  readonly markers: WorldMarkers;
  readonly origin: GuestOrigin;
  /** Epoch of the world's clock (`COUNTER#EPOCH#<clockId>`). */
  readonly worldEpoch: number;
  /** `resolveBrand(...).operatorName` for the world's brand mode. */
  readonly displayName: string;
  /** The sign-up guest the generation belongs to (caps per account). */
  readonly ownerUserId?: string | undefined;
  /** HMAC of an E.164 number with the `phone-hash` subkey (lib/crypto.ts `phoneHash`). */
  readonly phoneHash: (phone: string) => string;
  readonly policy: WorldPolicy;
  /** Real instant of the build. */
  readonly now: Date;
}

export interface WorldRows {
  readonly ispId: string;
  readonly clockId: string;
  readonly domain: ReadonlyMap<DomainTable, readonly Item[]>;
  readonly mocks: ReadonlyMap<MockTable, readonly Item[]>;
}

const text = (row: TemplateRow, name: string): string | undefined => (typeof row[name] === "string" ? (row[name] as string) : undefined);

function keyed(row: TemplateRow, table: string, index: number): Item {
  const PK = text(row, "PK");
  const SK = text(row, "SK");
  if (PK === undefined || SK === undefined) throw new TemplateError(`${table} row ${index} has no key`);
  return { ...row, PK, SK };
}

function isDomainTable(table: string): table is DomainTable {
  return (DOMAIN_TABLES as readonly string[]).includes(table);
}

function isMockTable(table: string): table is MockTable {
  return (MOCK_TABLES as readonly string[]).includes(table);
}

/** The operator ids a row names anywhere (`isp-…`), for the check that it names only its own. */
const OPERATOR_ID = /\bisp-[a-z0-9]+(?:-[a-z0-9]+)*/g;
const CLOCK_SCOPE = /\b(?:GLOBAL|GUEST)#isp-[a-z0-9]+(?:-[a-z0-9]+)*/g;

/** Throws unless every operator and clock the row names is the world's, and its key carries the world's ids. */
export function assertOwnRow(item: Item, table: Table, markers: WorldMarkers): void {
  const clockId = clockIdOfIsp(markers.ispId);
  const serialized = JSON.stringify(item);
  const foreignOperator = [...serialized.matchAll(OPERATOR_ID)].find((match) => match[0] !== markers.ispId);
  const foreignClock = [...serialized.matchAll(CLOCK_SCOPE)].find((match) => match[0] !== clockId);
  if (foreignOperator !== undefined || foreignClock !== undefined) throw new TemplateError(`a ${table} row names another world`);
  if (!item.PK.includes(markers.ispId) && !item.PK.includes(`-${markers.clockTag}`)) throw new TemplateError(`a ${table} row is stored outside the world's keys`);
}

function withWorld(input: CloneInput, table: Table, clockId: string, row: Item): Item {
  const scope = input.policy(clockId, table, input.now);
  const at = input.now.toISOString();
  const { world: _world, expiresAt: _expiresAt, ...rest } = row;
  return {
    ...rest,
    ...(scope.world === undefined ? {} : { world: scope.world }),
    ...(scope.expiresAt === undefined ? {} : { expiresAt: scope.expiresAt }),
    createdAt: at,
    updatedAt: at,
  };
}

function isps(row: Item, input: CloneInput): Item {
  if (row.entity === "Isp") return { ...row, displayName: input.displayName };
  if (row.entity !== "IspSettings") return row;
  const caps = capsOf(input.template, input.origin);
  return {
    ...row,
    capsProfile: input.origin,
    simulatorCaps: caps.simulatorCaps,
    turnCaps: caps.turnCaps,
    ...(input.ownerUserId === undefined ? {} : { ownerUserId: input.ownerUserId }),
  };
}

function people(row: Item, input: CloneInput): Item {
  const phone = text(row, "phone");
  return row.entity === "Person" && phone !== undefined ? { ...row, phoneHash: input.phoneHash(phone) } : row;
}

/** A `WorkOrders` row of a template in a world: the epoch on orders and evidence, evidence under the world's key. */
export function stampWorkOrderRow(row: Item, worldEpoch: number, clockId: string): Item {
  switch (row.entity) {
    case "WorkOrder":
      return { ...row, worldEpoch };
    case "Evidence": {
      const workOrderId = text(row, "workOrderId") ?? "";
      const s3Key = evidencePhotoKey(clockId, worldEpoch, workOrderId, text(row, "item") ?? "", text(row, "evidenceId") ?? "");
      return { ...row, worldEpoch, s3Key };
    }
    case "Certificate":
      return row.sha256 === undefined || row.s3Key === undefined ? { ...row, pdfPending: true } : row;
    default:
      return row;
  }
}

function adapt(table: string, row: Item, input: CloneInput, clockId: string): Item {
  if (table === "Isps") return isps(row, input);
  if (table === "People") return people(row, input);
  if (table === "WorkOrders") return stampWorkOrderRow(row, input.worldEpoch, clockId);
  return row;
}

/** The rehearsal world's console users of the `QaDriver` (`usr-qa-guest`), only for `TEST`. */
function testUsers(input: CloneInput): TemplateRow[] {
  if (input.origin !== "TEST") return [];
  return (input.template.guestTest?.consoleUsers ?? []).map((user) => ({
    PK: `ISP#${input.markers.ispId}`,
    SK: `USER#${user.userId}`,
    entity: "ConsoleUser",
    ispId: input.markers.ispId,
    userId: user.userId,
    role: user.role,
    name: user.name,
    cognitoSub: "",
    active: true,
    guestOrigin: "TEST",
    synthetic: true,
    version: 1,
  }));
}

/** Every row of the world, table by table, adapted, scoped and checked; throws before any write. */
export function cloneWorld(input: CloneInput): WorldRows {
  const { ispId } = input.markers;
  const clockId = clockIdOfIsp(ispId);
  const domain = new Map<DomainTable, Item[]>();
  const mocks = new Map<MockTable, Item[]>();
  for (const [table, rows] of Object.entries(input.template.tables)) {
    const extra = table === "Isps" ? testUsers(input) : [];
    const items = [...rows, ...extra].map((row, index) => {
      const item = withWorld(input, table as Table, clockId, adapt(table, keyed(row, table, index), input, clockId));
      assertOwnRow(item, table as Table, input.markers);
      return item;
    });
    if (items.length === 0) continue;
    if (isDomainTable(table)) domain.set(table, items);
    else if (isMockTable(table)) mocks.set(table, items);
    else throw new TemplateError(`the template names an unknown table ${table}`);
  }
  return { ispId, clockId, domain, mocks };
}

/** How many rows of each table the world has (the manifest of the template, for tests and logs). */
export function rowCounts(rows: WorldRows): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, items] of [...rows.domain, ...rows.mocks]) counts[table] = items.length;
  return counts;
}
