// What only the mock understands (docs/architecture-integrations.md §6): world events that drive an
// ONU's behaviour and the headers that tie a simulated call to its world. None of this is in
// `openapi.yaml`, a real orchestrator would not have it, and `npm run network:contract` fails if
// any of it leaks there. The BFF client sends it and the mock validates it with these schemas.
import { z } from "zod";
import { OnuSerialParam, OnuStatus } from "./schemas";

/**
 * How an ONU of a world answers (docs/architecture-integrations.md §6). Transitions come from world
 * events, never from how many times someone read it.
 */
export const OnuBehaviour = z.enum(["ONLINE_OK", "LOS_THEN_ONLINE", "LOW_POWER", "LOW_POWER_THEN_OK", "NOT_PROVISIONED", "DYING_GASP", "UNKNOWN"]);
export type OnuBehaviour = z.infer<typeof OnuBehaviour>;

/** `POST /v1/onus/{serial}/physical-action`: the installer acted, or the supervisor's fix was carried out. */
export const PhysicalActionKind = z.enum(["INSTALLER_STEP", "SUPERVISOR_FIX"]);
export type PhysicalActionKind = z.infer<typeof PhysicalActionKind>;

/** What left an ONU in its resolved state: a physical action or the demo control. */
export const FixSource = z.enum([...PhysicalActionKind.options, "DEMO_CONTROL"]);
export type FixSource = z.infer<typeof FixSource>;

/**
 * Who read (`X-Caller`): the principal kinds of docs/tool-catalog.md. The mock counts reads per
 * reader (`queryCount`) as a metric only; a read never changes an ONU.
 */
export const NetworkReader = z.enum(["HARNESS", "WORKER", "CHANNEL", "CONSOLE", "QA", "SCHEDULER"]);
export type NetworkReader = z.infer<typeof NetworkReader>;

/**
 * Faults of a world (`Runtime/FAULTS#<clockId>`, written by the `QaDriver`). The client reads them only
 * for `qa-*` clocks and asks the mock for them with `X-Fault`, like a fault-injection header of a
 * service proxy; the mock honours the header only in `qa-*` worlds.
 */
export const NetworkFault = z.enum(["ERROR_503", "TIMEOUT", "LATENCY"]);
export type NetworkFault = z.infer<typeof NetworkFault>;

/** Simulated time of the world at the call (ISO 8601 with offset): the mock's clock is the world's. */
export const WorldTime = z.iso.datetime({ offset: true });

export const MOCK_HEADERS = {
  caller: "X-Caller",
  worldTime: "X-World-Time",
  fault: "X-Fault",
  /** The caller's correlation id, so the mock's log line joins the tool's (docs/architecture.md §12). */
  correlation: "X-Correlation-Id",
} as const;

export const PhysicalActionRequest = z.object({ kind: PhysicalActionKind }).strict();
export type PhysicalActionRequest = z.infer<typeof PhysicalActionRequest>;

/**
 * `POST /v1/onus/{serial}/behaviour` (demo control of the console and `network.setBehaviour` of the
 * `QaDriver`). Setting a behaviour restarts it from its first state unless `fixed` says otherwise;
 * `fixed: true` alone moves the ONU to its resolved state, as the demo control of the doc allows.
 */
export const BehaviourRequest = z
  .object({
    behaviour: OnuBehaviour.optional(),
    fixed: z.boolean().optional(),
    rxPowerDbm: z.number().min(-50).max(10).optional(),
  })
  .strict()
  .refine((request) => request.behaviour !== undefined || request.fixed !== undefined || request.rxPowerDbm !== undefined, "nothing to change");
export type BehaviourRequest = z.infer<typeof BehaviourRequest>;

/** Answer of both control routes: the ONU's behaviour and state after the event, and its status. */
export const OnuControlState = z.object({
  serial: OnuSerialParam,
  behaviour: OnuBehaviour,
  fixed: z.boolean(),
  fixedBy: FixSource.optional(),
  fixedAtSim: WorldTime.optional(),
  /** False when the event did not apply (already fixed, or not the event this behaviour waits for). */
  changed: z.boolean(),
  /** Absent for `UNKNOWN`, which the contract answers with 404. */
  status: OnuStatus.optional(),
});
export type OnuControlState = z.infer<typeof OnuControlState>;

export interface ControlRoute {
  readonly method: "POST";
  readonly suffix: string;
  /** Principal kinds allowed to send this event (docs/tool-catalog.md); a guard, not authentication. */
  readonly callers: readonly NetworkReader[];
}

export const CONTROL_ROUTES = {
  physicalAction: { method: "POST", suffix: "/physical-action", callers: ["WORKER", "CONSOLE", "QA"] },
  behaviour: { method: "POST", suffix: "/behaviour", callers: ["CONSOLE", "QA"] },
} as const satisfies Readonly<Record<string, ControlRoute>>;

export type ControlRouteName = keyof typeof CONTROL_ROUTES;
