// Who the Harness and Memory think a turn belongs to (docs/architecture.md §9.1 and §9.3), in one place
// for the worker, the Memory purge and the QaDriver's `memory.inspect`:
//
//   actorId           `<installerId>-e<worldEpoch>`: installer ids already start with `inst-`, so the actor
//                     reads `inst-rogelio-e3` (§9.1 writes it `inst-<installer>-e<epoch>`); QA installers
//                     carry the run id, so no two runs share an actor, and a reset (new epoch) starts a new one.
//   runtimeSessionId  keyed digest (`runtime-session` subkey, lib/crypto.ts) of the work order, its world and
//                     both epochs: a G1 block of the Harness or a conversation that concluded not to answer
//                     raises `sessionEpoch` and the next turn starts a clean session. Without an active order,
//                     the installer's session of the simulated day.
//
// Neither carries a phone, an email or a name.
import { InstallerId } from "@cuadrilla/shared";
import { type SecretKey, runtimeSessionId } from "../lib/crypto";

export interface HarnessIdentity {
  readonly actorId: string;
  readonly runtimeSessionId: string;
}

export interface IdentityInput {
  readonly installerId: string;
  readonly clockId: string;
  readonly worldEpoch: number;
  /** The order of the turn and its session epoch, when the turn has one. */
  readonly workOrder?: { readonly workOrderId: string; readonly sessionEpoch: number };
  /** Simulated calendar date of the event (YYYY-MM-DD in the world's zone), for the day session. */
  readonly simDate: string;
}

/** Memory actor of an installer in one epoch of its world. */
export function actorIdOf(installerId: string, worldEpoch: number): string {
  if (!Number.isInteger(worldEpoch) || worldEpoch < 0) throw new RangeError(`invalid world epoch ${worldEpoch}`);
  return `${InstallerId.parse(installerId)}-e${worldEpoch}`;
}

/** Actor and session of a turn; `runtimeSessionKey` is the `runtime-session` subkey. */
export function harnessIdentity(runtimeSessionKey: SecretKey, input: IdentityInput): HarnessIdentity {
  const actorId = actorIdOf(input.installerId, input.worldEpoch);
  const session =
    input.workOrder === undefined
      ? runtimeSessionId(runtimeSessionKey, { kind: "DAY", installerId: input.installerId, simDate: input.simDate, clockId: input.clockId, worldEpoch: input.worldEpoch })
      : runtimeSessionId(runtimeSessionKey, { kind: "WORK_ORDER", workOrderId: input.workOrder.workOrderId, clockId: input.clockId, worldEpoch: input.worldEpoch, sessionEpoch: input.workOrder.sessionEpoch });
  return { actorId, runtimeSessionId: session };
}
