// What a turn needs, what it is asked and what it ends in. The Lambda entry builds the real dependencies
// (worker/production.ts); the tests and the local flows build them over the in-memory connector, a
// scripted Harness, a scripted G1 and fake ports (worker/testing.ts).
import type { TurnTrigger } from "@cuadrilla/shared";
import type { AttachmentLine } from "../agent/envelope";
import type { HarnessClient, HarnessUsage } from "../agent/harness-client";
import type { UntrustedKind } from "../channels/normalizer";
import type { Connector } from "../connector/ports";
import type { Message } from "../domain/conversations";
import type { AgentMode } from "../domain/metrics";
import type { SecretKey } from "../lib/crypto";
import type { WorkerPorts } from "../worker/ports";
import type { TurnBudgetDeps } from "../worker/turn-cap";
import type { G1Prefilter } from "./prefilter";
import type { TurnReads } from "./preload";

export interface TurnDeps {
  readonly data: Connector;
  readonly harness: HarnessClient;
  readonly prefilter: G1Prefilter;
  readonly budget: TurnBudgetDeps;
  readonly ports: Pick<WorkerPorts, "cases" | "notices">;
  /** HKDF `session` subkey (tokens of the turn). */
  readonly sessionKey: () => SecretKey;
  /** HKDF `runtime-session` subkey (`runtimeSessionId`). */
  readonly runtimeSessionKey: () => SecretKey;
  /** `REAL` in the stage, `SCRIPTED` in the local flows (`CuadrillaMetrics.agentMode`). */
  readonly agentMode: AgentMode;
  /** The `orders` and `evidence` targets in process: the reads the worker runs before the Harness. */
  readonly reads?: TurnReads;
  /** Injected for tests: turn delimiters. */
  readonly random?: (size: number) => Uint8Array;
}

/** The untrusted text of a turn, normalized and masked (channels/normalizer.ts). */
export interface TurnInbound {
  readonly text: string;
  readonly kind: UntrustedKind;
  readonly truncated: boolean;
  /** Transcribe's confidence of a voice note. */
  readonly confidence?: number;
  /** Whose words: the installer's go through G1; a supervisor's summary does not. */
  readonly source: "INSTALLER" | "SUPERVISOR";
}

/** What the worker asks a turn for, already resolved from the queue event. */
export interface TurnRequest {
  readonly trigger: TurnTrigger;
  readonly eventId: string;
  readonly clockId: string;
  readonly ispId: string;
  readonly installerId: string;
  /** The order of the turn: the event's, else the installer's active order. */
  readonly workOrderId?: string;
  /** Simulated instant of the event: the "now" of every rule in the turn. */
  readonly eventAtSim: string;
  /** The inbound message the turn answers, when the installer wrote. */
  readonly message?: Message;
  readonly inbound?: TurnInbound;
  readonly attachment?: AttachmentLine;
  /** The same message already got the fixed safety instruction: no second fixed notice (§9.1). */
  readonly safetyFired?: boolean;
  readonly caseId?: string;
}

/** A turn that answers something the installer asked (a message, ÓRDENES): it always gets an answer. */
export function answersInstaller(trigger: TurnTrigger): boolean {
  return trigger === "INSTALLER_MESSAGE" || trigger === "ORDERS_REQUESTED";
}

export type SkipReason = "NO_WORLD" | "PAUSED" | "TURN_CAP" | "ALREADY_RAN";

export type TurnFailureCause = "HARNESS_ERROR" | "TIMEOUT" | "INCOMPLETE" | "MAX_TOKENS";

export type TurnOutcome =
  | { readonly kind: "SKIPPED"; readonly reason: SkipReason }
  | { readonly kind: "BLOCKED"; readonly origin: "PREFILTER" | "HARNESS"; readonly turnId?: string }
  | { readonly kind: "COMPLETED"; readonly turnId: string; readonly usage: HarnessUsage; readonly stopReason: string; readonly toolUses: number; readonly answered: boolean }
  | { readonly kind: "FAILED"; readonly turnId: string; readonly cause: TurnFailureCause };

/** A turn whose Harness was throttled with no time left: the worker puts the event back on the queue. */
export class TurnRequeued extends Error {
  override readonly name = "TurnRequeued";
}
