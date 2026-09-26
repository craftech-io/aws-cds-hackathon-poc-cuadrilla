// What every channel shares (docs/architecture-integrations.md §1-§4, ADR-0002). The outbound
// pipeline and the inbound Lambdas only see these types: no channel SDK leaks past
// `channels/<channel>/`, and nothing outside a transport knows whether it is live or simulated.
//
//   - `ChannelTransport`: a channel's way out through one transport. Email has one (`live`, SES);
//     WhatsApp has the stage's transports (`simulated`, and `live` once P-01 is closed), and
//     channels/registry.ts picks the one each recipient needs;
//   - `ChannelSendResult`: what a send answers, never an exception for an expected denial: the
//     recipient fence, a cap or a provider failure come back as a code of docs/tool-catalog.md, so
//     the pipeline records them and the tools turn them into their `{ok: false}` envelope.
import { type ErrorCode, type SendChannel, type ToolFailure, type WhatsAppTransport, fail } from "@cuadrilla/shared";

/** A channel's way out through one transport (SES, End User Messaging Social, or the simulated WhatsApp). */
export interface ChannelTransport<TRequest, TResult> {
  readonly channel: SendChannel;
  /** `live` reaches a real mailbox or phone; `simulated` persists what it would have sent (WhatsApp only). */
  readonly transport: WhatsAppTransport;
  send(request: TRequest): Promise<TResult>;
}

/** Where an inbound event says it came from: a real provider event, or the phone simulator's signed envelope. */
export type InboundOrigin = WhatsAppTransport;

/** A denied or failed send. `retryable` tells the caller whether trying again later may succeed. */
export interface ChannelSendFailure {
  readonly ok: false;
  readonly code: ErrorCode;
  /** Detail code for logs, audits and the console (`OWN_DOMAIN`, `SIMULATOR`, `TooManyRequestsException`…). */
  readonly reason: string;
  readonly retryable: boolean;
  /** Real instant a cap frees up again, for "cuándo se libera". */
  readonly resetsAtReal?: string;
}

export type ChannelSendResult<T extends object> = ({ readonly ok: true } & T) | ChannelSendFailure;

export function sendFailure(code: ErrorCode, reason: string, options: { readonly retryable?: boolean; readonly resetsAtReal?: string } = {}): ChannelSendFailure {
  return {
    ok: false,
    code,
    reason,
    retryable: options.retryable ?? false,
    ...(options.resetsAtReal === undefined ? {} : { resetsAtReal: options.resetsAtReal }),
  };
}

const FAILURE_MESSAGES: Readonly<Partial<Record<ErrorCode, string>>> = {
  RECIPIENT_NOT_ALLOWED: "the recipient is outside this world's fence",
  CAP_REACHED: "the cap of this period is reached",
  INVALID: "the message is not valid for this channel",
  UNAVAILABLE: "the channel is not available now, try again later",
};

/** The envelope a tool returns for a failed send (docs/tool-catalog.md, Convenciones: tools never throw). */
export function toSendToolFailure(failure: ChannelSendFailure): ToolFailure {
  const message = FAILURE_MESSAGES[failure.code] ?? "the message was not sent";
  return fail(failure.code, failure.resetsAtReal === undefined ? message : `${message} until ${failure.resetsAtReal}`, failure.reason);
}
