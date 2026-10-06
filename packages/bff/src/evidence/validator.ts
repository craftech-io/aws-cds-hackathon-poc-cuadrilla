// The photo validator (docs/design-brief.md §5.10, docs/architecture.md §9.6, ADR-0015): one photo,
// one item, one order. The image goes to the isolated model call with the item's rubric and nothing
// of the order; the model's `record_verdict` is validated by zod and then the deterministic checks
// compare it with the order (checks.ts), reading the orchestrator only when a meter photo reaches the
// cross-check. The image never leaves this module for anything but that call, and what the model
// writes reaches the rest of the system only as the fields of the verdict, re-checked by code: an
// instruction written on a label can move those fields, never a tool or the Harness (FL-097).
import type { NetworkReader, OnuStatus } from "@cuadrilla/network-contract";
import type { PhotoItem } from "@cuadrilla/shared";
import type { IspsPort, ReferencePort } from "../connector/ports";
import type { Logger } from "../lib/log";
import type { NetworkClient, NetworkOutcome } from "../network/client";
import type { WorkOrder } from "../domain/work-orders";
import { type NetworkReading, type VerdictDecision, acceptanceRangeFor, decideVerdict, needsNetworkReading } from "./checks";
import { RUBRIC_VERSION } from "./converse-request";
import type { PhotoModelPort, PhotoModelResult } from "./ports";

export interface ValidatorDeps {
  readonly photoModel: PhotoModelPort;
  readonly reference: Pick<ReferencePort, "getRubric">;
  readonly isps: Pick<IspsPort, "listZones">;
  readonly network: Pick<NetworkClient, "getOnuStatus">;
  readonly logger: Logger;
}

export interface ValidationRequest {
  readonly item: PhotoItem;
  readonly order: Pick<WorkOrder, "workOrderId" | "ispId" | "clockId" | "zoneId" | "opticalClass" | "onuSerial">;
  /** The evidence copy: JPEG without metadata. */
  readonly jpeg: Uint8Array;
  /** Who reads the orchestrator for the cross-check (the principal of the tool call). */
  readonly reader: NetworkReader;
  readonly atSim: string;
}

export type ModelSummary = Omit<Extract<PhotoModelResult, { kind: "READ" }>, "kind" | "record"> & {
  readonly modelVerdict?: "PASS" | "REJECT";
  readonly confidence?: number;
};

export type ValidatorOutcome =
  | { readonly kind: "DECIDED"; readonly decision: VerdictDecision; readonly model: ModelSummary; readonly rubricVersion: string }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string };

function networkReading(outcome: NetworkOutcome<OnuStatus>): NetworkReading {
  if (outcome.kind !== "OK") return { kind: "UNAVAILABLE" };
  return outcome.value.rxPowerDbm === undefined ? { kind: "OK" } : { kind: "OK", rxPowerDbm: outcome.value.rxPowerDbm };
}

/** Validates one photo; UNAVAILABLE only when the rubric is missing or the model could not answer. */
export async function validatePhoto(request: ValidationRequest, deps: ValidatorDeps): Promise<ValidatorOutcome> {
  const { item, order } = request;
  const rubric = await deps.reference.getRubric(RUBRIC_VERSION, item);
  if (rubric === undefined) {
    deps.logger.error("evidence.rubric.missing", { rubricVersion: RUBRIC_VERSION, item });
    return { kind: "UNAVAILABLE", reason: "RUBRIC_MISSING" };
  }
  const reading = await deps.photoModel.read({ clockId: order.clockId, item, rubric, jpeg: request.jpeg, logger: deps.logger });
  if (reading.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE", reason: reading.reason };
  const { kind: _read, record, ...summary } = reading;
  if (reading.problem !== undefined) deps.logger.warn("evidence.model.no_verdict", { problem: reading.problem, stopReason: reading.stopReason });

  const range = acceptanceRangeFor(order, await deps.isps.listZones(order.ispId));
  const network = needsNetworkReading(item, record)
    ? networkReading(await deps.network.getOnuStatus({ clockId: order.clockId, serial: order.onuSerial, caller: request.reader, atSim: request.atSim, logger: deps.logger }))
    : undefined;
  const decision = decideVerdict({ item, record, order, range, ...(network === undefined ? {} : { network }) });
  return {
    kind: "DECIDED",
    decision,
    rubricVersion: rubric.rubricVersion,
    model: { ...summary, ...(record === undefined ? {} : { modelVerdict: record.modelVerdict, confidence: record.confidence }) },
  };
}
