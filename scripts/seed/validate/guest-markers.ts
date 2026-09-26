// Invariant 26 (docs/seed-spec.md §3, §14): the `guest` template uses the markers {{phoneBlock}},
// {{clockTag}} and {{capsProfile}} (and {{ispId}} for the world's own operator) in every phone, every
// cloned id, every simulator email and every setting that changes from one world to another, and no
// literal of a guest block; its caps profiles are those of §4; and each origin (`INVITED`, `TEST`,
// `SIGNUP`) gets from it a world with its own block, tag, operator and caps, that the product's
// schemas accept and that shares no item with another world.
import { ClockId } from "@cuadrilla/shared";
import { CAPS_PROFILES, GUEST_MARKER_NAMES, guestTokens, instantiateGuestWorld, marker, type GuestTemplateFile, type GuestTokens } from "../generate/guest-template";
import { checkTable } from "../lib/conformance";
import { worldFile } from "../lib/paths";
import { PHONE_PREFIX, SIMULATOR_DOMAIN, isSimulatorEmail } from "../lib/synthetic";
import { WORLD_TABLES, type SeedItem } from "../lib/tables";
import { WorldTablesTemplate } from "../lib/worlds";
import { stableJson } from "../photos/prng";
import type { SeedBundle } from "./bundle";
import { duplicates, finding, type Finding, type Invariant } from "./types";

const TAG = marker("clockTag");
const ISP = marker("ispId");
const MARKED_PHONE_PREFIX = `${PHONE_PREFIX}${marker("phoneBlock")}`;
const MARKED_PHONE = new RegExp(`^${escapeRegExp(MARKED_PHONE_PREFIX)}0\\d{3}$`);
const MARKED_EMAIL = new RegExp(`^(?:success|bounce|complaint)\\+[a-z0-9-]*${escapeRegExp(TAG)}[a-z0-9-]*@${escapeRegExp(SIMULATOR_DOMAIN)}$`);

/** Literals that only a world of a guest has: its phone block, its operator and its tag. */
const GUEST_LITERALS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a phone number", /\+52\s?\d/],
  ["a guest operator", /isp-guest-(?:\d{2}|test|s\d{6}[a-z2-7]{5})/],
  ["a guest clock tag", /[-+]g(?:\d{2}|test|s\d{6}[a-z2-7]{5})(?=["#/@-])/],
];

/** The same literals anywhere in the file, header included: a guest block's number, operator or tag. */
const FILE_LITERALS = /\+52\s?55\s?0(?:2\d{2}|300)\s?\d{4}|isp-guest-(?:\d{2}|test|s\d{6}[a-z2-7]{5})\b|[-+]g(?:\d{2}|test|s\d{6}[a-z2-7]{5})\b/;

/** An id of a person, a customer, an order or a console user, wherever it sits in a string. */
const CLONED_ID = /(?<![A-Za-z0-9])(?:inst|sup|zc|cust|wo|usr)-[a-z0-9]+(?:-[a-z0-9]+)*/g;

/** Origins the check instantiates, one world each. */
const ORIGINS: ReadonlyArray<readonly [string, GuestTokens]> = [
  ["INVITED", guestTokens("INVITED", 7)],
  ["TEST", guestTokens("TEST")],
  ["SIGNUP", guestTokens("SIGNUP", "s261013k2m7q")],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every string of `value` with where it is, object keys included. */
function stringsIn(value: unknown, path: string, out: Array<{ path: string; text: string; key: string }>, key = ""): typeof out {
  if (typeof value === "string") out.push({ path, text: value, key });
  else if (Array.isArray(value)) value.forEach((item, index) => stringsIn(item, `${path}[${index}]`, out, key));
  else if (value !== null && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      out.push({ path: `${path}.${name} (key)`, text: name, key: "" });
      stringsIn(item, `${path}.${name}`, out, name);
    }
  }
  return out;
}

function markedTemplate(template: GuestTemplateFile): string[] {
  const errors: string[] = [];
  const marked = { ispId: template.ispId, clockId: template.clockId, unknownNumber: template.unknownNumber, tables: template.tables, tour: template.tour, scenes: template.scenes };
  const strings = stringsIn(marked, "guest", []);
  const used = new Set(strings.flatMap(({ text }) => [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map((match) => match[1] ?? "")));
  for (const name of used) if (!(GUEST_MARKER_NAMES as readonly string[]).includes(name)) errors.push(`guest: unknown marker {{${name}}}`);
  for (const name of GUEST_MARKER_NAMES) if (!used.has(name)) errors.push(`guest: the marker {{${name}}} is never used`);
  for (const { path, text, key } of strings) {
    const literal = GUEST_LITERALS.find(([, pattern]) => pattern.test(text.replaceAll(MARKED_PHONE_PREFIX, "")));
    if (literal !== undefined) errors.push(`${path}: ${literal[0]} written as a literal instead of a marker`);
    if ((key === "phone" || path === "guest.unknownNumber") && !MARKED_PHONE.test(text)) errors.push(`${path}: a phone outside +5255{{phoneBlock}}0xxx`);
    if (text.includes("@") && !MARKED_EMAIL.test(text)) errors.push(`${path}: an email without the tag of its world`);
    if (key === "ispId" && text !== ISP) errors.push(`${path}: ispId is not the marker`);
    if (key === "clockId" && text !== `GUEST#${ISP}`) errors.push(`${path}: clockId is not GUEST#{{ispId}}`);
    if (text.includes("@")) continue;
    for (const match of text.matchAll(CLONED_ID)) {
      if (!text.startsWith(`-${TAG}`, (match.index ?? 0) + match[0].length)) errors.push(`${path}: ${match[0]} is a cloned id without the tag of its world`);
    }
  }
  const settings = template.tables.Isps.filter((item) => item.entity === "IspSettings");
  if (settings.length !== 1) errors.push(`guest: ${settings.length} IspSettings items`);
  for (const item of settings) {
    if (item.capsProfile !== marker("capsProfile")) errors.push("guest IspSettings: capsProfile is not the marker");
    if ("simulatorCaps" in item || "turnCaps" in item) errors.push("guest IspSettings: caps written as literals instead of by the profile");
  }
  if (stableJson(template.capsProfiles) !== stableJson(CAPS_PROFILES)) errors.push("guest: capsProfiles differ from the values of docs/seed-spec.md §4");
  return errors;
}

function keysOf(world: { readonly tables: Record<string, readonly SeedItem[]> }): string[] {
  return WORLD_TABLES.flatMap((table) => (world.tables[table] ?? []).map((item) => `${table} ${String(item.PK)} ${String(item.SK)}`));
}

function originWorld(template: GuestTemplateFile, origin: string, tokens: GuestTokens, warnings: string[]): { errors: string[]; keys: string[] } {
  let world: ReturnType<typeof instantiateGuestWorld>;
  try {
    world = instantiateGuestWorld(template, tokens);
  } catch (error) {
    return { errors: [`${origin}: the template gives no world: ${(error as Error).message}`], keys: [] };
  }
  const errors: string[] = [];
  const phones = stringsIn(world, origin, []).filter(({ key, path }) => key === "phone" || path === `${origin}.unknownNumber`);
  for (const { path, text } of phones) if (!text.startsWith(`${PHONE_PREFIX}${tokens.phoneBlock}`)) errors.push(`${path}: ${text} outside the block ${tokens.phoneBlock}`);
  for (const phone of duplicates(phones.map(({ text }) => text))) errors.push(`${origin}: phone ${phone} used more than once`);
  for (const { path, text } of stringsIn(world, origin, []).filter(({ text }) => text.includes("@"))) {
    if (!isSimulatorEmail(text) || !text.includes(tokens.clockTag)) errors.push(`${path}: ${text} is not a simulator email of the world`);
  }
  for (const item of world.tables.Isps.filter((candidate) => candidate.entity === "IspSettings")) {
    if (stableJson({ simulatorCaps: item.simulatorCaps, turnCaps: item.turnCaps }) !== stableJson(CAPS_PROFILES[tokens.capsProfile])) errors.push(`${origin}: IspSettings without the caps of its profile`);
  }
  if (!ClockId.safeParse(world.clockId).success) {
    warnings.push(`${origin}: the product does not take the clock ${String(world.clockId)} yet (GUEST_ISP of packages/shared/src/clock-ids.ts), so its schema checks wait for it`);
    return { errors, keys: keysOf(world) };
  }
  const parsed = WorldTablesTemplate.safeParse(world);
  if (!parsed.success) errors.push(...parsed.error.issues.slice(0, 5).map((issue) => `${origin}: ${issue.path.map(String).join(".")} ${issue.message}`));
  for (const table of WORLD_TABLES) for (const found of checkTable(table, world.tables[table]).slice(0, 5)) errors.push(`${origin} ${found.key}: ${found.error}`);
  return { errors, keys: keysOf(world) };
}

function guestMarkers(bundle: SeedBundle): Finding {
  const template = bundle.guestTemplate;
  if (template === undefined) return finding(["guest: the template is missing or does not parse with its schema"]);
  const errors = markedTemplate(template);
  const line = (bundle.files.get(worldFile("guest")) ?? "").split("\n").findIndex((text) => FILE_LITERALS.test(text));
  if (line >= 0) errors.push(`${worldFile("guest")}:${line + 1}: a literal of a guest world`);
  const warnings: string[] = [];
  const keys: string[] = [];
  for (const [origin, tokens] of ORIGINS) {
    const world = originWorld(template, origin, tokens, warnings);
    errors.push(...world.errors);
    keys.push(...world.keys);
  }
  for (const key of duplicates(keys)) errors.push(`two worlds of the template share the item ${key}`);
  return finding(errors, warnings);
}

export const GUEST_MARKER_INVARIANTS: readonly Invariant[] = [
  { id: 26, title: "Guest template: markers in every phone, cloned id, simulator email and per-world setting; no literal of a guest block", check: (bundle) => guestMarkers(bundle) },
];
