// Enums every edge shares. WP-05 (docs/build-plan.md) adds the domain enums of
// docs/tool-catalog.md "Tipos compartidos" next to these.
import { z } from "zod";

/** Channels the product writes on (docs/architecture-integrations.md): WhatsApp and SES outbound. */
export const SendChannel = z.enum(["EMAIL", "WHATSAPP"]);
export type SendChannel = z.infer<typeof SendChannel>;

/** Transport a WhatsApp message takes (ADR-0002, infra/channel-modes.ts); email is always live. */
export const WhatsAppTransport = z.enum(["live", "simulated"]);
export type WhatsAppTransport = z.infer<typeof WhatsAppTransport>;

/** Key of a channel in `ChannelModes` (infra/channel-modes.ts). */
export const ChannelName = z.enum(["email", "whatsapp"]);
export type ChannelName = z.infer<typeof ChannelName>;

export function channelNameOf(channel: SendChannel): ChannelName {
  return channel === "EMAIL" ? "email" : "whatsapp";
}

/** `code` of every tool failure (docs/tool-catalog.md, Convenciones). */
export const ErrorCode = z.enum([
  "NOT_FOUND",
  "FORBIDDEN",
  "INVALID",
  "CONFLICT",
  "UNAVAILABLE",
  "POLICY_DENIED",
  "DEFERRED",
  "BRIDGE_ACTIVE",
  "TEMPLATE_REQUIRED",
  "RECIPIENT_NOT_ALLOWED",
  "GROUNDING_FAIL",
  "NOT_COMPLETE",
  "ON_HOLD_SAFETY",
  "CAP_REACHED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Console roles, in precedence order (docs/architecture.md §10). */
export const ConsoleRole = z.enum(["SUPERVISOR", "JUDGE", "OPS"]);
export type ConsoleRole = z.infer<typeof ConsoleRole>;

export const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
export type Weekday = z.infer<typeof Weekday>;
