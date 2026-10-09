// `world.create` of the `QaDriver` for a QA (`qa-<runId>-<scenario>`) or evaluation (`eval-<runId>`)
// world (docs/tool-catalog.md, docs/seed-spec.md §13): its own operator, roster, customers of the
// simulator, `Network` and `Dispatch` rows, numbers and phones by lease, the presets of each operation,
// and its clock PAUSED at `startAtSim` with a fresh epoch. The request and the leases are kept in the
// clock's settings, so "Reiniciar demo" rebuilds the same world (same numbers, phones and presets) at
// its new epoch, and `world.destroy` gives the leases back. A repeated request (a retried step) answers
// the world it already built; another request for the same clock is a CONFLICT.
import { createHash } from "node:crypto";
import { z } from "zod";
import { ClockId, ConnectorError, IsoInstant, ToolError, WORK_ORDER_NUMBER_RANGES, ispIdOfClock, parseClockId } from "@cuadrilla/shared";
import { stableJson, worldDisplayName } from "./brand";
import type { WorldsDeps } from "./deps";
import { presetDepsOf } from "./deps";
import { writeWorldRows } from "./factory";
import { RenderAllocator } from "./photo-catalog";
import { type AppliedPreset, applyOrderPreset } from "./presets";
import { crewsOf, installersOf, qaWorldRows, staffIdOf } from "./qa-rows";
import { QaOperation, loadTemplate } from "./templates";

export const CreateQaWorldRequest = z
  .object({
    clockId: ClockId.refine((clockId) => ["QA", "EVAL"].includes(parseClockId(clockId)?.kind ?? ""), "expected a qa-* or eval-* clock"),
    startAtSim: IsoInstant.optional(),
    /** `qa-min`: the two operations and the metrics fixture of `Seed/worlds/qa-min.json` (`SC-15`, `SC-16`). */
    template: z.literal("qa-min").optional(),
    operations: z.array(QaOperation).min(1).max(120).optional(),
    settings: z
      .object({
        rateLimitPerHour: z.int().min(0).optional(),
        demoMode: z.boolean().optional(),
        templateStatus: z.record(z.string(), z.enum(["APPROVED", "PENDING", "REJECTED"])).optional(),
        turnCaps: z.object({ perHour: z.int().min(0), perDay: z.int().min(0) }).optional(),
        simulatorCaps: z.record(z.string(), z.int().min(0)).optional(),
      })
      .strict()
      .optional(),
    /** Only `qa-*`: test values of the stage's ceiling under keys of the world (never the real ceiling). */
    globalCapsOverride: z.object({ turnsPerDay: z.int().min(0), validationsPerDay: z.int().min(0), transcribeSecondsPerDay: z.int().min(0) }).partial().strict().optional(),
  })
  .strict()
  .refine((request) => (request.template === undefined) !== (request.operations === undefined), "either the qa-min template or operations")
  .refine((request) => request.globalCapsOverride === undefined || parseClockId(request.clockId)?.kind === "QA", "globalCapsOverride only in qa-* worlds");
export type CreateQaWorldRequest = z.infer<typeof CreateQaWorldRequest>;

export interface QaWorldPerson {
  readonly personId: string;
  readonly role: "INSTALLER" | "SUPERVISOR" | "ZONE_CHIEF";
  /** The leased phone of the simulated identity (never a real number). */
  readonly phone?: string;
}

export interface QaWorld {
  readonly clockId: string;
  readonly ispId: string;
  readonly worldEpoch: number;
  readonly startAtSim: string;
  readonly operations: ReadonlyArray<{ readonly key: string; readonly workOrderId: string; readonly installerId: string }>;
  readonly people: readonly QaWorldPerson[];
  readonly presets: readonly AppliedPreset[];
  readonly existing: boolean;
}

const Leases = z.object({ PHONE: z.record(z.string(), z.int()), WONUM: z.record(z.string(), z.int()) });
type Leases = z.infer<typeof Leases>;

/** What the clock keeps of the world: the request (normalized) and its leases. */
const StoredWorld = z.object({ request: z.unknown(), leases: Leases, startAtSim: IsoInstant });

/** QA phones: `+52 55 09xx xxxx` (docs/seed-spec.md §2), lease `n` is the last six digits. */
export const QA_PHONE_BLOCK = { prefix: "+525509", size: 1_000_000 } as const;
const LEASE_TRIES = 500;

function startOf(clockId: string, size: number): number {
  return Number.parseInt(createHash("sha256").update(clockId).digest("hex").slice(0, 8), 16) % size;
}

async function lease(deps: WorldsDeps, kind: "PHONE" | "WONUM", range: { readonly min: number; readonly size: number }, holder: string, taken: Set<number>): Promise<number> {
  const first = startOf(`${holder}#${kind}#${taken.size}`, range.size);
  for (let attempt = 0; attempt < LEASE_TRIES; attempt += 1) {
    const n = range.min + ((first + attempt) % range.size);
    if (taken.has(n)) continue;
    if (await deps.connector.worlds.acquireLease(kind, n, holder)) {
      taken.add(n);
      return n;
    }
  }
  throw new ToolError("CAP_REACHED", `no free ${kind} lease for ${holder}`, "LEASE_EXHAUSTED");
}

/** Leases a number per operation and a phone per installer of its own and per supervisor. */
async function leaseWorld(deps: WorldsDeps, clockId: string, operations: readonly QaOperation[], models: Parameters<typeof crewsOf>[0]["models"]): Promise<Leases> {
  const kind = parseClockId(clockId)?.kind === "EVAL" ? "eval" : "qa";
  const numbers = WORK_ORDER_NUMBER_RANGES[kind];
  const leases: Leases = { PHONE: {}, WONUM: {} };
  const takenNumbers = new Set<number>();
  for (const operation of operations) leases.WONUM[operation.key] = await lease(deps, "WONUM", { min: numbers.min, size: numbers.max - numbers.min + 1 }, clockId, takenNumbers);
  const takenPhones = new Set<number>();
  const phoneOwners = [...new Set(installersOf(clockId, operations).values())];
  for (const crew of crewsOf({ models, operations })) phoneOwners.push(staffIdOf(crew.primary.personId, clockId), staffIdOf(crew.secondary.personId, clockId));
  for (const personId of phoneOwners) leases.PHONE[personId] = await lease(deps, "PHONE", { min: 0, size: QA_PHONE_BLOCK.size }, clockId, takenPhones);
  return leases;
}

function phoneOf(n: number): string {
  return `${QA_PHONE_BLOCK.prefix}${String(n).padStart(6, "0")}`;
}

async function operationsOf(deps: WorldsDeps, request: CreateQaWorldRequest): Promise<QaOperation[]> {
  if (request.operations !== undefined) return request.operations;
  const template = await loadTemplate(deps.templates, "qa-min");
  return template.operations.map((operation) => QaOperation.parse({ key: operation.key, model: operation.model, installer: "own" }));
}

/** Writes the world's rows at `worldEpoch` and applies its presets (a new world, or one being reset). */
export async function writeQaWorld(deps: WorldsDeps, clockId: string, worldEpoch: number): Promise<Omit<QaWorld, "existing">> {
  const clock = await deps.connector.runtime.getClock(clockId);
  const stored = StoredWorld.safeParse(clock?.settings?.world);
  if (clock === undefined || !stored.success) throw new ConnectorError("NOT_FOUND", `${clockId} is not a world built by world.create`, "Runtime");
  const request = CreateQaWorldRequest.parse(stored.data.request);
  const models = await loadTemplate(deps.templates, "models");
  const operations = await operationsOf(deps, request);
  const ispId = ispIdOfClock(clockId);
  const phones = new Map(Object.entries(stored.data.leases.PHONE).map(([personId, n]) => [personId, phoneOf(n)]));
  const numbers = new Map(Object.entries(stored.data.leases.WONUM).map(([key, n]) => [key, String(n)]));
  const kind = parseClockId(clockId)?.kind === "EVAL" ? "EVAL" : "QA";
  const settings = { ...(request.settings ?? {}), ...(request.globalCapsOverride === undefined ? {} : { globalCapsOverride: request.globalCapsOverride }) };
  const rows = qaWorldRows({ clockId, ispId, kind, startAtSim: stored.data.startAtSim, worldEpoch, displayName: worldDisplayName(deps.brand(), clockId), models, operations, numbers, phones, phoneHash: deps.phoneHash, settings, now: deps.now() });
  await writeWorldRows(deps, { domain: rows.domain, mocks: new Map([["Network", rows.mocks.Network], ["Dispatch", rows.mocks.Dispatch]]) });
  if (request.template === "qa-min") await writeQaMinMetrics(deps, clockId, ispId, rows.operations);
  const presets = await applyPresets(deps, operations, rows.operations, stored.data.startAtSim);
  const people: QaWorldPerson[] = [...phones.entries()].map(([personId, phone]) => ({ personId, role: personId.startsWith("inst-") ? "INSTALLER" : "SUPERVISOR", phone }));
  for (const crew of crewsOf({ models, operations })) people.push({ personId: staffIdOf(crew.zoneChief.personId, clockId), role: "ZONE_CHIEF" });
  return { clockId, ispId, worldEpoch, startAtSim: stored.data.startAtSim, operations: rows.operations.map(({ key, workOrderId, installerId }) => ({ key, workOrderId, installerId })), people, presets };
}

async function applyPresets(deps: WorldsDeps, operations: readonly QaOperation[], built: ReadonlyArray<{ key: string; workOrderId: string; installerId: string }>, atSim: string): Promise<AppliedPreset[]> {
  if (operations.every((operation) => operation.preset === undefined)) return [];
  const photos = await deps.photos();
  const allocator = new RenderAllocator(photos);
  const presetDeps = presetDepsOf(deps, photos);
  const applied: AppliedPreset[] = [];
  for (const operation of operations) {
    if (operation.preset === undefined) continue;
    const ids = built.find((entry) => entry.key === operation.key);
    if (ids === undefined) continue;
    const order = await deps.connector.workOrders.requireWorkOrder(ids.workOrderId);
    const installer = await deps.connector.people.requirePerson(ids.installerId);
    applied.push(await applyOrderPreset(presetDeps, allocator, { order, installer, atSim }, operation.preset));
  }
  return applied;
}

const Samples = z.array(z.int().min(0)).default([]);
const QaMinMetric = z.looseObject({
  key: z.string(),
  turns: z.int().min(0).default(0),
  firstReplyLatenciesMs: Samples,
  turnLatenciesMs: Samples,
  inputTokens: z.int().min(0).default(0),
  outputTokens: z.int().min(0).default(0),
  validations: z.int().min(0).default(0),
  transcribeSec: z.number().min(0).default(0),
  emails: z.int().min(0).default(0),
  whatsappMessages: z.int().min(0).default(0),
});

/** The metrics fixture of `qa-min` (`SC-16`): one scripted KPI row per operation. */
async function writeQaMinMetrics(deps: WorldsDeps, clockId: string, ispId: string, built: ReadonlyArray<{ key: string; workOrderId: string }>): Promise<void> {
  const template = await loadTemplate(deps.templates, "qa-min");
  for (const raw of template.metrics) {
    const metric = QaMinMetric.parse(raw);
    const order = built.find((entry) => entry.key === metric.key);
    if (order === undefined) continue;
    await deps.connector.metrics.putKpi({
      ispId,
      clockId,
      workOrderId: order.workOrderId,
      source: "WORLD",
      agentMode: "SCRIPTED",
      turns: metric.turns,
      firstReplyLatenciesMs: metric.firstReplyLatenciesMs,
      turnLatenciesMs: metric.turnLatenciesMs,
      inputTokens: metric.inputTokens,
      outputTokens: metric.outputTokens,
      validations: metric.validations,
      transcribeSec: metric.transcribeSec,
      emails: metric.emails,
      whatsappMessages: metric.whatsappMessages,
      synthetic: true,
    });
  }
}

/** `world.create` of a QA or evaluation world. */
export async function createQaWorld(deps: WorldsDeps, raw: unknown): Promise<QaWorld> {
  const request = CreateQaWorldRequest.parse(raw);
  const { clockId } = request;
  const existing = await deps.connector.runtime.getClock(clockId);
  if (existing !== undefined) {
    const stored = StoredWorld.safeParse(existing.settings?.world);
    if (!stored.success || stableJson(stored.data.request) !== stableJson(request)) throw new ToolError("CONFLICT", `${clockId} already exists with another request`, "WORLD_EXISTS");
    const built = await describeQaWorld(deps, clockId, existing.worldEpoch, stored.data);
    return { ...built, existing: true };
  }
  const models = await loadTemplate(deps.templates, "models");
  const startAtSim = request.startAtSim ?? models.startAtSim;
  const operations = await operationsOf(deps, request);
  const leases = await leaseWorld(deps, clockId, operations, models);
  const worldEpoch = await deps.connector.runtime.nextEpoch(clockId);
  await deps.connector.runtime.createClock({
    clockId,
    ispId: ispIdOfClock(clockId),
    kind: parseClockId(clockId)?.kind === "EVAL" ? "EVAL" : "QA",
    mode: "PAUSED",
    offsetMs: 0,
    pausedSimNow: startAtSim,
    worldEpoch,
    template: request.template ?? "models",
    settings: { startAtSim, world: { request, leases, startAtSim } },
  });
  return { ...(await writeQaWorld(deps, clockId, worldEpoch)), existing: false };
}

async function describeQaWorld(deps: WorldsDeps, clockId: string, worldEpoch: number, stored: z.infer<typeof StoredWorld>): Promise<Omit<QaWorld, "existing">> {
  const request = CreateQaWorldRequest.parse(stored.request);
  const operations = await operationsOf(deps, request);
  const installers = installersOf(clockId, operations);
  const people: QaWorldPerson[] = Object.entries(stored.leases.PHONE).map(([personId, n]) => ({ personId, role: personId.startsWith("inst-") ? "INSTALLER" : "SUPERVISOR", phone: phoneOf(n) }));
  return {
    clockId,
    ispId: ispIdOfClock(clockId),
    worldEpoch,
    startAtSim: stored.startAtSim,
    operations: operations.map((operation) => ({ key: operation.key, workOrderId: `wo-${stored.leases.WONUM[operation.key] ?? ""}`, installerId: installers.get(operation.key) ?? "" })),
    people,
    presets: [],
  };
}

/** The leases a world holds, from its clock (released by `world.destroy`). */
export function leasesOf(settings: Readonly<Record<string, unknown>> | undefined): Leases | undefined {
  const stored = StoredWorld.safeParse(settings?.world);
  return stored.success ? stored.data.leases : undefined;
}
