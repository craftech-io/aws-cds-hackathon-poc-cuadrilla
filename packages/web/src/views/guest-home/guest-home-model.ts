// The portada of a guest (`/app/home`, docs/landing-spec.md §7.6) without React: the contract of
// `guest.world` checked with zod at the edge, the language, the parts of the console already open and
// the ones that arrive in stages (from the view registry: a view exists when `views/<id>/view.tsx`
// does), and the dates as a person reads them. Tested in guest-home-model.test.ts.
import { z } from "zod";
import type { Weekday } from "@cuadrilla/shared";
import { formatSimTime } from "../../lib/world-clock";
import type { GuestHomeCopy, GuestHomeLang } from "./copy";

export const GUEST_PROCEDURES = { world: "guest.world", retryWorld: "guest.retryWorld", deleteAccount: "account.deleteGuest" } as const;

export const WorldStatus = z.enum(["PROVISIONING", "READY", "FAILED", "CAP_FULL", "PERSON_LIMIT"]);
export type WorldStatus = z.infer<typeof WorldStatus>;

/** What `guest.world` and `guest.retryWorld` answer (packages/bff/src/guest/world-status.ts). */
export const GuestWorld = z.object({
  status: WorldStatus,
  origin: z.enum(["INVITED", "TEST", "SIGNUP"]),
  canDeleteAccount: z.boolean(),
  canRetry: z.boolean(),
  refreshSession: z.boolean(),
  createdAtReal: z.string().optional(),
  expiresAtReal: z.string().optional(),
  summary: z
    .object({
      operatorName: z.string(),
      installers: z.array(z.string()),
      supervisors: z.number().int().min(0),
      workOrders: z.number().int().min(0),
      simNow: z.string(),
    })
    .optional(),
});
export type GuestWorld = z.infer<typeof GuestWorld>;

export const AccountDeleted = z.object({ deleted: z.literal(true) });

/** While the world is being built the portada asks again every 2 s; `READY` comes within 60 s. */
export const PROVISIONING_POLL_MS = 2_000;
/** At rest it only refreshes the summary now and then. */
export const REST_POLL_MS = 60_000;
/** After this long in `PROVISIONING` the portada says it is taking longer than usual. */
export const LONG_WAIT_MS = 8_000;

export function pollMs(world: GuestWorld | undefined): number {
  return world === undefined || world.status === "PROVISIONING" ? PROVISIONING_POLL_MS : REST_POLL_MS;
}

/** `?lang=en` or a page already in English (the sign-up and the login set it) → English; Spanish otherwise. */
export function langOf(search: URLSearchParams, documentLang: string): GuestHomeLang {
  const asked = search.get("lang")?.toLowerCase();
  if (asked !== undefined) return asked.startsWith("en") ? "en" : "es";
  return documentLang.toLowerCase().startsWith("en") ? "en" : "es";
}

export interface ConsolePart {
  readonly id: string;
  readonly title: string;
}

export interface Stages {
  /** Parts of the console whose view exists: they already work. */
  readonly available: readonly ConsolePart[];
  /** Parts whose view does not exist yet: listed without dates nor promises. */
  readonly pending: readonly ConsolePart[];
}

export interface StageRoute {
  readonly id: string;
  /** A view reached from another one (the detail of an order) is not a part of its own. */
  readonly navAs?: string;
}

/** The console's parts in route order, split by whether their view exists; the portada itself is not one. */
export function stagesOf(routes: readonly StageRoute[], viewNames: readonly string[], titleOf: (id: string) => string, home: string): Stages {
  const parts = routes.filter((route) => route.navAs === undefined && route.id !== home).map((route) => ({ id: route.id, title: titleOf(route.id) }));
  const existing = new Set(viewNames);
  return { available: parts.filter((part) => existing.has(part.id)), pending: parts.filter((part) => !existing.has(part.id)) };
}

/** A real instant as the date the person reads, in its own time zone: "8 de octubre de 2026" / "October 8, 2026". */
export function formatDate(iso: string, copy: Pick<GuestHomeCopy, "months" | "dateFormat">): string {
  const date = new Date(iso);
  const month = copy.months[date.getMonth()] ?? "";
  return copy.dateFormat(date.getDate(), month, date.getFullYear());
}

/** The simulated time of the world, as the clock bar writes it ("mar 13/10 07:00"). */
export function formatWorldTime(iso: string, weekdays: Readonly<Record<Weekday, string>>): string {
  return formatSimTime(iso, weekdays);
}

/** The invitation to talk to Craftech: its link text and what follows it. */
export interface TalkCopy {
  readonly link: string;
  readonly after: string;
}

/** What the portada puts on screen for a world: its title, lead, and which actions it offers. */
export interface WorldCard {
  readonly title: string;
  readonly lead: string;
  readonly retry: boolean;
  readonly talk: TalkCopy | null;
}

export function cardOf(world: GuestWorld, copy: GuestHomeCopy): WorldCard {
  switch (world.status) {
    case "PROVISIONING":
      return { title: copy.provisioning.title, lead: copy.provisioning.lead, retry: world.canRetry, talk: null };
    case "READY":
      return { title: copy.ready.title, lead: "", retry: false, talk: null };
    case "FAILED":
      return { title: copy.failed.title, lead: copy.failed.lead, retry: true, talk: null };
    case "CAP_FULL":
      return { title: copy.capFull.title, lead: copy.capFull.lead, retry: true, talk: copy.capFull.talk };
    case "PERSON_LIMIT":
      // A third confirmed account of one person (ADR-0025 §3): no world will come, so no retry.
      return { title: copy.personLimit.title, lead: copy.personLimit.lead, retry: false, talk: copy.personLimit.talk };
  }
}
