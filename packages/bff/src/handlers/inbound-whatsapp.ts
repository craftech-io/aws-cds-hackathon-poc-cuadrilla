// Lambda entry of `InboundWhatsApp` (docs/architecture-integrations.md §4, infra/messaging-whatsapp.ts):
// subscribed to the app's own WABA topic (live) and invoked by the phone simulator with the same SNS
// shape and an HMAC-signed envelope (simulated). The order of the work is channels/whatsapp/inbound.ts:
//
//   1-3  origin, number in the envelope, number in every change (phone-filter.ts): a foreign event
//        leaves only `PROBE#foreign#<messageId>` and `ForeignPhoneNumberEvents`, and succeeds
//   4    world and identity; then idempotency by `wamid`, "ALTA <código>", unknown numbers (the
//        stage-wide cap of live replies), opt-in keywords with their fixed replies and no queue,
//        buttons, media, supervisor routing, and `INBOUND_MESSAGE` on the installer's queue followed
//        by the read receipt (which the kill switch `KILL#ALL` holds back)
//
// The adapters of the stage come from channels/whatsapp/defaults.ts (`inboundDeps`); this entry hands
// it the ports of other packages: the installer queue (worker/sink.ts: validated with the worker's
// schema, `inFlight` first, then `SendMessage`), the fixed replies and the window fallback through the
// outbound pipeline (outbound/stage.ts), and the deterministic handlers of "ALTA", "BAJA" and "TURNO"
// with `caller CHANNEL` (services/consent/channel-actions.ts). A foreign or invalid event never throws; when a
// dependency failed on a record that may be ours the entry throws after the whole event, so SNS (or
// the simulator) delivers it again and idempotency by `wamid` keeps what was already done. The result
// lists verdicts and outcomes only: no content, no phone.
import { type InboundPorts, inboundDeps } from "../channels/whatsapp/defaults";
import { type InboundDeps, type RecordOutcome, processInboundEvent } from "../channels/whatsapp/inbound";
import { connectorWorldTime } from "../channels/whatsapp/ports";
import { connector } from "../connector/index";
import { stageQueueSink } from "../feeds/stage";
import { systemClock } from "../lib/clock";
import { type Logger, createLogger, newCorrelationId } from "../lib/log";
import { createWindowFallback } from "../outbound/fallback";
import { stageNotices, stageOutboundDeps } from "../outbound/stage";
import { channelActions } from "../services/consent/channel-actions";

export interface InboundWhatsAppResult {
  readonly records: readonly RecordOutcome[];
}

export type InboundWhatsAppHandler = (event: unknown) => Promise<InboundWhatsAppResult>;

/** Thrown after the whole event was processed when a record that may be ours has to be delivered again. */
export class InboundRetryError extends Error {
  override readonly name = "InboundRetryError";
}

const newLogger = (): Logger => createLogger({ correlationId: newCorrelationId(), bindings: { component: "inbound-whatsapp" } });

export function createInboundWhatsAppHandler(depsFor: (log: Logger) => InboundDeps, newLog: () => Logger = newLogger): InboundWhatsAppHandler {
  return async (event) => {
    const log = newLog();
    const result = await processInboundEvent(event, depsFor(log));
    const verdicts = result.records.map((record) => record.verdict);
    log.info("inbound_whatsapp.done", { records: verdicts.length, accepted: verdicts.filter((verdict) => verdict === "ACCEPT").length, retry: result.retry });
    if (result.retry) throw new InboundRetryError("a record of the event has to be delivered again");
    return { records: result.records };
  };
}

/** The ports of the stage this entry hands to the adapter. */
export function stageInboundPorts(log: Logger): InboundPorts {
  const data = connector();
  return {
    connector: data,
    realClock: systemClock,
    logger: log,
    queue: stageQueueSink(data),
    notices: stageNotices(log).notices,
    fallback: createWindowFallback({ outbound: () => stageOutboundDeps(log), worldTime: connectorWorldTime(data, systemClock), logger: log }),
    actions: channelActions({ connector: data, realClock: systemClock, logger: log }),
  };
}

export const handler: InboundWhatsAppHandler = createInboundWhatsAppHandler((log) => inboundDeps(stageInboundPorts(log)));
