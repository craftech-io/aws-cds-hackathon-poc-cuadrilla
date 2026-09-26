// Rows of the `Network` table (docs/architecture.md §5): one `ONU#<clockId>#<serial>` / `META` per ONU
// of a world, with the behaviour the world template seeded and the physical state that world events
// change (`fixed`, `fixedBy`, `fixedAtSim`). The world factory, the seed and the scenario runner
// build rows with `newOnuRow`, so the mock never meets a shape it does not know.
import { z } from "zod";
import { ClockId } from "@cuadrilla/shared";
import { FixSource, NetworkReader, OnuBehaviour, OnuSerialParam, WorldTime } from "@cuadrilla/network-contract";

export const ONU_ENTITY = "Onu";
export const ONU_SORT_KEY = "META";

export interface OnuKey {
  readonly PK: string;
  readonly SK: typeof ONU_SORT_KEY;
}

/** Key of an ONU inside its world: the same serial in two worlds is two ONUs. */
export function onuKey(clockId: string, serial: string): OnuKey {
  return { PK: `ONU#${ClockId.parse(clockId)}#${OnuSerialParam.parse(serial)}`, SK: ONU_SORT_KEY };
}

/**
 * Reads per reader, one top-level counter each so an `ADD` works on rows written before the counter
 * existed. Metrics and tests only: nothing reads them to decide a state.
 */
export const READER_COUNTER = {
  HARNESS: "queryCountHarness",
  WORKER: "queryCountWorker",
  CHANNEL: "queryCountChannel",
  CONSOLE: "queryCountConsole",
  QA: "queryCountQa",
  SCHEDULER: "queryCountScheduler",
} as const satisfies Readonly<Record<NetworkReader, string>>;

const Counter = z.number().int().nonnegative();

export const OnuRow = z
  .object({
    PK: z.string(),
    SK: z.literal(ONU_SORT_KEY),
    entity: z.literal(ONU_ENTITY),
    clockId: ClockId,
    serial: OnuSerialParam,
    behaviour: OnuBehaviour,
    /** Received power once the ONU is in its final state (the seeded value; defaults per behaviour). */
    rxPowerDbm: z.number().optional(),
    txPowerDbm: z.number().optional(),
    oltPort: z.string().optional(),
    profile: z.string().optional(),
    fixed: z.boolean(),
    fixedBy: FixSource.optional(),
    fixedAtSim: WorldTime.optional(),
    /** Every read, whoever the reader. */
    queryCount: Counter,
    queryCountHarness: Counter.optional(),
    queryCountWorker: Counter.optional(),
    queryCountChannel: Counter.optional(),
    queryCountConsole: Counter.optional(),
    queryCountQa: Counter.optional(),
    queryCountScheduler: Counter.optional(),
    /** Reads answered with an injected fault (`qa-*` worlds only). */
    faultCount: Counter.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int().positive(),
    synthetic: z.boolean().optional(),
    world: z.string().optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .superRefine((row, ctx) => {
    if (row.PK !== `ONU#${row.clockId}#${row.serial}`) ctx.addIssue({ code: "custom", path: ["PK"], message: "PK is not ONU#<clockId>#<serial>" });
    if (row.fixed !== (row.fixedBy !== undefined) || row.fixed !== (row.fixedAtSim !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["fixed"], message: "fixedBy and fixedAtSim go with fixed, and only with it" });
    }
  });
export type OnuRow = z.infer<typeof OnuRow>;

export interface NewOnuRow {
  readonly clockId: string;
  readonly serial: string;
  readonly behaviour: OnuBehaviour;
  readonly rxPowerDbm?: number;
  readonly txPowerDbm?: number;
  readonly oltPort?: string;
  readonly profile?: string;
  /** Preset `onu {fixed: true}`: the ONU starts in its resolved state, set by the demo control. */
  readonly fixedAtSim?: string;
  /** Real instant of the write (record metadata, not business time). */
  readonly nowIso: string;
  readonly synthetic?: boolean;
  readonly world?: string;
  readonly expiresAt?: number;
}

export function newOnuRow(input: NewOnuRow): OnuRow {
  const fixed = input.fixedAtSim !== undefined;
  return OnuRow.parse({
    ...onuKey(input.clockId, input.serial),
    entity: ONU_ENTITY,
    clockId: input.clockId,
    serial: input.serial,
    behaviour: input.behaviour,
    rxPowerDbm: input.rxPowerDbm,
    txPowerDbm: input.txPowerDbm,
    oltPort: input.oltPort,
    profile: input.profile,
    fixed,
    fixedBy: fixed ? "DEMO_CONTROL" : undefined,
    fixedAtSim: input.fixedAtSim,
    queryCount: 0,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    version: 1,
    synthetic: input.synthetic,
    world: input.world,
    expiresAt: input.expiresAt,
  });
}

/** Reads of a row per reader, zero for readers that never read it. */
export function readsByReader(row: OnuRow): Record<NetworkReader, number> {
  const out = {} as Record<NetworkReader, number>;
  for (const reader of NetworkReader.options) out[reader] = row[READER_COUNTER[reader]] ?? 0;
  return out;
}
