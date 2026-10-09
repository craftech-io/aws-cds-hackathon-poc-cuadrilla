// Which transport each send takes and which inbound a world accepts (ADR-0002,
// docs/architecture-integrations.md §4). Three layers, none of them the model's:
//
//   stage      `ChannelModes` (infra/channel-modes.ts): email is always `live` (SES); WhatsApp has
//              `simulated` and, once P-01 is closed, `live`;
//   world      `Isps/SETTINGS.whatsappMode`: `live` only for the single live world;
//   recipient  a real phone of the live world (registered by the operator in `SeedOverrides`, the
//              only way a real phone enters it), or one bound to a guest world by a join code
//              (`PHONELEASE#`), goes out through End User Messaging Social; every synthetic identity
//              (the `+52 55 0xxx xxxx` block of docs/seed-spec.md §2), and any other number, through
//              the simulated transport.
//
// So a guest keeps the phone simulator while the stage has the live channel, and nothing reaches a
// phone live unless it was proved real (registered by the operator, or bound by a code sent from that
// very phone). The transports come from their adapters as factories (channels/email,
// channels/whatsapp): the registry builds each one once, never imports a channel SDK, and refuses a
// live send when the stage has no live transport instead of falling back to another one.
import { ChannelError, type SendChannel, WhatsAppMode, WhatsAppTransport } from "@cuadrilla/shared";
import { type ChannelModes, channelModes as linkedChannelModes } from "../lib/resource";
import type { ChannelTransport, InboundOrigin } from "./adapter";

// ---- Recipients ----------------------------------------------------------------------------------

/**
 * Synthetic phones (docs/seed-spec.md §2): Mexico City numbers whose local part starts with 0, which
 * the numbering plan never assigns to subscribers. Nothing real is ever sent to them.
 */
export const SYNTHETIC_PHONE_PATTERN = /^\+52550\d{7}$/;

export function isSyntheticPhone(e164: string): boolean {
  return SYNTHETIC_PHONE_PATTERN.test(e164);
}

/** Why a recipient gets its transport; the audit records it next to the decision. */
export type WhatsAppRouteSource = "SYNTHETIC_PHONE" | "SIMULATED_WORLD" | "UNREGISTERED_PHONE" | "LIVE_WORLD" | "PHONE_LEASE";

export interface WhatsAppRoute {
  readonly transport: WhatsAppTransport;
  readonly source: WhatsAppRouteSource;
}

export interface WhatsAppRecipient {
  /** The world the message belongs to. */
  readonly clockId: string;
  /** Normalized E.164 of the person, read from `People` (never from the model). */
  readonly phone: string;
  /** `Isps/SETTINGS.whatsappMode` of that world. */
  readonly worldMode: WhatsAppMode;
  /** The phone's `PHONELEASE#` while it has not expired (`WorldRuntimePort.getPhoneLease`). */
  readonly lease?: { readonly clockId: string } | undefined;
  /** Real phones the operator registered for the live world (`SeedOverrides.personPhones`), normalized E.164. */
  readonly registeredRealPhones: ReadonlySet<string>;
}

/** The transport a WhatsApp message to this recipient takes (ADR-0002, point 3). */
export function whatsAppRouteOf(recipient: WhatsAppRecipient): WhatsAppRoute {
  const worldMode = WhatsAppMode.parse(recipient.worldMode);
  // A lease of this world binds a phone proved real (the code came from it): it wins over the person's
  // synthetic phone, and the send goes to the bound phone (outbound/context.ts).
  if (recipient.lease !== undefined && recipient.lease.clockId === recipient.clockId) return { transport: "live", source: "PHONE_LEASE" };
  if (isSyntheticPhone(recipient.phone)) return { transport: "simulated", source: "SYNTHETIC_PHONE" };
  // A real phone in a simulated world without a lease of that world: nothing may reach it live.
  if (worldMode !== "live") return { transport: "simulated", source: "SIMULATED_WORLD" };
  // In the live world only the phones the operator registered are real; any other number stays simulated.
  if (recipient.registeredRealPhones.has(recipient.phone)) return { transport: "live", source: "LIVE_WORLD" };
  return { transport: "simulated", source: "UNREGISTERED_PHONE" };
}

/**
 * The clock `CP-WA-24H` measures the window with: real time and `lastInboundAtReal` for every live
 * recipient (Meta measures it that way), the world's clock for synthetic identities.
 */
export function windowClockOf(route: WhatsAppRoute): "REAL" | "WORLD" {
  return route.transport === "live" ? "REAL" : "WORLD";
}

// ---- Inbound -------------------------------------------------------------------------------------

export interface InboundGate {
  /** Transports of the stage (`ChannelModes.whatsapp.transports`). */
  readonly stageTransports: readonly WhatsAppTransport[];
  /** Mode of the world the event names (the simulator's envelope) or resolves to (a live event). */
  readonly worldMode: WhatsAppMode;
}

/**
 * docs/architecture-integrations.md §4.4, step 1: a live event only when the stage has the live
 * transport; a simulator envelope only for a world in `simulated` mode, never for the live world.
 */
export function acceptsInbound(origin: InboundOrigin, gate: InboundGate): boolean {
  if (WhatsAppTransport.parse(origin) === "live") return gate.stageTransports.includes("live");
  return WhatsAppMode.parse(gate.worldMode) === "simulated";
}

// ---- Transports ----------------------------------------------------------------------------------

type AnyTransport = ChannelTransport<never, unknown>;

export interface TransportFactories<W extends AnyTransport, E extends AnyTransport> {
  /** One factory per WhatsApp transport the code implements; `live` exists from WP-23 on. */
  readonly whatsapp: Readonly<Partial<Record<WhatsAppTransport, () => W>>>;
  readonly email: () => E;
}

export interface ChannelRegistry<W extends AnyTransport, E extends AnyTransport> {
  /** Transports of the stage for WhatsApp. */
  readonly whatsappTransports: readonly WhatsAppTransport[];
  /** The transport of a WhatsApp route; UNAVAILABLE when the stage does not have it. */
  whatsapp(route: WhatsAppRoute): W;
  /** The single SES client (email is always live). */
  email(): E;
}

function checked<T extends AnyTransport>(transport: T, channel: SendChannel, expected: WhatsAppTransport): T {
  if (transport.channel !== channel || transport.transport !== expected) {
    throw new ChannelError("INVALID", channel, `the ${expected} ${channel} factory built a ${transport.transport} ${transport.channel} transport`);
  }
  return transport;
}

export function createChannelRegistry<W extends AnyTransport, E extends AnyTransport>(input: { readonly modes: ChannelModes; readonly factories: TransportFactories<W, E> }): ChannelRegistry<W, E> {
  const transports = [...new Set(input.modes.whatsapp.transports.map((transport) => WhatsAppTransport.parse(transport)))];
  const built = new Map<WhatsAppTransport, W>();
  let email: E | undefined;

  return {
    whatsappTransports: transports,
    whatsapp(route) {
      const kind = WhatsAppTransport.parse(route.transport);
      const cached = built.get(kind);
      if (cached !== undefined) return cached;
      // The stage is read before any factory runs: a transport the stage lacks is never built.
      if (!transports.includes(kind)) throw new ChannelError("UNAVAILABLE", "WHATSAPP", `the stage has no ${kind} WhatsApp transport (${route.source})`, { retryable: false });
      const factory = input.factories.whatsapp[kind];
      if (factory === undefined) throw new ChannelError("UNAVAILABLE", "WHATSAPP", `no ${kind} WhatsApp transport is implemented`, { retryable: false });
      const transport = checked(factory(), "WHATSAPP", kind);
      built.set(kind, transport);
      return transport;
    },
    email() {
      email ??= checked(input.factories.email(), "EMAIL", "live");
      return email;
    },
  };
}

/** The registry of a Lambda: the stage's transports from the linked `ChannelModes` (`Resource`, never `process.env`). */
export function channelRegistry<W extends AnyTransport, E extends AnyTransport>(factories: TransportFactories<W, E>): ChannelRegistry<W, E> {
  return createChannelRegistry({ modes: linkedChannelModes(), factories });
}
