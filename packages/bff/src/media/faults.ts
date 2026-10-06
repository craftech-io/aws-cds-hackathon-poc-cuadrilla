// Injected Transcribe failures (`transcribe.setFaults`, docs/tool-catalog.md; FL-099 c, SC-14/3): the
// `QaDriver` writes a `transcribe` attribute on `Runtime/FAULTS#<clockId>` / `META`, the item the
// orchestrator's faults already use (network/faults.ts). Only `qa-*` clocks are ever read, so a demo,
// guest or evaluation world never pays the read nor can be faulted. A faulted world never reaches the
// real service: the port below answers in its place.
//
//   ERROR    StartTranscriptionJob fails            → "no pude procesar el audio"
//   FAILED   the job ends in FAILED                 → the same notice
//   TIMEOUT  the job never leaves IN_PROGRESS       → the same notice once the poll gives up
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { dynamoDocumentClient } from "../lib/clients";
import { tableName } from "../lib/resource";
import { type FaultsGetter, faultsKey, mayHaveFaults } from "../network/faults";
import { TranscribeError, type TranscribePort } from "./transcribe-client";

export const TranscribeFault = z.enum(["ERROR", "FAILED", "TIMEOUT"]);
export type TranscribeFault = z.infer<typeof TranscribeFault>;

/** The `transcribe` attribute of the faults item; other clients' attributes pass through untouched. */
export const TranscribeFaultsItem = z.looseObject({ transcribe: TranscribeFault.optional() });

export interface TranscribeFaultReader {
  /** The fault of a world; always `undefined` outside `qa-*` clocks, without reading anything. */
  transcribeFault(clockId: string): Promise<TranscribeFault | undefined>;
}

export function runtimeTranscribeFaultReader(client: FaultsGetter = dynamoDocumentClient(), table: () => string = () => tableName("Runtime")): TranscribeFaultReader {
  return {
    async transcribeFault(clockId) {
      if (!mayHaveFaults(clockId)) return undefined;
      const out = await client.send(new GetCommand({ TableName: table(), Key: faultsKey(clockId) }));
      if (out.Item === undefined) return undefined;
      return TranscribeFaultsItem.parse(out.Item).transcribe;
    },
  };
}

/** A port that plays the fault instead of calling Transcribe. */
export function faultyTranscribe(fault: TranscribeFault): TranscribePort {
  return {
    async start() {
      if (fault === "ERROR") throw new TranscribeError("FAULT", "StartTranscriptionJob failed: injected fault");
      return "STARTED";
    },
    async get() {
      return fault === "FAILED" ? { status: "FAILED", failureReason: "injected fault" } : { status: "IN_PROGRESS" };
    },
    async delete() {},
  };
}
