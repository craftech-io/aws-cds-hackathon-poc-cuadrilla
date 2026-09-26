// Cross-operator fence of the console (docs/architecture.md §10, FL-081): before a procedure runs,
// every id its input names is checked against the operator and the world of the principal, so no
// procedure can forget to. An id of another operator is refused with 403 and `AuditLog DENY
// CROSS_ISP` (routers/trpc.ts does both); an id that exists nowhere passes, and the procedure answers
// NOT_FOUND as it would for any unknown id.
//
// What the fence recognises, anywhere in the input (nested objects and arrays included):
//
//   an operator id (`isp-…`)                       must be the principal's operator
//   a world (`GLOBAL#…`, `GUEST#…`; `qa-…` and    must be the principal's world
//     `eval-…` under a `clockId` field)
//   an order, case, installer, supervisor, zone    its stored operator must be the principal's
//     chief or customer id (`wo-`, `case-`, `inst-`, `sup-`, `zc-`, `cust-`)
//
// Everything else is scoped by the procedure itself: zone, crew and console user ids repeat in every
// operator (the procedure reads them under the principal's operator), and evidence and validations
// live under their order, whose id the input carries.
import { type IdKind, ToolError, kindOfId, parseClockId } from "@cuadrilla/shared";
import type { Connector } from "../connector/ports";

const FENCED_KINDS = ["workOrder", "case", "installer", "supervisor", "zoneChief", "customer"] as const satisfies readonly IdKind[];
export type FencedKind = (typeof FENCED_KINDS)[number];
const FENCED: ReadonlySet<string> = new Set(FENCED_KINDS);

export type ReferenceKind = FencedKind | "isp" | "clock";

export interface InputReference {
  readonly kind: ReferenceKind;
  readonly value: string;
  /** Where the input carries it: `items.0.workOrderId`. */
  readonly field: string;
}

/** The operator an id belongs to, or `undefined` when no such row exists. */
export interface OwnerLookup {
  ownerOf(kind: FencedKind, id: string): Promise<string | undefined>;
}

export interface FenceScope {
  readonly ispId: string;
  readonly clockId: string;
}

// A console input is a handful of fields; anything deeper or larger is refused rather than skimmed.
const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const CLOCK_FIELD = /clockids?$/i;

function classify(value: string, key: string | undefined): ReferenceKind | undefined {
  if ((value.includes("#") || (key !== undefined && CLOCK_FIELD.test(key))) && parseClockId(value) !== undefined) return "clock";
  const kind = kindOfId(value);
  if (kind === "isp") return "isp";
  return kind !== undefined && FENCED.has(kind) ? (kind as FencedKind) : undefined;
}

/** Every operator, world and fenced entity id of an input, once each. */
export function referencesIn(input: unknown): InputReference[] {
  const found = new Map<string, InputReference>();
  let nodes = 0;

  const visit = (value: unknown, path: readonly string[], key: string | undefined, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new ToolError("INVALID", "the request input is too large to check", "INPUT_TOO_LARGE");
    if (typeof value === "string") {
      const kind = classify(value, key);
      if (kind !== undefined && !found.has(`${kind}:${value}`)) found.set(`${kind}:${value}`, { kind, value, field: path.join(".") });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)], key, depth + 1));
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [field, item] of Object.entries(value)) visit(item, [...path, field], field, depth + 1);
    }
  };

  visit(input, [], undefined, 0);
  return [...found.values()];
}

/** The first reference of `input` outside `scope`, or `undefined` when every one is the principal's. */
export async function findTrespass(input: unknown, scope: FenceScope, owners: OwnerLookup): Promise<InputReference | undefined> {
  const references = referencesIn(input);
  const direct = references.find(
    (reference) => (reference.kind === "isp" && reference.value !== scope.ispId) || (reference.kind === "clock" && reference.value !== scope.clockId),
  );
  if (direct !== undefined) return direct;
  const stored = references.filter((reference): reference is InputReference & { kind: FencedKind } => FENCED.has(reference.kind));
  const ownerIds = await Promise.all(stored.map((reference) => owners.ownerOf(reference.kind, reference.value)));
  return stored.find((_reference, index) => ownerIds[index] !== undefined && ownerIds[index] !== scope.ispId);
}

/** Owners read from the connector: each id is the key of its row, whose `ispId` names the operator. */
export function connectorOwners(connector: Pick<Connector, "workOrders" | "cases" | "people">): OwnerLookup {
  return {
    async ownerOf(kind, id) {
      switch (kind) {
        case "workOrder":
          return (await connector.workOrders.getWorkOrder(id))?.ispId;
        case "case":
          return (await connector.cases.getCase(id))?.ispId;
        case "customer":
          return (await connector.people.getCustomer(id))?.ispId;
        case "installer":
        case "supervisor":
        case "zoneChief":
          return (await connector.people.getPerson(id))?.ispId;
      }
    },
  };
}
