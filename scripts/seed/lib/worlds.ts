// World templates (docs/seed-spec.md §3, §13): `scripts/seed/data/worlds/<template>.json`, uploaded to
// `Seed/worlds/` for the world factory (packages/bff/src/worlds/, WP-39).
//
//   demo    the operator's demo world, item by item (the same items as the table files)
//   judge   the curated world of a judge, item by item, with the placeholder judge `00` in every id,
//           phone and email of the world; the tour window and the scenes of "Saltar a escena"
//   models  the model orders `world.create` clones into QA and evaluation worlds, with their people
//   qa-min  two clones and the metrics fixture (SC-15, SC-16)
//   eval    one order per question and one per photo, cloned from the models (EV-01, EV-02)
//
// Every template runs `whatsappMode: simulated`: a world goes live only through
// `SeedOverrides.liveWorldClockId` (`npm run channels:check-modes`).
import { z } from "zod";
import {
  CaseReason,
  CaseStatus,
  ChecklistItem,
  ClockId,
  CustomerId,
  InstallerId,
  IsoInstant,
  IspId,
  OnuOperState,
  OnuSerial,
  OpticalClass,
  PersonRole,
  PhotoId,
  PhotoItem,
  QuestionId,
  Rung,
  StepOutcome,
  Symptom,
  WaButtonAction,
  WorkOrderId,
  WorkOrderNumber,
  ZoneId,
} from "@cuadrilla/shared";
import { TimeOfDay } from "../../../packages/bff/src/domain/common";
import { SeedItem, WORLD_TABLES } from "./tables";

export const TEMPLATE_VERSION = "v001";

const Header = {
  templateVersion: z.literal(TEMPLATE_VERSION),
  generator: z.string().min(1),
  generatorVersion: z.string().min(1),
  seed: z.literal(20260926),
  startAtSim: IsoInstant,
  whatsappMode: z.literal("simulated"),
};

const Bilingual = z.object({ es: z.string().min(1), en: z.string().min(1) }).strict();

const Behaviour = z.enum(["ONLINE_OK", "LOS_THEN_ONLINE", "LOW_POWER", "LOW_POWER_THEN_OK", "NOT_PROVISIONED", "DYING_GASP"]);

/** Presets of one order (docs/tool-catalog.md, `world.create`): state seeded through the product's repositories, never by model turns. */
export const OrderPreset = z
  .object({
    checklist: z
      .partialRecord(ChecklistItem, z.object({ status: z.enum(["PENDING", "PASSED", "REJECTED", "IN_REVIEW"]), attempts: z.int().min(0).optional() }).strict())
      .optional(),
    onu: z.object({ behaviour: Behaviour.optional(), rxDbm: z.number().optional(), fixed: z.boolean().optional() }).strict().optional(),
    steps: z.array(z.object({ symptom: Symptom, stepRef: z.string().regex(/^[A-Z]+-\d{2}$/), outcome: StepOutcome }).strict()).optional(),
    case: z.object({ reason: CaseReason, rung: Rung, status: CaseStatus.exclude(["CLOSED"]) }).strict().optional(),
    offer: z.array(z.object({ action: WaButtonAction.extract(["CONSULT_SUPERVISOR", "CUSTOMER_OK", "CLOSE_INSTALLATION", "CHOOSE_ITEM"]), item: PhotoItem.optional() }).strict()).optional(),
  })
  .strict();
export type OrderPreset = z.infer<typeof OrderPreset>;

/** A scene of "Saltar a escena" (docs/design-brief.md §15): the world reset and loaded as it is just before a tour step. */
export const Scene = z
  .object({
    sceneId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: Bilingual,
    /** Tour steps the scene prepares: `X1`…`X4` of the express tour, `1`…`13` of the full one. */
    steps: z.object({ express: z.array(z.string().regex(/^X\d$/)), full: z.array(z.string().regex(/^\d{1,2}$/)) }).strict(),
    /** The clock is advanced to this instant firing the due timers in order (as "Avanzar" does). */
    advanceToSim: IsoInstant,
    installer: z.object({ personId: InstallerId, activeWorkOrderId: WorkOrderId.optional(), lastInboundAtSim: IsoInstant.optional() }).strict(),
    orders: z.record(WorkOrderId, OrderPreset),
    description: z.string().min(1),
  })
  .strict();
export type Scene = z.infer<typeof Scene>;

export const Tour = z
  .object({ installerId: InstallerId, workOrderIds: z.array(WorkOrderId).min(1), windowStartSim: IsoInstant, windowEndSim: IsoInstant })
  .strict()
  .refine((tour) => Date.parse(tour.windowStartSim) < Date.parse(tour.windowEndSim), "the tour window must end after it starts");
export type Tour = z.infer<typeof Tour>;

const TablesShape = z.object(Object.fromEntries(WORLD_TABLES.map((table) => [table, z.array(SeedItem)])) as Record<(typeof WORLD_TABLES)[number], z.ZodArray<typeof SeedItem>>).strict();

/** `demo` and `judge`: a whole world, item by item. */
export const WorldTablesTemplate = z
  .object({
    template: z.enum(["demo", "judge"]),
    ...Header,
    ispId: IspId,
    clockId: ClockId,
    unknownNumber: z.string().regex(/^\+\d{8,15}$/),
    /** Only `judge`: the tokens of the placeholder judge the world factory replaces. */
    placeholders: z.object({ judgeNumber: z.literal("00"), clockTag: z.literal("j00"), ispId: IspId, clockId: ClockId, phoneBlock: z.string(), emailTag: z.literal("j00") }).strict().optional(),
    /**
     * Only `judge`: what `isp-judge-test` (the operator's rehearsal and the `QaDriver`'s `JUDGE`
     * principal) changes over the template (docs/seed-spec.md §4): higher simulator caps, so `SC-19` and
     * three runs of `SC-18` fit in one real hour, and the `usr-qa-judge` user bound to that world.
     */
    judgeTest: z
      .object({
        simulatorCaps: z.object({ messagesPerRealHourPerIdentity: z.int(), turnsPerHour: z.int(), emailsPerDay: z.int() }).strict(),
        consoleUsers: z.array(z.object({ userId: z.string().regex(/^usr-[a-z0-9-]+$/), role: z.literal("JUDGE"), name: z.string().min(1) }).strict()),
      })
      .strict()
      .optional(),
    tables: TablesShape,
    tour: Tour.optional(),
    scenes: z.array(Scene).optional(),
  })
  .strict();
export type WorldTablesTemplate = z.infer<typeof WorldTablesTemplate>;

const StaffModel = z
  .object({ personId: z.string(), role: PersonRole.exclude(["CUSTOMER"]), firstName: z.string().min(1), lastName: z.string().min(1), optIn: z.enum(["GRANTED", "NONE", "REVOKED"]) })
  .strict();

export const ModelOrder = z
  .object({
    model: WorkOrderId,
    workOrderNumber: WorkOrderNumber,
    /** Day of the order relative to the world's start day: −1 (the closed history), 0 or 1. */
    dayOffset: z.int().min(-1).max(1),
    window: z.object({ start: TimeOfDay, end: TimeOfDay }).strict(),
    plan: z.string().min(1),
    onuSerial: OnuSerial,
    onuModel: z.string().min(1),
    oltPort: z.string().min(1),
    opticalClass: OpticalClass,
    zoneId: ZoneId,
    crewId: z.string().min(1),
    status: z.enum(["SCHEDULED", "CLOSED"]),
    installer: StaffModel.extend({ crewId: z.string().min(1) }),
    customer: z
      .object({
        customerId: CustomerId,
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        addressLine: z.string().min(1),
        neighborhood: z.string().min(1),
        emailOutcome: z.enum(["success", "bounce", "complaint"]),
        note: z.string().optional(),
      })
      .strict(),
    onu: z.object({ behaviour: Behaviour, rxPowerDbm: z.number().optional() }).strict(),
    story: z.string().min(1),
  })
  .strict();
export type ModelOrder = z.infer<typeof ModelOrder>;

export const ModelsTemplate = z
  .object({
    template: z.literal("models"),
    ...Header,
    zones: z.array(z.object({ zoneId: ZoneId, name: z.string(), opticalClass: OpticalClass, acceptanceRange: z.object({ minDbm: z.number(), maxDbm: z.number() }).strict() }).strict()),
    crews: z.array(z.object({ crewId: z.string(), zoneId: ZoneId, name: z.string(), shift: z.object({ start: TimeOfDay, end: TimeOfDay }).strict(), primary: StaffModel, secondary: StaffModel, zoneChief: StaffModel }).strict()),
    settings: z.record(z.string(), z.unknown()),
    consoleUsers: z.array(z.object({ userId: z.string().regex(/^usr-[a-z0-9-]+$/), role: z.enum(["SUPERVISOR", "OPS"]), name: z.string() }).strict()),
    models: z.array(ModelOrder),
  })
  .strict();
export type ModelsTemplate = z.infer<typeof ModelsTemplate>;

const Operation = z.object({ key: z.string().regex(/^[a-z0-9]+$/), model: WorkOrderId, installer: z.literal("own") }).strict();

export const QaMinTemplate = z
  .object({
    template: z.literal("qa-min"),
    ...Header,
    operations: z.array(Operation).min(1),
    metrics: z.array(z.object({ key: z.string(), source: z.literal("WORLD"), agentMode: z.literal("SCRIPTED") }).loose()),
  })
  .strict();
export type QaMinTemplate = z.infer<typeof QaMinTemplate>;

export const EvalTemplate = z
  .object({
    template: z.literal("eval"),
    ...Header,
    questions: z.array(z.object({ questionId: QuestionId, model: WorkOrderId, installer: z.literal("own") }).strict()),
    photos: z.array(
      z
        .object({
          photoId: PhotoId,
          item: PhotoItem,
          model: WorkOrderId,
          installer: z.literal("own"),
          onu: z.object({ behaviour: Behaviour, rxPowerDbm: z.number(), operState: OnuOperState }).strict(),
          precondition: z.object({ seedPassEvidence: z.object({ photoId: PhotoId, item: PhotoItem, on: z.literal("separate-order") }).strict() }).strict().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type EvalTemplate = z.infer<typeof EvalTemplate>;

export const TEMPLATE_NAMES = ["demo", "judge", "models", "qa-min", "eval"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
