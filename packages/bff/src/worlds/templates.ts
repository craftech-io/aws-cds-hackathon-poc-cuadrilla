// The world templates besides `guest` (docs/seed-spec.md §3 and §13), as the factory reads them from
// `Seed/worlds/<name>.json` (uploaded by the IaC with their digest, infra/world-templates.ts) or, in
// `seed:load` and the tests, from the committed files with the same bytes:
//
//   demo    the operator's demo world, row by row (operator `isp-demo`, clock `GLOBAL#isp-demo`)
//   models  the model orders a QA or evaluation world clones, with zones, crews and settings
//   qa-min  two clones and the metrics fixture (`SC-15`, `SC-16`)
//   eval    one order per question and one per photo (`EV-01`, `EV-02`)
//
// Every template runs `whatsappMode: simulated` (a world goes live only through `liveWorldClockId`). The
// shapes are parsed loosely where the factory does not read a field, strictly where it does.
import { createHash } from "node:crypto";
import { z } from "zod";
import { CaseReason, CaseStatus, ChecklistItem, CustomerId, IsoInstant, OnuOperState, OnuSerial, OpticalClass, PhotoId, PhotoItem, QuestionId, RejectReason, Rung, StepOutcome, Symptom, WaButtonAction, WorkOrderId, WorkOrderNumber, ZoneId } from "@cuadrilla/shared";
import { TimeOfDay } from "../domain/common";
import { SimulatorCaps, TurnCaps } from "../domain/isps";
import { type TemplateSource, TemplateError, readTemplate } from "./template";

export const WORLD_TEMPLATE_NAMES = ["demo", "guest", "models", "qa-min", "eval"] as const;
export type WorldTemplateName = (typeof WORLD_TEMPLATE_NAMES)[number];

const Header = {
  templateVersion: z.string().regex(/^v\d{3}$/),
  startAtSim: IsoInstant,
  whatsappMode: z.literal("simulated"),
};

const Row = z.record(z.string(), z.unknown());

export const DemoTemplate = z.looseObject({
  template: z.literal("demo"),
  ...Header,
  ispId: z.literal("isp-demo"),
  clockId: z.literal("GLOBAL#isp-demo"),
  tables: z.record(z.string(), z.array(Row)),
});
export type DemoTemplate = z.infer<typeof DemoTemplate>;

export const OnuModelBehaviour = z.enum(["ONLINE_OK", "LOS_THEN_ONLINE", "LOW_POWER", "LOW_POWER_THEN_OK", "NOT_PROVISIONED", "DYING_GASP"]);
export type OnuModelBehaviour = z.infer<typeof OnuModelBehaviour>;

const StaffModel = z.looseObject({
  personId: z.string().min(1),
  role: z.enum(["INSTALLER", "SUPERVISOR", "ZONE_CHIEF"]),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  optIn: z.enum(["GRANTED", "NONE", "REVOKED"]),
});
export type StaffModel = z.infer<typeof StaffModel>;

export const ModelOrder = z.looseObject({
  model: WorkOrderId,
  workOrderNumber: WorkOrderNumber,
  /** Day of the order relative to the world's start day: −1 (the closed history), 0 or 1. */
  dayOffset: z.int().min(-1).max(1),
  window: z.object({ start: TimeOfDay, end: TimeOfDay }),
  plan: z.string().min(1),
  // The ONU of the order, its port and class, as the model's order and its `Network` row carry them.
  ...{ onuSerial: OnuSerial, onuModel: z.string().min(1), oltPort: z.string().min(1), opticalClass: OpticalClass },
  ...{ zoneId: ZoneId, crewId: z.string().min(1), status: z.enum(["SCHEDULED", "CLOSED"]) },
  installer: StaffModel,
  customer: z.looseObject({
    ...{ customerId: CustomerId, firstName: z.string().min(1), lastName: z.string().min(1) },
    ...{ addressLine: z.string().min(1), neighborhood: z.string().min(1) },
    emailOutcome: z.enum(["success", "bounce", "complaint"]),
    note: z.string().optional(),
  }),
  onu: z.object({ behaviour: OnuModelBehaviour, rxPowerDbm: z.number().optional() }),
});
export type ModelOrder = z.infer<typeof ModelOrder>;

export const ModelsTemplate = z.looseObject({
  template: z.literal("models"),
  ...Header,
  zones: z.array(z.looseObject({ zoneId: ZoneId, name: z.string().min(1), opticalClass: OpticalClass, acceptanceRange: z.object({ minDbm: z.number(), maxDbm: z.number() }) })),
  crews: z.array(z.looseObject({ crewId: z.string().min(1), zoneId: ZoneId, name: z.string().min(1), shift: z.object({ start: TimeOfDay, end: TimeOfDay }), primary: StaffModel, secondary: StaffModel, zoneChief: StaffModel })),
  settings: z.looseObject({
    caseTimeoutSec: z.int().min(1),
    demoCaseTimeoutSec: z.int().min(1),
    demoMode: z.boolean(),
    quietHours: z.object({ start: TimeOfDay, end: TimeOfDay }),
    simulatorCaps: SimulatorCaps,
    turnCaps: TurnCaps,
    templateStatus: z.record(z.string(), z.string()),
    timezone: z.string().min(1),
  }),
  consoleUsers: z.array(z.object({ userId: z.string().min(1), role: z.enum(["SUPERVISOR", "OPS"]), name: z.string().min(1) })),
  models: z.array(ModelOrder).min(1),
});
export type ModelsTemplate = z.infer<typeof ModelsTemplate>;

/** Presets of one order (docs/tool-catalog.md, `world.create`): seeded through the product's repositories. */
export const ChecklistPreset = z
  .object({
    status: z.enum(["PENDING", "PASSED", "REJECTED", "IN_REVIEW"]),
    attempts: z.int().min(0).max(8).optional(),
    photoId: PhotoId.optional(),
  })
  .strict();
export type ChecklistPreset = z.infer<typeof ChecklistPreset>;

export const OfferAction = WaButtonAction.extract(["CONSULT_SUPERVISOR", "CUSTOMER_OK", "CLOSE_INSTALLATION", "CHOOSE_ITEM"]);
export type OfferAction = z.infer<typeof OfferAction>;

export const OfferPreset = z.object({ action: OfferAction, item: PhotoItem.optional(), question: z.string().trim().min(1).max(1000).optional() }).strict();
export type OfferPreset = z.infer<typeof OfferPreset>;

export const OrderPreset = z
  .object({
    checklist: z.partialRecord(ChecklistItem, ChecklistPreset).optional(),
    onu: z.object({ behaviour: OnuModelBehaviour.optional(), rxDbm: z.number().optional(), fixed: z.boolean().optional() }).strict().optional(),
    case: z.object({ reason: CaseReason, rung: Rung, status: CaseStatus.exclude(["CLOSED"]) }).strict().optional(),
    lastInboundAtSim: IsoInstant.optional(),
    activeWorkOrderId: z.boolean().optional(),
    steps: z.array(z.object({ symptom: Symptom, stepRef: z.string().regex(/^[A-Z]+-\d{2}$/), outcome: StepOutcome }).strict()).max(10).optional(),
    offer: z.union([OfferPreset, z.array(OfferPreset).max(3)]).optional(),
    candidates: z.array(PhotoId).max(5).optional(),
    profile: z.object({ rejects: z.partialRecord(RejectReason, z.int().min(0).max(50)) }).strict().optional(),
  })
  .strict();
export type OrderPreset = z.infer<typeof OrderPreset>;

export const QaOperation = z
  .object({
    key: z.string().regex(/^[a-z0-9]{1,16}$/),
    model: WorkOrderId,
    installer: z.union([z.literal("own"), z.string().regex(/^[a-z0-9]{1,16}$/)]),
    preset: OrderPreset.optional(),
  })
  .strict();
export type QaOperation = z.infer<typeof QaOperation>;

export const QaMinTemplate = z.looseObject({
  template: z.literal("qa-min"),
  ...Header,
  operations: z.array(z.object({ key: z.string(), model: WorkOrderId, installer: z.literal("own") })).min(1),
  metrics: z.array(z.looseObject({ key: z.string(), source: z.literal("WORLD"), agentMode: z.literal("SCRIPTED") })),
});
export type QaMinTemplate = z.infer<typeof QaMinTemplate>;

export const EvalTemplate = z.looseObject({
  template: z.literal("eval"),
  ...Header,
  questions: z.array(z.object({ questionId: QuestionId, model: WorkOrderId, installer: z.literal("own") })),
  photos: z.array(
    z.looseObject({
      photoId: PhotoId,
      item: PhotoItem,
      model: WorkOrderId,
      installer: z.literal("own"),
      onu: z.object({ behaviour: OnuModelBehaviour, rxPowerDbm: z.number(), operState: OnuOperState }),
    }),
  ),
});
export type EvalTemplate = z.infer<typeof EvalTemplate>;

const SCHEMAS = { demo: DemoTemplate, models: ModelsTemplate, "qa-min": QaMinTemplate, eval: EvalTemplate } as const;
type ParsedName = keyof typeof SCHEMAS;
export type ParsedTemplate<N extends ParsedName> = z.infer<(typeof SCHEMAS)[N]>;

/** A template read through its source (digest checked) and parsed with its shape. */
export async function loadTemplate<N extends ParsedName>(source: TemplateSource, name: N): Promise<ParsedTemplate<N>> {
  const text = await readTemplate(source, name);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new TemplateError(`template ${name} is not valid JSON`, { cause: error });
  }
  const parsed = SCHEMAS[name].safeParse(json);
  if (!parsed.success) throw new TemplateError(`template ${name} does not match its shape: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
  return parsed.data as ParsedTemplate<N>;
}

/** Templates from their texts (the committed files, in `seed:load` and the tests): the digest is the text's. */
export function staticTemplateSource(texts: Readonly<Partial<Record<WorldTemplateName, string>>>): TemplateSource {
  return {
    locate(name) {
      const text = texts[name as WorldTemplateName];
      if (text === undefined) throw new TemplateError(`template ${name} was not given`);
      return { key: `worlds/${name}.json`, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
    },
    async read(key) {
      const name = /^worlds\/([a-z-]+)\.json$/.exec(key)?.[1] as WorldTemplateName | undefined;
      const text = name === undefined ? undefined : texts[name];
      if (text === undefined) throw new TemplateError(`template ${key} was not given`);
      return text;
    },
  };
}

/** The checklist items a preset may seed with evidence (the photo items). */
export function isPhotoItem(item: ChecklistItem): item is PhotoItem {
  return (PhotoItem.options as readonly string[]).includes(item);
}
