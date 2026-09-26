// The parameterized `guest` template (docs/seed-spec.md §3-§4, ADR-0024, ADR-0025): one curated world
// for the three origins of a guest (`INVITED`, `TEST`, `SIGNUP`), in which everything that changes from
// one world to another is a marker the world factory (packages/bff/src/worlds/, WP-58) replaces:
//
//   {{ispId}}        the world's own operator: isp-guest-<nn>, isp-guest-test, isp-guest-s<yymmdd><5 base32>;
//                    its clock is GUEST#{{ispId}} (clockIdOfIsp)
//   {{clockTag}}     g<nn>, gtest, gs<yymmdd><5 base32> (clockTagOf): the suffix of every cloned id and
//                    the tag of every simulator email
//   {{phoneBlock}}   02nn (INVITED), 0299 (TEST) or 0300 (SIGNUP): every phone is +5255{{phoneBlock}}0xxx
//   {{capsProfile}}  INVITED, TEST or SIGNUP: IspSettings carries it instead of its caps, and the factory
//                    writes `simulatorCaps` and `turnCaps` from `capsProfiles` (the values of §4)
//
// Instantiating is two steps, both in `instantiateGuestTemplate`: replace every marker in every string
// of `ispId`, `clockId`, `unknownNumber`, `tables`, `tour` and `scenes` (keys included; the header is
// never touched), then swap `capsProfile` of IspSettings for the caps of that profile. `guestTest`
// holds what only the operator's rehearsal world (`TEST`) adds: the `usr-qa-guest` console user.
//
// The generator builds the world once with the sample tokens below (a world no guest ever gets) through
// the product's codecs, marks it with `markGuestTemplate`, and checks that instantiating the marked
// template with the same tokens gives back exactly that world.
import { z } from "zod";
import { IsoInstant } from "@cuadrilla/shared";
import { PHONE_PREFIX, guestBlock } from "../lib/synthetic";
import { WORLD_TABLES, SeedItem, type WorldTable } from "../lib/tables";
import { TEMPLATE_VERSION, WorldTablesTemplate } from "../lib/worlds";
import { stableJson } from "../photos/prng";
import { SIMULATOR_CAPS } from "./org";

export const GUEST_MARKER_NAMES = ["capsProfile", "clockTag", "ispId", "phoneBlock"] as const;
export type GuestMarkerName = (typeof GUEST_MARKER_NAMES)[number];

export function marker(name: GuestMarkerName): string {
  return `{{${name}}}`;
}

export const CapsProfile = z.enum(["INVITED", "TEST", "SIGNUP"]);
export type CapsProfile = z.infer<typeof CapsProfile>;

const Count = z.int().min(0);
const CapsProfileValue = z
  .object({
    simulatorCaps: z
      .object({
        turnsPerHour: Count,
        turnsPerDay: Count,
        validationsPerDay: Count,
        transcribeSecPerDay: Count,
        emailsPerDay: Count,
        messagesPerRealHourPerIdentity: Count,
        sceneJumpsPerRealHour: Count.optional(),
      })
      .strict(),
    turnCaps: z.object({ perHour: Count, perDay: Count }).strict(),
  })
  .strict();
export type CapsProfileValue = z.infer<typeof CapsProfileValue>;

const WORLD_TURN_CAPS = { perHour: 200, perDay: 1000 } as const;

/** Caps of each origin (docs/seed-spec.md §4, the single source of these values; ADR-0025 §3). */
export const CAPS_PROFILES: Readonly<Record<CapsProfile, CapsProfileValue>> = {
  // The caps the invited worlds always had: the demo world's.
  INVITED: { simulatorCaps: { ...SIMULATOR_CAPS }, turnCaps: { ...WORLD_TURN_CAPS } },
  // The rehearsal world: SC-19 and three runs of SC-18 fit in one real hour.
  TEST: { simulatorCaps: { ...SIMULATOR_CAPS, messagesPerRealHourPerIdentity: 80, turnsPerHour: 180, emailsPerDay: 60 }, turnCaps: { ...WORLD_TURN_CAPS } },
  SIGNUP: {
    simulatorCaps: { turnsPerHour: 20, turnsPerDay: 60, validationsPerDay: 20, transcribeSecPerDay: 300, emailsPerDay: 10, messagesPerRealHourPerIdentity: 15, sceneJumpsPerRealHour: 15 },
    turnCaps: { perHour: 20, perDay: 60 },
  },
};

/** What the header says each marker stands for (the syntax is the name between double braces). */
// Written without any literal of a guest world, so the whole file stays free of them (invariant 26).
export const GUEST_MARKERS: Readonly<Record<GuestMarkerName, string>> = {
  capsProfile: "INVITED, TEST or SIGNUP: the origin of the world, which picks IspSettings.simulatorCaps and turnCaps from capsProfiles",
  clockTag: "g and what follows isp-guest- in the world's operator: the tag every cloned id and every simulator email of the world carries",
  ispId: "the world's own operator: isp-guest- and the invited guest's two digits, test for the rehearsal world, or s<yymmdd><5 base32> for a signup generation; its clock is GUEST#<ispId>",
  phoneBlock: "02 and the invited guest's two digits, 0299 for the rehearsal world, 0300 for a signup: the four digits after +52 55 of every phone of the world, followed by a slot 0xxx",
};

export interface GuestTokens {
  readonly ispId: string;
  readonly clockTag: string;
  readonly phoneBlock: string;
  readonly capsProfile: CapsProfile;
}

/** Tokens of a world of each origin (docs/seed-spec.md §2): an invited guest `nn`, the rehearsal, or a signup generation. */
export function guestTokens(origin: "INVITED", guest: number): GuestTokens;
export function guestTokens(origin: "TEST"): GuestTokens;
export function guestTokens(origin: "SIGNUP", generation: string): GuestTokens;
export function guestTokens(origin: CapsProfile, arg?: number | string): GuestTokens {
  if (origin !== "SIGNUP") {
    const block = guestBlock(origin === "TEST" ? "test" : typeof arg === "number" ? arg : Number.NaN);
    return { ispId: `isp-guest-${block.number}`, clockTag: block.clockTag, phoneBlock: block.phoneBlock.slice(PHONE_PREFIX.length), capsProfile: origin };
  }
  if (typeof arg !== "string" || !/^s\d{6}[a-z2-7]{5}$/.test(arg)) throw new RangeError(`expected a signup generation s<yymmdd><5 base32>, got "${String(arg)}"`);
  return { ispId: `isp-guest-${arg}`, clockTag: `g${arg}`, phoneBlock: "0300", capsProfile: "SIGNUP" };
}

/** The world the generator builds and marks: guest `00`, which no invited guest ever is (they start at 01). */
export const SAMPLE_GUEST_TOKENS: GuestTokens = guestTokens("INVITED", 0);

/** Why `tokens` cannot make a world, or `null`: each origin has its own block and a tag that follows its operator. */
export function tokensProblem(tokens: GuestTokens): string | null {
  const suffix = /^isp-guest-(\d{2}|test|s\d{6}[a-z2-7]{5})$/.exec(tokens.ispId)?.[1];
  if (suffix === undefined) return `ispId "${tokens.ispId}" is not an operator of a guest world`;
  if (tokens.clockTag !== `g${suffix}`) return `clockTag "${tokens.clockTag}" does not follow ${tokens.ispId}`;
  const origin: CapsProfile = suffix === "test" ? "TEST" : suffix.startsWith("s") ? "SIGNUP" : "INVITED";
  if (tokens.capsProfile !== origin) return `capsProfile ${tokens.capsProfile} for a world of origin ${origin}`;
  const block = origin === "TEST" ? "0299" : origin === "SIGNUP" ? "0300" : `02${suffix}`;
  if (tokens.phoneBlock !== block) return `phoneBlock "${tokens.phoneBlock}" for ${tokens.ispId}, expected ${block}`;
  return null;
}

const MarkedTables = z.object(Object.fromEntries(WORLD_TABLES.map((table) => [table, z.array(SeedItem)])) as Record<WorldTable, z.ZodArray<typeof SeedItem>>).strict();

/** `scripts/seed/data/worlds/guest.json`: the curated guest world with its markers. */
export const GuestTemplateFile = z
  .object({
    template: z.literal("guest"),
    templateVersion: z.literal(TEMPLATE_VERSION),
    generator: z.string().min(1),
    generatorVersion: z.string().min(1),
    seed: z.literal(20260926),
    startAtSim: IsoInstant,
    whatsappMode: z.literal("simulated"),
    markers: z.object(Object.fromEntries(GUEST_MARKER_NAMES.map((name) => [name, z.string().min(1)])) as Record<GuestMarkerName, z.ZodString>).strict(),
    capsProfiles: z.object({ INVITED: CapsProfileValue, TEST: CapsProfileValue, SIGNUP: CapsProfileValue }).strict(),
    guestTest: z.object({ consoleUsers: z.array(z.object({ userId: z.string().regex(/^usr-[a-z0-9-]+$/), role: z.literal("GUEST"), name: z.string().min(1) }).strict()) }).strict(),
    ispId: z.literal(marker("ispId")),
    clockId: z.literal(`GUEST#${marker("ispId")}`),
    unknownNumber: z.string().min(1),
    tables: MarkedTables,
    tour: z.record(z.string(), z.unknown()),
    scenes: z.array(z.record(z.string(), z.unknown())),
  })
  .strict();
export type GuestTemplateFile = z.infer<typeof GuestTemplateFile>;

/** The part of the template whose strings carry markers. */
const MARKED_FIELDS = ["ispId", "clockId", "unknownNumber", "tables", "tour", "scenes"] as const;

function markedPart(template: Readonly<Partial<Record<(typeof MARKED_FIELDS)[number], unknown>>>): Record<string, unknown> {
  return Object.fromEntries(MARKED_FIELDS.map((field) => [field, template[field]]));
}

/** A world of the template as plain data: every marker replaced, and the caps of its profile in IspSettings. */
export function instantiateGuestWorld(template: GuestTemplateFile, tokens: GuestTokens): Record<string, unknown> & { readonly tables: Record<WorldTable, SeedItem[]> } {
  const problem = tokensProblem(tokens);
  if (problem !== null) throw new RangeError(problem);
  let text = JSON.stringify(markedPart(template));
  for (const name of GUEST_MARKER_NAMES) text = text.replaceAll(marker(name), tokens[name]);
  const left = /\{\{[^"]*?\}\}/.exec(text);
  if (left !== null) throw new RangeError(`the template uses a marker the factory does not know: ${left[0]}`);
  const world = JSON.parse(text) as Record<string, unknown> & { tables: Record<WorldTable, SeedItem[]> };
  const caps = template.capsProfiles[tokens.capsProfile];
  world.tables.Isps = world.tables.Isps.map((item) => {
    if (item.entity !== "IspSettings") return item;
    const { capsProfile, ...settings } = item;
    if (capsProfile !== tokens.capsProfile) throw new RangeError(`IspSettings carries capsProfile ${String(capsProfile)} instead of the marker`);
    return { ...settings, simulatorCaps: { ...caps.simulatorCaps }, turnCaps: { ...caps.turnCaps } };
  });
  const { template: name, templateVersion, generator, generatorVersion, seed, startAtSim, whatsappMode } = template;
  return { template: name, templateVersion, generator, generatorVersion, seed, startAtSim, whatsappMode, ...world };
}

/** A world of the template, checked with the schema of a whole world (lib/worlds.ts). */
export function instantiateGuestTemplate(template: GuestTemplateFile, tokens: GuestTokens): WorldTablesTemplate {
  return WorldTablesTemplate.parse(instantiateGuestWorld(template, tokens));
}

// What only the sample world has: its operator, its tag and its block, each in the only places it can be.
const SAMPLE_TAG = new RegExp(`(?<=[-+])${SAMPLE_GUEST_TOKENS.clockTag}(?=["#/@-])`, "g");
const SAMPLE_PHONE = new RegExp(`\\${PHONE_PREFIX}${SAMPLE_GUEST_TOKENS.phoneBlock}(?=0\\d{3}")`, "g");

/** The sample guest world, marked: the template the generator writes (docs/seed-spec.md §3, invariant 26). */
export function markGuestTemplate(sample: WorldTablesTemplate, guestTest: GuestTemplateFile["guestTest"]): GuestTemplateFile {
  if (sample.template !== "guest" || sample.ispId !== SAMPLE_GUEST_TOKENS.ispId) throw new RangeError("only the sample guest world can be marked");
  const sampleCaps = CAPS_PROFILES[SAMPLE_GUEST_TOKENS.capsProfile];
  const tables = Object.fromEntries(
    WORLD_TABLES.map((table) => [
      table,
      sample.tables[table].map((item) => {
        if (item.entity !== "IspSettings") return item;
        const { simulatorCaps, turnCaps, ...settings } = item;
        if (stableJson({ simulatorCaps, turnCaps }) !== stableJson(sampleCaps)) throw new RangeError("the sample world's caps are not those of its profile");
        return { ...settings, capsProfile: SAMPLE_GUEST_TOKENS.capsProfile };
      }),
    ]),
  );
  let text = JSON.stringify(markedPart({ ...sample, tables: tables as WorldTablesTemplate["tables"] }));
  text = text.replaceAll(SAMPLE_GUEST_TOKENS.ispId, marker("ispId"));
  text = text.replace(SAMPLE_TAG, marker("clockTag"));
  text = text.replace(SAMPLE_PHONE, `${PHONE_PREFIX}${marker("phoneBlock")}`);
  text = text.replaceAll(`"capsProfile":"${SAMPLE_GUEST_TOKENS.capsProfile}"`, `"capsProfile":"${marker("capsProfile")}"`);
  for (const token of [SAMPLE_GUEST_TOKENS.ispId, `-${SAMPLE_GUEST_TOKENS.clockTag}`, `+${SAMPLE_GUEST_TOKENS.clockTag}`, `${PHONE_PREFIX}${SAMPLE_GUEST_TOKENS.phoneBlock}`]) {
    if (text.includes(token)) throw new RangeError(`the marked template still carries "${token}" of the sample world`);
  }
  const { generator, generatorVersion, seed, startAtSim } = sample;
  const marked = GuestTemplateFile.parse({
    template: "guest",
    templateVersion: TEMPLATE_VERSION,
    generator,
    generatorVersion,
    seed,
    startAtSim,
    whatsappMode: "simulated",
    markers: { ...GUEST_MARKERS },
    capsProfiles: CAPS_PROFILES,
    guestTest,
    ...(JSON.parse(text) as object),
  });
  if (stableJson(instantiateGuestTemplate(marked, SAMPLE_GUEST_TOKENS)) !== stableJson(sample)) throw new RangeError("the marked template does not give back the sample world");
  return marked;
}
