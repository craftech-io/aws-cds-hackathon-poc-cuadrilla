// The pipeline of a Lambda that holds PIPELINE (docs/architecture.md §14: the worker, the channel's
// Lambdas, `ToolMessaging`, `ToolCases`, `ToolEvidence` for its reaction): everything from what SST links
// (`Resource` through lib/resource.ts and lib/secrets.ts, never `process.env`), built once per
// container. The WhatsApp transports come from the stage's registry (the live one only once the stage
// has it, ADR-0002); email from the single SES client; G2 and G3 from their Linkables; the deferred
// sends' timers from timers/ (`TIMERS`). The timer dispatcher is the caller's (the worker passes its
// queue producer); without one, a deferral that is somehow due already waits for the clock's next move.
import { normalizePhone } from "@cuadrilla/shared";
import { type WhatsAppRoute, channelRegistry } from "../channels/registry";
import { emailClient } from "../channels/email/defaults";
import { whatsAppTransportFactories } from "../channels/whatsapp/defaults";
import type { StatusDeps } from "../channels/whatsapp/events";
import { type InstallerNoticeSender, type NoticeSender, connectorWorldTime } from "../channels/whatsapp/ports";
import type { ConversationsPort } from "../connector/ports";
import type { Message } from "../domain/conversations";
import { subkey, brandConfig, seedOverrides } from "../lib/secrets";
import { connector } from "../connector/index";
import { resolveBrand } from "../copy/brand";
import { systemClock } from "../lib/clock";
import { ulid } from "../lib/crypto";
import type { Logger } from "../lib/log";
import type { SeedOverridesValue } from "../lib/secret-schemas";
import type { TimerDispatcher } from "../timers/dispatch";
import { stageTimerService } from "../timers/stage";
import type { OutboundDeps } from "./deps";
import { createWindowFallback } from "./fallback";
import { createInstallerNoticeSender, createNoticeSender } from "./notices";
import { createBedrockG2, guardrailRuntimeClient, linkedG2Config } from "./grounding";
import { createBedrockG3, linkedG3Config } from "./g3";

/** A dispatcher for a Lambda that only arms future timers: anything due is left to the world clock. */
export function deferredDispatcher(logger: Logger): TimerDispatcher {
  return { dispatch: async (due) => logger.warn("outbound.timer_due_not_dispatched", { timerId: due.timer.timerId, clockId: due.timer.clockId }) };
}

/**
 * A value of `SeedOverrides` (PII: never logged). A function without the link, or with an unreadable
 * value, gets the empty value: the live route and the demo mailboxes narrow, they never widen.
 */
function fromOverrides<T>(logger: Logger, read: (overrides: SeedOverridesValue) => T, empty: T, what: string): () => T {
  return () => {
    try {
      return read(seedOverrides());
    } catch (error) {
      logger.warn(`${what} unavailable from SeedOverrides`, { error });
      return empty;
    }
  };
}

let cached: OutboundDeps | undefined;

export interface StageOptions {
  /** The queue producer of `TIMER` events (the worker's); deferrals are armed in the future either way. */
  readonly dispatcher?: TimerDispatcher;
  /** The bridge's pending list for a failed free text that has no template (cases/bridge.ts). */
  readonly hold?: StatusDeps["fallback"]["holdForNextInbound"];
}

/** The pipeline's dependencies in a Lambda, built on first use and kept for the container. */
export function stageOutboundDeps(logger: Logger, options: StageOptions = {}): OutboundDeps {
  if (cached !== undefined) return cached;
  const data = connector();
  const fallback = createWindowFallback({ outbound: () => stageOutboundDeps(logger, options), worldTime: connectorWorldTime(data), logger, ...(options.hold === undefined ? {} : { hold: options.hold }) });
  const registry = channelRegistry({ whatsapp: whatsAppTransportFactories({ fallback, logger, connector: data }), email: () => emailClient(logger) });
  const client = guardrailRuntimeClient();
  cached = {
    connector: data,
    whatsapp: (route) => registry.whatsapp(route),
    email: registry.email(),
    g2: createBedrockG2({ client, config: linkedG2Config }),
    g2Limits: linkedG2Config,
    g3: createBedrockG3({ client, config: linkedG3Config }),
    nonces: { runtime: data.runtime, nonceKey: subkey("nonce"), realClock: systemClock },
    timers: stageTimerService(options.dispatcher ?? deferredDispatcher(logger), logger),
    brand: () => resolveBrand(brandConfig()),
    registeredRealPhones: fromOverrides(logger, (overrides) => new Set(Object.values(overrides.personPhones ?? {}).map((phone) => normalizePhone(phone))) as ReadonlySet<string>, new Set<string>(), "registered real phones"),
    demoRecipients: fromOverrides(logger, (overrides) => overrides.demoRecipients?.emails ?? [], [] as readonly string[], "demo recipients"),
    realClock: systemClock,
    newId: () => ulid(),
  };
  return cached;
}

/**
 * A transport pair that records nothing: the reply to a number outside the allow list has no thread
 * to be filed under (notices.ts). Its statuses find no message and are ignored.
 */
function unthreadedTransports(logger: Logger) {
  const data = connector();
  const conversations: ConversationsPort = {
    ...data.conversations,
    getMessage: async () => undefined,
    // The transport's `recordSent` reads nothing back from it: there is no row to update.
    updateMessage: async () => undefined as unknown as Message,
    findMessageByProviderId: async () => undefined,
  };
  const registry = channelRegistry({
    whatsapp: whatsAppTransportFactories({ fallback: createWindowFallback({ outbound: () => stageOutboundDeps(logger), worldTime: connectorWorldTime(data), logger }), logger, connector: { ...data, conversations } }),
    email: () => emailClient(logger),
  });
  return (route: WhatsAppRoute) => registry.whatsapp(route);
}

/** The fixed notices of `InboundWhatsApp` and of the worker, through the stage's pipeline. */
export function stageNotices(logger: Logger, options: StageOptions = {}): { readonly notices: NoticeSender; readonly installerNotices: InstallerNoticeSender } {
  const deps = { outbound: stageOutboundDeps(logger, options), worldTime: connectorWorldTime(connector()), unthreaded: unthreadedTransports(logger), logger };
  return { notices: createNoticeSender(deps), installerNotices: createInstallerNoticeSender(deps) };
}

/** Test seam. */
export function resetStageOutboundDeps(): void {
  cached = undefined;
}
