// `LeadTable` over maps: the adapter of the tests (and of the local flows and the UI server), with the
// same conditional semantics as leads/dynamo-table.ts. Items are validated on the way in, so a test
// can never store a lead the real table would reject.
import { type Lead, LEAD_EVENT_PREFIX, LEAD_LOG_PREFIX, Lead as LeadSchema, type LeadEvent, LeadEvent as LeadEventSchema, type LeadLogEntry, leadPartition } from "./model";
import type { LeadTable } from "./store";

export class MemoryLeadTable implements LeadTable {
  readonly leads = new Map<string, Lead>();
  readonly events = new Map<string, Map<string, LeadEvent>>();
  readonly logs: LeadLogEntry[] = [];

  async getMeta(emailHash: string): Promise<Lead | undefined> {
    const lead = this.leads.get(leadPartition(emailHash));
    return lead === undefined ? undefined : structuredClone(lead);
  }

  async putMeta(lead: Lead, expectedVersion: number | undefined): Promise<boolean> {
    const parsed = LeadSchema.parse(lead);
    const current = this.leads.get(parsed.PK);
    if (expectedVersion === undefined ? current !== undefined : current?.version !== expectedVersion) return false;
    this.leads.set(parsed.PK, structuredClone(parsed));
    return true;
  }

  async deleteMeta(emailHash: string, expectedVersion?: number): Promise<boolean> {
    const pk = leadPartition(emailHash);
    const current = this.leads.get(pk);
    if (current === undefined || (expectedVersion !== undefined && current.version !== expectedVersion)) return false;
    this.leads.delete(pk);
    return true;
  }

  async queryBySubKey(subKey: string): Promise<Lead[]> {
    return [...this.leads.values()].filter((lead) => lead.subKey === subKey).map((lead) => structuredClone(lead));
  }

  async putRecord(item: LeadEvent | LeadLogEntry): Promise<void> {
    if (item.PK.startsWith(LEAD_LOG_PREFIX)) {
      this.logs.push(structuredClone(item as LeadLogEntry));
      return;
    }
    const event = LeadEventSchema.parse(item);
    if (!event.SK.startsWith(LEAD_EVENT_PREFIX)) throw new RangeError("a lead event sorts under EVT#");
    const partition = this.events.get(event.PK) ?? new Map<string, LeadEvent>();
    partition.set(event.SK, structuredClone(event));
    this.events.set(event.PK, partition);
  }

  async listEvents(emailHash: string): Promise<LeadEvent[]> {
    const partition = this.events.get(leadPartition(emailHash));
    return partition === undefined ? [] : [...partition.values()].sort((a, b) => a.SK.localeCompare(b.SK)).map((event) => structuredClone(event));
  }

  async deleteEvents(emailHash: string, sortKeys: readonly string[]): Promise<void> {
    const partition = this.events.get(leadPartition(emailHash));
    if (partition === undefined) return;
    for (const sk of sortKeys) partition.delete(sk);
    if (partition.size === 0) this.events.delete(leadPartition(emailHash));
  }

  async scanMeta(): Promise<Lead[]> {
    return [...this.leads.values()].map((lead) => structuredClone(lead));
  }

  /** Test seam: every stored item, to assert nothing carries an email outside `META`. */
  allItems(): ReadonlyArray<Record<string, unknown>> {
    return [...this.leads.values(), ...[...this.events.values()].flatMap((partition) => [...partition.values()]), ...this.logs];
  }
}
