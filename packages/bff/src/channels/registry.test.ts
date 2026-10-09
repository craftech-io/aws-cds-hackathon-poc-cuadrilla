import { describe, expect, it } from "vitest";
import { ChannelError, type SendChannel, type WhatsAppTransport } from "@cuadrilla/shared";
import type { ChannelTransport } from "./adapter";
import { type WhatsAppRecipient, acceptsInbound, createChannelRegistry, isSyntheticPhone, whatsAppRouteOf, windowClockOf } from "./registry";

type Stub = ChannelTransport<string, string> & { readonly id: string };

function stub(channel: SendChannel, transport: WhatsAppTransport, id: string): Stub {
  return { channel, transport, id, send: async (request) => `${id}:${request}` };
}

function setup(transports: WhatsAppTransport[]) {
  const built: string[] = [];
  const factory = (channel: SendChannel, transport: WhatsAppTransport, id: string) => () => {
    built.push(id);
    return stub(channel, transport, id);
  };
  const registry = createChannelRegistry({
    modes: { email: "live", whatsapp: { transports } },
    factories: { whatsapp: { simulated: factory("WHATSAPP", "simulated", "wa-sim"), live: factory("WHATSAPP", "live", "wa-live") }, email: factory("EMAIL", "live", "ses") },
  });
  return { registry, built };
}

// Synthetic block of docs/seed-spec.md §2, and a number outside it standing for a real phone: a
// North American 555-01xx number, a range reserved for fiction, so no fixture names a real line.
const SYNTHETIC = "+525501010001";
const GUEST_BLOCK = "+525502070001";
const REAL = "+12025550143";
const REGISTERED = new Set([REAL]);
const recipient = (overrides: Partial<WhatsAppRecipient>): WhatsAppRecipient => ({ clockId: "GLOBAL#isp-demo", phone: SYNTHETIC, worldMode: "simulated", registeredRealPhones: REGISTERED, ...overrides });

describe("whatsAppRouteOf", () => {
  it("sends every synthetic identity through the simulated transport, also in the live world", () => {
    expect(isSyntheticPhone(SYNTHETIC)).toBe(true);
    expect(isSyntheticPhone(GUEST_BLOCK)).toBe(true);
    expect(isSyntheticPhone(REAL)).toBe(false);
    expect(whatsAppRouteOf(recipient({ worldMode: "live" }))).toEqual({ transport: "simulated", source: "SYNTHETIC_PHONE" });
    expect(whatsAppRouteOf(recipient({ clockId: "GUEST#isp-guest-07", phone: GUEST_BLOCK }))).toEqual({ transport: "simulated", source: "SYNTHETIC_PHONE" });
  });

  it("sends a real phone the operator registered for the live world live, and measures its window in real time", () => {
    const route = whatsAppRouteOf(recipient({ phone: REAL, worldMode: "live" }));
    expect(route).toEqual({ transport: "live", source: "LIVE_WORLD" });
    expect(windowClockOf(route)).toBe("REAL");
  });

  it("keeps any number the operator did not register simulated, also in the live world", () => {
    expect(whatsAppRouteOf(recipient({ phone: REAL, worldMode: "live", registeredRealPhones: new Set() }))).toEqual({ transport: "simulated", source: "UNREGISTERED_PHONE" });
  });

  it("sends a phone bound by a join code live in its guest world, only in that world", () => {
    const guest = { clockId: "GUEST#isp-guest-07", phone: REAL, worldMode: "simulated" as const, registeredRealPhones: new Set<string>() };
    expect(whatsAppRouteOf({ ...guest, lease: { clockId: "GUEST#isp-guest-07" } })).toEqual({ transport: "live", source: "PHONE_LEASE" });
    expect(whatsAppRouteOf({ ...guest, lease: { clockId: "GUEST#isp-guest-03" } })).toEqual({ transport: "simulated", source: "SIMULATED_WORLD" });
    expect(whatsAppRouteOf({ ...guest, phone: GUEST_BLOCK, lease: { clockId: "GUEST#isp-guest-07" } })).toEqual({ transport: "live", source: "PHONE_LEASE" });
  });

  it("never reaches a real phone live from a simulated world without a lease", () => {
    const route = whatsAppRouteOf(recipient({ phone: REAL }));
    expect(route).toEqual({ transport: "simulated", source: "SIMULATED_WORLD" });
    expect(windowClockOf(route)).toBe("WORLD");
  });
});

describe("createChannelRegistry", () => {
  it("builds each transport once, and email always through the single SES client", async () => {
    const { registry, built } = setup(["simulated"]);
    const route = whatsAppRouteOf(recipient({}));
    expect(registry.whatsapp(route)).toBe(registry.whatsapp(route));
    expect(await registry.email().send("acta")).toBe("ses:acta");
    expect(registry.email()).toBe(registry.email());
    expect(built).toEqual(["wa-sim", "ses"]);
  });

  it("refuses a live send while the stage has no live transport and never builds it (P-01 open)", () => {
    const { registry, built } = setup(["simulated"]);
    const live = whatsAppRouteOf(recipient({ phone: REAL, worldMode: "live" }));
    expect(() => registry.whatsapp(live)).toThrow(ChannelError);
    expect(() => registry.whatsapp(live)).toThrow(/no live WhatsApp transport/);
    expect(built).toEqual([]);
  });

  it("keeps the simulator for synthetic identities once the stage also has the live transport", () => {
    const { registry, built } = setup(["simulated", "live"]);
    expect(registry.whatsappTransports).toEqual(["simulated", "live"]);
    expect(registry.whatsapp({ transport: "live", source: "LIVE_WORLD" }).id).toBe("wa-live");
    expect(registry.whatsapp(whatsAppRouteOf(recipient({ worldMode: "live" }))).id).toBe("wa-sim");
    expect(built).toEqual(["wa-live", "wa-sim"]);
  });

  it("refuses a factory that builds a transport of another channel or mode", () => {
    const registry = createChannelRegistry({
      modes: { email: "live", whatsapp: { transports: ["simulated"] } },
      factories: { whatsapp: { simulated: () => stub("WHATSAPP", "live", "wrong") }, email: () => stub("WHATSAPP", "live", "wrong") },
    });
    expect(() => registry.whatsapp({ transport: "simulated", source: "SYNTHETIC_PHONE" })).toThrow(/built a live/);
    expect(() => registry.email()).toThrow(ChannelError);
  });

  it("answers UNAVAILABLE for a transport the stage lists but the code does not implement yet", () => {
    const registry = createChannelRegistry({ modes: { email: "live", whatsapp: { transports: ["simulated", "live"] } }, factories: { whatsapp: {}, email: () => stub("EMAIL", "live", "ses") } });
    expect(() => registry.whatsapp({ transport: "live", source: "PHONE_LEASE" })).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
});

describe("acceptsInbound", () => {
  it("accepts a simulator envelope only for a simulated world, never for the live world", () => {
    expect(acceptsInbound("simulated", { stageTransports: ["simulated"], worldMode: "simulated" })).toBe(true);
    expect(acceptsInbound("simulated", { stageTransports: ["simulated", "live"], worldMode: "simulated" })).toBe(true);
    expect(acceptsInbound("simulated", { stageTransports: ["simulated", "live"], worldMode: "live" })).toBe(false);
  });

  it("accepts a live event only when the stage has the live transport", () => {
    expect(acceptsInbound("live", { stageTransports: ["simulated"], worldMode: "live" })).toBe(false);
    expect(acceptsInbound("live", { stageTransports: ["simulated", "live"], worldMode: "live" })).toBe(true);
  });
});
