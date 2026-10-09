// The minimal world factory of wave 2b (ADR-0025 §2, docs/build-plan.md WP-58): what `GuestWorlds` needs
// to turn a guest's operator into a seeded world, from `Seed/worlds/guest.json`. Wave 4 (WP-39) builds
// the demo, QA and evaluation worlds next to it (worlds/demo.ts, worlds/qa-world.ts), adds presets and
// scene jumps (worlds/presets.ts, worlds/scenes.ts) and renders the historical certificates this one
// leaves `pdfPending` when its caller can write them (`certificates`).
//
//   1. the clock: `PAUSED` at the template's 13/10 07:00 with a fresh epoch, created once; a clock that
//      exists and belongs to another guest is a collision (the generation id was taken)
//   2. the rows of the template for this world (worlds/clone.ts): operator, settings with the caps of
//      its origin, zones, crews, rosters, people of the world's phone block, customers with tagged
//      simulator emails, orders with their checklist, historical cases and messages, `DAY_START` timers
//      as data (no schedule: the clock is paused), `Network` and `Dispatch` rows
//   3. validated and written in bulk; a second build of the same world writes the same rows
//
// Nothing outside the guest's operator is written; the Memory is not touched (no turn, no actor).
import { ConnectorError, type GuestOrigin, clockIdOfIsp } from "@cuadrilla/shared";
import { resolveBrand } from "../copy/brand";
import type { Clock } from "../domain/runtime";
import type { Connector } from "../connector/ports";
import type { TableClient } from "../connector/table-client";
import { type WorldPolicy, defaultWorldPolicy } from "../connector/world";
import { type BrandConfigValue, signupBrandMode } from "../lib/secret-schemas";
import type { HistoricalCertificates } from "./certificates";
import { type WorldRows, cloneWorld, rowCounts } from "./clone";
import { GenerationCollisionError } from "./guest-lifecycle";
import { GUEST_TEMPLATE, fillTemplate, markersFor } from "./template";

export interface FactoryDeps {
  readonly connector: Pick<Connector, "runtime" | "seed">;
  /** Rows of the mocks' tables (`Network`, `Dispatch`). */
  readonly client: TableClient;
  /** The guest template's text, already checked against its digest (worlds/template.ts `readTemplate`). */
  readonly template: () => Promise<string>;
  readonly brand: () => BrandConfigValue;
  readonly phoneHash: (phone: string) => string;
  readonly policy?: WorldPolicy;
  /** Real clock. */
  readonly now: () => Date;
  /** Renders the historical certificates after the build; without it they stay `pdfPending`. */
  readonly certificates?: HistoricalCertificates;
}

export interface BuildRequest {
  readonly ispId: string;
  readonly origin: GuestOrigin;
  /** The sign-up guest a generation belongs to; its clock must be this guest's. */
  readonly ownerUserId?: string | undefined;
}

export interface BuildResult {
  readonly clockId: string;
  readonly worldEpoch: number;
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * The operator's visible name: `resolveBrand`, with the brand of the own sign-up (`signupMode`, neutral by
 * default) for a sign-up generation, so a visitor's console is co-branded only when the CTO says so.
 */
export function displayNameFor(config: BrandConfigValue, origin: GuestOrigin): string {
  if (origin === "SIGNUP" && signupBrandMode(config) === "neutral") return resolveBrand({ mode: "neutral" }).operatorName;
  return resolveBrand(config).operatorName;
}

function ownerOf(clock: Clock): string | undefined {
  const owner = clock.settings?.ownerUserId;
  return typeof owner === "string" ? owner : undefined;
}

async function worldClock(deps: FactoryDeps, request: BuildRequest, clockId: string, startAtSim: string): Promise<Clock> {
  const check = (clock: Clock): Clock => {
    if (ownerOf(clock) !== request.ownerUserId) throw new GenerationCollisionError(`the clock of ${request.ispId} belongs to another guest`);
    return clock;
  };
  const existing = await deps.connector.runtime.getClock(clockId);
  if (existing !== undefined) return check(existing);
  const worldEpoch = await deps.connector.runtime.nextEpoch(clockId);
  try {
    return await deps.connector.runtime.createClock({
      clockId,
      ispId: request.ispId,
      kind: "GUEST",
      mode: "PAUSED",
      offsetMs: 0,
      pausedSimNow: startAtSim,
      worldEpoch,
      template: GUEST_TEMPLATE,
      ...(request.ownerUserId === undefined ? {} : { settings: { ownerUserId: request.ownerUserId } }),
    });
  } catch (error) {
    if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
    const created = await deps.connector.runtime.getClock(clockId);
    if (created === undefined) throw error;
    return check(created);
  }
}

// The operator's rows go last: a world whose `SETTINGS` exist is complete (`worldExists`).
export async function writeWorldRows(deps: Pick<FactoryDeps, "connector" | "client">, rows: Pick<WorldRows, "domain" | "mocks">): Promise<void> {
  for (const [table, items] of rows.mocks) await deps.client.batchPut(table, items);
  for (const [table, items] of rows.domain) if (table !== "Isps") await deps.connector.seed.loadItems(table, items);
  const isps = rows.domain.get("Isps");
  if (isps !== undefined) await deps.connector.seed.loadItems("Isps", isps);
}

/** Builds (or rebuilds, identically) the world of a guest operator. */
export async function buildWorld(deps: FactoryDeps, request: BuildRequest): Promise<BuildResult> {
  const markers = markersFor(request.ispId);
  if (markers.capsProfile !== request.origin) throw new RangeError(`${request.ispId} is not a world of origin ${request.origin}`);
  const template = fillTemplate(await deps.template(), markers);
  const clockId = clockIdOfIsp(request.ispId);
  const clock = await worldClock(deps, request, clockId, template.startAtSim);
  const rows = cloneWorld({
    template,
    markers,
    origin: request.origin,
    worldEpoch: clock.worldEpoch,
    displayName: displayNameFor(deps.brand(), request.origin),
    ownerUserId: request.ownerUserId,
    phoneHash: deps.phoneHash,
    policy: deps.policy ?? defaultWorldPolicy,
    now: deps.now(),
  });
  await writeWorldRows(deps, rows);
  await renderPending(deps, { clockId, ispId: request.ispId });
  return { clockId, worldEpoch: clock.worldEpoch, counts: rowCounts(rows) };
}

/** A certificate that cannot be rendered stays `pdfPending`: the world is built anyway. */
async function renderPending(deps: Pick<FactoryDeps, "certificates">, world: { readonly clockId: string; readonly ispId: string }): Promise<void> {
  if (deps.certificates === undefined) return;
  try {
    await deps.certificates.render(world, "PENDING");
  } catch {
    // The next load (or reset) renders it; the world is complete without its PDFs.
  }
}

/** Whether a guest's world is complete: its clock, and its operator's settings, written last. */
export async function worldExists(deps: Pick<FactoryDeps, "connector">, ispId: string): Promise<boolean> {
  const clock = await deps.connector.runtime.getClock(clockIdOfIsp(ispId));
  if (clock === undefined) return false;
  return (await deps.connector.seed.getItem("Isps", { PK: `ISP#${ispId}`, SK: "SETTINGS" })) !== undefined;
}
