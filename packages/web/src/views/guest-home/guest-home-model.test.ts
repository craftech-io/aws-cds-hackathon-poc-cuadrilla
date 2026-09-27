import { describe, expect, it } from "vitest";
import { GuestWorldView } from "@cuadrilla/bff/guest/world-status";
import { guestHomeCopy } from "./copy";
import { GuestWorld, LONG_WAIT_MS, PROVISIONING_POLL_MS, REST_POLL_MS, cardOf, formatDate, formatWorldTime, langOf, pollMs, stagesOf } from "./guest-home-model";

const ROUTES = [{ id: "orders" }, { id: "order-detail", navAs: "orders" }, { id: "cases" }, { id: "simulator" }, { id: "guest-home" }];
const TITLES: Record<string, string> = { orders: "Órdenes del día", cases: "Casos", simulator: "Simulador de teléfono", "guest-home": "Inicio" };

const ready: GuestWorld = {
  status: "READY",
  origin: "SIGNUP",
  canDeleteAccount: true,
  canRetry: false,
  refreshSession: false,
  createdAtReal: "2026-10-01T15:00:00.000Z",
  expiresAtReal: "2026-10-08T15:00:00.000Z",
  summary: { operatorName: "Operadora de prueba", installers: ["Rogelio Méndez"], supervisors: 4, workOrders: 13, simNow: "2026-10-13T07:00:00-06:00" },
};

describe("[FL-107] the guest's portada", () => {
  it("[FL-107] the parts of the console split by whether their view exists; the portada and the order detail are not parts", () => {
    const stages = stagesOf(ROUTES, ["guest-home", "cases"], (id) => TITLES[id] ?? id, "guest-home");
    expect(stages.available).toEqual([{ id: "cases", title: "Casos" }]);
    expect(stages.pending).toEqual([
      { id: "orders", title: "Órdenes del día" },
      { id: "simulator", title: "Simulador de teléfono" },
    ]);
    expect(stagesOf(ROUTES, [], (id) => id, "guest-home").available).toEqual([]);
  });

  it("[FL-107] each of the five states has its card; only a failure or a full cap offers the retry, a full cap and the person limit the talk", () => {
    const es = guestHomeCopy.es;
    expect(cardOf({ ...ready, status: "PROVISIONING", canRetry: false }, es)).toEqual({ title: es.provisioning.title, lead: es.provisioning.lead, retry: false, talk: null });
    expect(cardOf({ ...ready, status: "PROVISIONING", canRetry: true }, es).retry).toBe(true);
    expect(cardOf(ready, es)).toEqual({ title: es.ready.title, lead: "", retry: false, talk: null });
    expect(cardOf({ ...ready, status: "FAILED" }, es)).toMatchObject({ title: "No pudimos preparar tu mundo.", retry: true, talk: null });
    expect(cardOf({ ...ready, status: "CAP_FULL" }, guestHomeCopy.en)).toMatchObject({ title: "We've hit the limit of test worlds available right now.", retry: true, talk: guestHomeCopy.en.capFull.talk });
    // A third account of the same person (ADR-0025 §3): the talk, never a retry that could bring a world.
    expect(cardOf({ ...ready, status: "PERSON_LIMIT", canRetry: false }, es)).toEqual({ title: es.personLimit.title, lead: es.personLimit.lead, retry: false, talk: es.personLimit.talk });
  });

  it("[FL-107] polls every 2 s while the world is being built, and rarely at rest", () => {
    expect(pollMs(undefined)).toBe(PROVISIONING_POLL_MS);
    expect(pollMs({ ...ready, status: "PROVISIONING" })).toBe(PROVISIONING_POLL_MS);
    expect(pollMs(ready)).toBe(REST_POLL_MS);
    expect(LONG_WAIT_MS).toBe(8_000);
  });

  it("speaks Spanish unless the link or the page is in English", () => {
    expect(langOf(new URLSearchParams("lang=en"), "es-MX")).toBe("en");
    expect(langOf(new URLSearchParams("lang=es-MX"), "en")).toBe("es");
    expect(langOf(new URLSearchParams(""), "en")).toBe("en");
    expect(langOf(new URLSearchParams(""), "es-MX")).toBe("es");
  });

  it("writes dates and the simulated time the way a person reads them", () => {
    const date = new Date(2026, 9, 8, 12);
    expect(formatDate(date.toISOString(), guestHomeCopy.es)).toBe("8 de octubre de 2026");
    expect(formatDate(date.toISOString(), guestHomeCopy.en)).toBe("October 8, 2026");
    expect(formatWorldTime("2026-10-13T07:00:00-06:00", guestHomeCopy.es.weekdays)).toBe("mar 13/10 07:00");
    expect(formatWorldTime("2026-10-13T07:00:00-06:00", guestHomeCopy.en.weekdays)).toBe("Tue 13/10 07:00");
  });

  it("the contract matches the BFF's view: every answer of guest.world parses here", () => {
    expect(Object.keys(GuestWorld.shape).sort()).toEqual(Object.keys(GuestWorldView.shape).sort());
    for (const status of ["PROVISIONING", "READY", "FAILED", "CAP_FULL"] as const) {
      const answer = GuestWorldView.parse({ ...ready, status });
      expect(GuestWorld.parse(answer)).toEqual(answer);
    }
  });

  it("the texts are the ones of docs/landing-spec.md §7.6, in tuteo", () => {
    expect(guestHomeCopy.es.provisioning.title).toBe("Estamos preparando tu mundo de prueba.");
    expect(guestHomeCopy.es.deletion.warning).toBe("Esto borra tu cuenta, tus datos de contacto y tu mundo de prueba. No se puede deshacer.");
    expect(guestHomeCopy.es.ready.expiry("8 de octubre de 2026")).toBe("Tu mundo vence el 8 de octubre de 2026; al volver a entrar se recrea.");
    expect(guestHomeCopy.en.ready.expiry("October 8, 2026")).toBe("Your world expires on October 8, 2026; it's recreated the next time you sign in.");
    const spanish = JSON.stringify(guestHomeCopy.es);
    for (const voseo of ["probá", "creá", "tenés", "podés", "escribinos", "querés"]) expect(spanish).not.toContain(voseo);
  });
});
