// The world template of every guest (`Seed/worlds/guest.json`, docs/seed-spec.md §3): one curated world
// whose phones, cloned ids, simulator emails and caps are markers the factory fills for each world
// (ADR-0024, ADR-0025 §2). This module reads the template (checked against the digest the IaC uploaded
// it with), fills its markers for one guest operator and hands back its rows, table by table.
//
//   {{ispId}}        the world's operator: isp-guest-07, isp-guest-test or isp-guest-s<yymmdd><5>
//   {{clockTag}}     g + what follows isp-guest-: the tag of every cloned id and simulator email
//   {{phoneBlock}}   the four digits after +52 55: 02nn (invited), 0299 (rehearsal), 0300 (sign-up)
//   {{capsProfile}}  INVITED, TEST or SIGNUP: which caps of `capsProfiles` the world's settings take
import { createHash } from "node:crypto";
import { z } from "zod";
import { type GuestOrigin, GuestOrigin as GuestOriginSchema, IsoInstant, clockTagOf, clockIdOfIsp, guestOriginOfIsp } from "@cuadrilla/shared";
import { SimulatorCaps, TurnCaps } from "../domain/isps";

/** Name of the template every guest world is built from (infra/world-templates.ts `GUEST_TEMPLATE`). */
export const GUEST_TEMPLATE = "guest";

/**
 * Where every guest world's clock starts, paused: Tuesday 13/10 at 07:00 (docs/seed-spec.md §3). A
 * clock created before the template is read (a generation opened by the BFF) uses it, and a template
 * that starts elsewhere is refused.
 */
export const GUEST_WORLD_START_SIM = "2026-10-13T07:00:00-06:00";

export const MARKER_NAMES = ["ispId", "clockTag", "phoneBlock", "capsProfile"] as const;
export type MarkerName = (typeof MARKER_NAMES)[number];
export type WorldMarkers = Readonly<Record<MarkerName, string>>;

/** Phone block of each origin: two digits of the invited guest after `02`, `0299` and `0300`. */
const REHEARSAL_BLOCK = "0299";
const SIGNUP_BLOCK = "0300";

const Row = z.record(z.string(), z.unknown());
export type TemplateRow = z.infer<typeof Row>;

const CapsProfile = z.object({ simulatorCaps: SimulatorCaps, turnCaps: TurnCaps });
export type CapsProfile = z.infer<typeof CapsProfile>;

const ConsoleUserSeed = z.object({ userId: z.string().min(1), name: z.string().min(1), role: z.literal("GUEST") }).strict();

/** The parts of a filled template the factory uses; the rest (tour, scenes) is for the tour and the loader. */
export const FilledTemplate = z.looseObject({
  template: z.literal(GUEST_TEMPLATE),
  templateVersion: z.string().regex(/^v\d{3}$/),
  ispId: z.string().min(1),
  clockId: z.string().min(1),
  startAtSim: IsoInstant,
  whatsappMode: z.literal("simulated"),
  capsProfiles: z.object({ INVITED: CapsProfile, TEST: CapsProfile, SIGNUP: CapsProfile }),
  guestTest: z.object({ consoleUsers: z.array(ConsoleUserSeed) }).optional(),
  tables: z.record(z.string(), z.array(Row)),
});
export type FilledTemplate = z.infer<typeof FilledTemplate>;

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

/** The markers of one guest operator; throws for an operator that is not a guest's. */
export function markersFor(ispId: string): WorldMarkers {
  const origin = guestOriginOfIsp(ispId);
  const clockTag = origin === undefined ? undefined : clockTagOf(clockIdOfIsp(ispId));
  if (origin === undefined || clockTag === undefined) throw new TemplateError(`${ispId} is not the operator of a guest world`);
  return { ispId, clockTag, phoneBlock: phoneBlockOf(ispId, origin), capsProfile: origin };
}

function phoneBlockOf(ispId: string, origin: GuestOrigin): string {
  if (origin === "SIGNUP") return SIGNUP_BLOCK;
  if (origin === "TEST") return REHEARSAL_BLOCK;
  return `02${ispId.slice("isp-guest-".length)}`;
}

const MARKER = /\{\{([A-Za-z]+)\}\}/g;

/**
 * Fills every marker of the template's text and parses it. A marker the template names but this
 * module does not know, or one left unfilled, fails: a world is never built with a literal marker.
 */
export function fillTemplate(text: string, markers: WorldMarkers): FilledTemplate {
  const filled = text.replace(MARKER, (whole, name: string) => {
    if (!(MARKER_NAMES as readonly string[]).includes(name)) throw new TemplateError(`unknown template marker ${whole}`);
    return markers[name as MarkerName];
  });
  let json: unknown;
  try {
    json = JSON.parse(filled);
  } catch (error) {
    throw new TemplateError("the world template is not valid JSON", { cause: error });
  }
  const parsed = FilledTemplate.safeParse(json);
  if (!parsed.success) throw new TemplateError(`the world template does not match its shape: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  if (parsed.data.ispId !== markers.ispId || parsed.data.clockId !== clockIdOfIsp(markers.ispId)) throw new TemplateError("the template's operator is not the world's");
  if (parsed.data.startAtSim !== GUEST_WORLD_START_SIM) throw new TemplateError("the guest template starts at another simulated instant");
  return parsed.data;
}

/** The caps of the world's origin (docs/seed-spec.md §4 is the single source of their values). */
export function capsOf(template: FilledTemplate, origin: GuestOrigin): CapsProfile {
  return template.capsProfiles[GuestOriginSchema.parse(origin)];
}

// ---- Reading the template from the Seed bucket ---------------------------------------------------

export interface TemplateObject {
  readonly key: string;
  readonly sha256: string;
}

export interface TemplateSource {
  /** Where the IaC uploaded the template and its digest (`Resource.WorldTemplates`). */
  locate(name: string): TemplateObject;
  /** The object's text. */
  read(key: string): Promise<string>;
}

/** The template's text, refused when its bytes are not the ones the IaC uploaded. */
export async function readTemplate(source: TemplateSource, name: string = GUEST_TEMPLATE): Promise<string> {
  const object = source.locate(name);
  const text = await source.read(object.key);
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (digest !== object.sha256) throw new TemplateError(`template ${name} does not match the digest it was uploaded with`);
  return text;
}
