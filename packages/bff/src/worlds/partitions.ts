// Where a guest world's items live, partition by partition, without scanning a table: the partitions
// of its template (every one carries the world's ids) plus the ones its activity opens with keys the
// template already names (a person's thread, an order's timers, the world's audit months, its runtime
// rows). guest-lifecycle.ts empties each one to destroy a generation; the cases, whose ids are ULIDs,
// come from the operator's index of cases instead.
import { clockIdOfIsp } from "@cuadrilla/shared";
import { addressClaimKey, auditPartition, clockKey, installerStateKey, outboxPartition, pendingPartition, worldStateKey } from "../connector/keys";
import type { Table } from "../connector/table-client";
import { type WorldMarkers, fillTemplate } from "./template";

export interface Partition {
  readonly table: Table;
  readonly partition: string;
}

const MONTH_MS = 31 * 86_400_000;

/** `yyyy-mm` of the months the world's audit rows may sort under: the seed's, the story's and the real ones. */
function auditMonths(templateMonths: readonly string[], now: Date): string[] {
  const real = [-1, 0, 1].map((offset) => new Date(now.getTime() + offset * MONTH_MS).toISOString().slice(0, 7));
  return [...new Set([...templateMonths, "2026-10", "2026-11", ...real])].sort();
}

export function worldPartitions(text: string, markers: WorldMarkers, phoneHash: (phone: string) => string, now: Date): Partition[] {
  const template = fillTemplate(text, markers);
  const clockId = clockIdOfIsp(markers.ispId);
  const seen = new Set<string>();
  const out: Partition[] = [];
  const add = (table: Table, partition: string): void => {
    const id = `${table}\u0000${partition}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ table, partition });
  };
  const templateMonths: string[] = [];
  for (const [table, rows] of Object.entries(template.tables)) {
    for (const row of rows) {
      if (typeof row.PK !== "string") continue;
      if (table === "AuditLog") templateMonths.push(row.PK.slice(-7));
      else add(table as Table, row.PK);
      if (row.entity === "Person" && typeof row.phone === "string") add("People", addressClaimKey(clockId, phoneHash(row.phone)).PK);
      // Every person may have a thread, whether or not the seed gave it messages.
      if (row.entity === "Person" && typeof row.personId === "string") add("Conversations", `PERSON#${row.personId}`);
      if (row.entity === "Person" && row.role === "INSTALLER" && typeof row.personId === "string") add("Runtime", installerStateKey(row.personId).PK);
    }
  }
  for (const month of auditMonths(templateMonths, now)) add("AuditLog", auditPartition(markers.ispId, `${month}-01T00:00:00.000Z`));
  add("Conversations", outboxPartition(markers.ispId));
  for (const key of [clockKey(clockId), worldStateKey(clockId)]) add("Runtime", key.PK);
  // The epoch counter (`COUNTER#EPOCH#<clockId>`) is never deleted (docs/architecture.md §5).
  add("Runtime", pendingPartition(clockId));
  return out;
}
