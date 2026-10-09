// `memory.inspect` (docs/tool-catalog.md; FL-027, FL-078, FL-086): what AgentCore Memory keeps of an
// installer's actor (`<installerId>-e<worldEpoch>`, turns/identity.ts): the events of its sessions and the
// records of its three namespaces, each by `{memoryRecordId, createdAt, contentSha256}`. The content never
// leaves the driver: each record and event says only what the scenario asserts on (a sentinel's keywords,
// a masked kind such as CURP or a card, the name or phone of a customer of the installer's orders).
//
// `waitForExtraction` waits for the asynchronous strategies: `installerTips` until a new or changed record
// matches the sentinel; preferences and the summary until a new record appears or the namespace stays quiet
// (`stableSec` without changes, at least `minQuietSec` after the start). Past `timeoutSec` it fails with
// `EXTRACTION_INCOMPLETE` and names the strategy, never a silent pass.
import { createHash } from "node:crypto";
import { ToolError } from "@cuadrilla/shared";
import { normalizeFacts as normalize } from "../outbound/verify/normalize";
import { type MaskKind, maskSensitive } from "../lib/mask";
import { actorIdOf } from "../turns/identity";
import { QA_REASON } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import type { MemoryReader } from "./ports";

export interface InspectedRecord {
  readonly memoryRecordId: string;
  readonly namespace: string;
  readonly strategy: "TIPS" | "PREFERENCES" | "SUMMARY" | "OTHER";
  readonly createdAt: string;
  readonly contentSha256: string;
  readonly sentinelHit: boolean;
  readonly sensitive: readonly MaskKind[];
  readonly customerHits: number;
}

export interface MemoryInspection {
  readonly actorId: string;
  readonly sessions: number;
  readonly events: number;
  readonly eventSensitive: readonly MaskKind[];
  readonly eventCustomerHits: number;
  readonly records: readonly InspectedRecord[];
  readonly waited?: { readonly ms: number; readonly complete: readonly string[] };
}

export interface InspectDeps {
  readonly reader: MemoryReader;
  /** Real time. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface InspectTarget {
  readonly installerId: string;
  readonly worldEpoch: number;
  /** Names and phones of the customers of the installer's orders (never returned). */
  readonly customerTerms: readonly string[];
}

function strategyOf(namespace: string): InspectedRecord["strategy"] {
  if (namespace.includes("/tips")) return "TIPS";
  if (namespace.includes("/preferences")) return "PREFERENCES";
  if (namespace.includes("/summary")) return "SUMMARY";
  return "OTHER";
}

function hitsOf(text: string, terms: readonly string[]): number {
  const haystack = normalize(text);
  return terms.filter((term) => term.trim().length >= 3 && haystack.includes(normalize(term))).length;
}

function sensitiveOf(text: string): MaskKind[] {
  return [...maskSensitive(text).kinds];
}

export async function inspectMemory(deps: InspectDeps, target: InspectTarget, sentinel: readonly string[] = []): Promise<MemoryInspection> {
  const actorId = actorIdOf(target.installerId, target.worldEpoch);
  const keywords = sentinel.map((word) => normalize(word));
  const records = (await deps.reader.listRecords(`/installers/${actorId}/`)).map((record): InspectedRecord => {
    const text = normalize(record.text);
    return {
      memoryRecordId: record.memoryRecordId,
      namespace: record.namespace,
      strategy: strategyOf(record.namespace),
      createdAt: record.createdAt,
      contentSha256: createHash("sha256").update(record.text, "utf8").digest("hex"),
      sentinelHit: keywords.some((word) => text.includes(word)),
      sensitive: sensitiveOf(record.text),
      customerHits: hitsOf(record.text, target.customerTerms),
    };
  });
  const sessions = await deps.reader.listSessions(actorId);
  let events = 0;
  const eventSensitive = new Set<MaskKind>();
  let eventCustomerHits = 0;
  for (const sessionId of sessions) {
    for (const event of await deps.reader.listEvents(actorId, sessionId)) {
      events += 1;
      for (const text of event.texts) {
        for (const kind of sensitiveOf(text)) eventSensitive.add(kind);
        eventCustomerHits += hitsOf(text, target.customerTerms);
      }
    }
  }
  return { actorId, sessions: sessions.length, events, eventSensitive: [...eventSensitive], eventCustomerHits, records };
}

type WaitOptions = NonNullable<QaParsedInput<"memory.inspect">["waitForExtraction"]>;

const signature = (records: readonly InspectedRecord[], strategy: InspectedRecord["strategy"]): string =>
  records
    .filter((record) => record.strategy === strategy)
    .map((record) => `${record.memoryRecordId}:${record.contentSha256}`)
    .sort()
    .join(",");

/** Inspects until the extraction is complete by the rules of the header, or fails past the timeout. */
export async function waitForExtraction(deps: InspectDeps, target: InspectTarget, options: WaitOptions): Promise<MemoryInspection> {
  const started = deps.now().getTime();
  const afterMs = options.afterTs === undefined ? started : Date.parse(options.afterTs);
  const baseline = await inspectMemory(deps, target, options.sentinel?.keywords ?? []);
  const known = new Map(baseline.records.map((record) => [record.memoryRecordId, record.contentSha256]));
  const lastChange: Record<"PREFERENCES" | "SUMMARY", { sig: string; at: number }> = {
    PREFERENCES: { sig: signature(baseline.records, "PREFERENCES"), at: started },
    SUMMARY: { sig: signature(baseline.records, "SUMMARY"), at: started },
  };
  for (;;) {
    const current = await inspectMemory(deps, target, options.sentinel?.keywords ?? []);
    const now = deps.now().getTime();
    const fresh = (record: InspectedRecord) => known.get(record.memoryRecordId) !== record.contentSha256 || Date.parse(record.createdAt) >= afterMs;
    const complete: string[] = [];
    const tips = options.sentinel === undefined || current.records.some((record) => record.strategy === "TIPS" && record.sentinelHit && fresh(record));
    if (tips) complete.push("TIPS");
    for (const strategy of ["PREFERENCES", "SUMMARY"] as const) {
      const sig = signature(current.records, strategy);
      if (sig !== lastChange[strategy].sig) lastChange[strategy] = { sig, at: now };
      const newRecord = current.records.some((record) => record.strategy === strategy && fresh(record));
      const quiet = now - lastChange[strategy].at >= options.stableSec * 1_000 && now - started >= options.minQuietSec * 1_000;
      if (newRecord || quiet) complete.push(strategy);
    }
    if (complete.length === 3) return { ...current, waited: { ms: now - started, complete } };
    if (now - started >= options.timeoutSec * 1_000) {
      const missing = ["TIPS", "PREFERENCES", "SUMMARY"].filter((strategy) => !complete.includes(strategy));
      throw new ToolError("UNAVAILABLE", `extraction incomplete after ${options.timeoutSec} s: ${missing.join(", ")}`, QA_REASON.EXTRACTION_INCOMPLETE);
    }
    await deps.sleep(10_000);
  }
}
