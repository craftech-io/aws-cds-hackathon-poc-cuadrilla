// What the outbound pipeline needs, as ports: the connector, the WhatsApp transport of each route
// (channels/registry.ts), the single SES client, G2 and G3, the button nonces, the arming of a
// deferred send's timer, the brand of the world, the registered real phones and demo mailboxes of
// `SeedOverrides`, and the real clock. stage.ts builds them for a Lambda from its links (never
// `process.env`); tests and the local flows build them over the in-memory connector and fakes.
import type { WhatsAppRoute } from "../channels/registry";
import type { EmailClient } from "../channels/email/outbound";
import type { NonceDeps } from "../channels/whatsapp/nonces";
import type { WhatsAppChannelTransport } from "../channels/whatsapp/transport";
import type { TimerPort } from "../agent-tools/common/ports";
import type { Connector } from "../connector/ports";
import type { ResolvedBrand } from "../copy/brand";
import type { Clock } from "../lib/clock";
import type { G2Config, OutputGuardrail } from "./grounding";
import type { TemplateGuardrail } from "./g3";

export interface OutboundDeps {
  readonly connector: Connector;
  /** The transport of a WhatsApp route; throws `ChannelError UNAVAILABLE` when the stage lacks it. */
  readonly whatsapp: (route: WhatsAppRoute) => WhatsAppChannelTransport;
  /** The single SES client (channels/email/outbound.ts): the fence and the cap run again inside `send`. */
  readonly email: Pick<EmailClient, "send">;
  readonly g2: OutputGuardrail;
  readonly g2Limits: () => Pick<G2Config, "queryMaxChars" | "groundingSourceMaxChars">;
  readonly g3: TemplateGuardrail;
  /** Runtime, `nonce` subkey and real clock of the button nonces. */
  readonly nonces: NonceDeps;
  /** `TIMER#DEFERRED_SEND` (timers/ implements the port; a paused world needs no schedule). */
  readonly timers: Pick<TimerPort, "arm">;
  /** The visible brand of the stage (`BrandConfig` through `resolveBrand`), for the emails the pipeline renders. */
  readonly brand: () => ResolvedBrand;
  /** Real phones of the live world (`SeedOverrides.personPhones`), normalized E.164. */
  readonly registeredRealPhones: () => ReadonlySet<string>;
  /** `SeedOverrides.demoRecipients.emails` (PII: never logged); the fence admits them only in the demo world. */
  readonly demoRecipients: () => readonly string[];
  /** Real time: `sentAtReal`, the live window, the conversion of a real deferral. */
  readonly realClock: Clock;
  /** A new id (ULID) for messages, mails and timers. */
  readonly newId: () => string;
}
