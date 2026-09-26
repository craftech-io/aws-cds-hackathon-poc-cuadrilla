// Behaviours of an ONU (docs/architecture-integrations.md §6), as pure functions of its row. A read
// only resolves the status of the current state; the state changes only through world events: a
// physical action (`INSTALLER_STEP`, `SUPERVISOR_FIX`) or the demo control. The number of reads never
// enters here.
import type { BehaviourRequest, FixSource, OnuBehaviour, OnuStatus, OperState, PhysicalActionKind } from "@cuadrilla/network-contract";
import type { OnuRow } from "./rows";

interface StateSpec {
  readonly operState: OperState;
  /** "none": no light to measure. A number is the power of this state whatever was seeded. */
  readonly rx: "none" | "seeded" | number;
}

interface BehaviourSpec {
  readonly initial: StateSpec;
  /** The physical action that resolves it; absent when nothing an installer does changes it. */
  readonly fixedBy?: PhysicalActionKind;
  readonly resolved?: StateSpec;
  /** Received power of the "seeded" state when the row has none (the values of the demo stories). */
  readonly defaultRxDbm?: number;
}

/** −29.8 dBm: outside B+ (−8 to −25), the reading of the low-power stories. */
export const LOW_POWER_RX_DBM = -29.8;
export const DEFAULT_TX_POWER_DBM = 2.1;

export const BEHAVIOURS: Readonly<Record<Exclude<OnuBehaviour, "UNKNOWN">, BehaviourSpec>> = {
  ONLINE_OK: { initial: { operState: "ONLINE", rx: "seeded" }, defaultRxDbm: -19.8 },
  // The main story: first read LOS, step §DIAG-02, "ya limpié el conector" → ONLINE −21.4.
  LOS_THEN_ONLINE: {
    initial: { operState: "LOS", rx: "none" },
    fixedBy: "INSTALLER_STEP",
    resolved: { operState: "ONLINE", rx: "seeded" },
    defaultRxDbm: -21.4,
  },
  LOW_POWER: { initial: { operState: "ONLINE", rx: "seeded" }, defaultRxDbm: LOW_POWER_RX_DBM },
  // The bridge story: the installer's three attempts do not fix it, the supervisor's instruction does.
  LOW_POWER_THEN_OK: {
    initial: { operState: "ONLINE", rx: LOW_POWER_RX_DBM },
    fixedBy: "SUPERVISOR_FIX",
    resolved: { operState: "ONLINE", rx: "seeded" },
    defaultRxDbm: -22.1,
  },
  NOT_PROVISIONED: { initial: { operState: "NOT_PROVISIONED", rx: "none" } },
  // No power at the ONU (§DIAG-01) until the installer acts; then online at the seeded value.
  DYING_GASP: {
    initial: { operState: "DYING_GASP", rx: "none" },
    fixedBy: "INSTALLER_STEP",
    resolved: { operState: "ONLINE", rx: "seeded" },
    defaultRxDbm: -19.8,
  },
};

function specOf(behaviour: OnuBehaviour): BehaviourSpec | undefined {
  return behaviour === "UNKNOWN" ? undefined : BEHAVIOURS[behaviour];
}

function currentState(row: OnuRow, spec: BehaviourSpec): StateSpec {
  return row.fixed && spec.resolved !== undefined ? spec.resolved : spec.initial;
}

/**
 * What the orchestrator answers for this row at `observedAt` (the world's time). `undefined` for an
 * `UNKNOWN` ONU, which the contract answers with 404.
 */
export function resolveOnuStatus(row: OnuRow, observedAt: string): OnuStatus | undefined {
  const spec = specOf(row.behaviour);
  if (spec === undefined) return undefined;
  const state = currentState(row, spec);
  const online = state.operState === "ONLINE";
  const rxPowerDbm = state.rx === "none" ? undefined : state.rx === "seeded" ? (row.rxPowerDbm ?? spec.defaultRxDbm) : state.rx;
  return {
    serial: row.serial,
    ...(state.operState === "NOT_PROVISIONED" ? {} : { adminState: "ENABLED" as const }),
    operState: state.operState,
    ...(rxPowerDbm === undefined ? {} : { rxPowerDbm }),
    ...(online ? { txPowerDbm: row.txPowerDbm ?? DEFAULT_TX_POWER_DBM } : {}),
    ...(row.oltPort === undefined ? {} : { oltPort: row.oltPort }),
    ...(row.profile === undefined ? {} : { profile: row.profile }),
    ...(online || state.operState === "DYING_GASP" ? { lastSeenAt: observedAt } : {}),
    observedAt,
  };
}

/** Behaviour and physical state of a row after an event; `rxPowerDbm` undefined keeps the stored one. */
export interface OnuStatePatch {
  readonly behaviour: OnuBehaviour;
  readonly rxPowerDbm?: number;
  readonly fixed: boolean;
  readonly fixedBy?: FixSource;
  readonly fixedAtSim?: string;
}

function fixedState(fixed: boolean, by: FixSource, atSim: string): Pick<OnuStatePatch, "fixed" | "fixedBy" | "fixedAtSim"> {
  return fixed ? { fixed, fixedBy: by, fixedAtSim: atSim } : { fixed };
}

/**
 * A physical action resolves the ONU only when it is the action its behaviour waits for and the ONU
 * is not resolved yet; otherwise nothing changes (`undefined`).
 */
export function physicalActionPatch(row: OnuRow, kind: PhysicalActionKind, atSim: string): OnuStatePatch | undefined {
  const spec = specOf(row.behaviour);
  if (spec === undefined || row.fixed || spec.fixedBy !== kind) return undefined;
  return { behaviour: row.behaviour, ...fixedState(true, kind, atSim) };
}

/**
 * The demo control: a behaviour restarts from its first state unless `fixed` is given; `fixed`
 * alone resolves (or un-resolves) the current behaviour; `rxPowerDbm` replaces the seeded power.
 * `undefined` when the row already is what the request asks for.
 */
export function behaviourControlPatch(row: OnuRow, request: BehaviourRequest, atSim: string): OnuStatePatch | undefined {
  const behaviour = request.behaviour ?? row.behaviour;
  const fixed = request.fixed ?? (request.behaviour === undefined ? row.fixed : false);
  const keepFix = fixed && row.fixed && behaviour === row.behaviour;
  const patch: OnuStatePatch = {
    behaviour,
    ...(request.rxPowerDbm === undefined ? {} : { rxPowerDbm: request.rxPowerDbm }),
    ...(keepFix ? { fixed: true, fixedBy: row.fixedBy, fixedAtSim: row.fixedAtSim } : fixedState(fixed, "DEMO_CONTROL", atSim)),
  };
  const unchanged =
    patch.behaviour === row.behaviour &&
    patch.fixed === row.fixed &&
    patch.fixedBy === row.fixedBy &&
    patch.fixedAtSim === row.fixedAtSim &&
    (patch.rxPowerDbm === undefined || patch.rxPowerDbm === row.rxPowerDbm);
  return unchanged ? undefined : patch;
}

/** The row as it is after `patch`, for the answer of a control route. */
export function withPatch(row: OnuRow, patch: OnuStatePatch): OnuRow {
  const { fixedBy: _by, fixedAtSim: _at, ...rest } = row;
  return {
    ...rest,
    behaviour: patch.behaviour,
    rxPowerDbm: patch.rxPowerDbm ?? row.rxPowerDbm,
    fixed: patch.fixed,
    ...(patch.fixedBy === undefined ? {} : { fixedBy: patch.fixedBy }),
    ...(patch.fixedAtSim === undefined ? {} : { fixedAtSim: patch.fixedAtSim }),
  };
}
