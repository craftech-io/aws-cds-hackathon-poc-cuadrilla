// `Isps` table (docs/architecture.md §5): the operator of a world, its settings, zones, field crews,
// shift rosters and console users. Each world has its own operator (`isp-demo`, `isp-judge-<nn>`,
// `isp-qa-<runId>-<scenario>`, `isp-eval-<runId>`), so `ispId` also scopes everything to one world.
import { z } from "zod";
import {
  CalendarDate,
  ClockId,
  ConsoleRole,
  ConsoleUserId,
  CrewId,
  IsoInstant,
  IspId,
  IspKind,
  OpticalClass,
  SupervisorId,
  TemplateName,
  TemplateStatus,
  WhatsAppMode,
  ZoneChiefId,
  ZoneId,
} from "@cuadrilla/shared";
import { EmailAddress, HistoryEntry, NonEmptyText, TimeOfDay, defineEntity } from "./common";

/**
 * The operator. The seed never writes `displayName`: the world factory stamps it from
 * `resolveBrand(BrandConfig)` (ADR-0018), so nothing static names the operator.
 */
export const Isp = defineEntity("Isp", {
  ispId: IspId,
  kind: IspKind,
  clockId: ClockId,
  displayName: NonEmptyText.max(120).optional(),
  cityName: NonEmptyText.max(120).optional(),
  /** Mailbox that receives a copy of every certificate (fenced per world by the outbound pipeline). */
  opsMailbox: EmailAddress.optional(),
});
export type Isp = z.infer<typeof Isp>;

/** Received-power range an installation must reach to close (manual §MED-01). */
export const AcceptanceRange = z
  .object({ minDbm: z.number(), maxDbm: z.number() })
  .refine((range) => range.minDbm < range.maxDbm, "minDbm must be below maxDbm");
export type AcceptanceRange = z.infer<typeof AcceptanceRange>;

export const QuietHours = z.object({ start: TimeOfDay, end: TimeOfDay });
export type QuietHours = z.infer<typeof QuietHours>;

export const TurnCaps = z.object({ perHour: z.int().min(0), perDay: z.int().min(0) });
export type TurnCaps = z.infer<typeof TurnCaps>;

/** Per-world caps of the phone simulator and of what a world may spend (ADR-0019). */
export const SimulatorCaps = z.object({
  turnsPerHour: z.int().min(0),
  turnsPerDay: z.int().min(0),
  validationsPerDay: z.int().min(0),
  transcribeSecPerDay: z.int().min(0),
  emailsPerDay: z.int().min(0),
  messagesPerRealHourPerIdentity: z.int().min(0),
});
export type SimulatorCaps = z.infer<typeof SimulatorCaps>;

export const IspSettings = defineEntity("IspSettings", {
  ispId: IspId,
  clockId: ClockId,
  timezone: NonEmptyText.default("America/Mexico_City"),
  quietHours: QuietHours,
  caseTimeoutSec: z.int().min(1),
  demoMode: z.boolean(),
  /** Rung timeout while the world clock is RUNNING in demo mode; paused worlds use caseTimeoutSec. */
  demoCaseTimeoutSec: z.int().min(1),
  whatsappMode: WhatsAppMode,
  turnCaps: TurnCaps,
  simulatorCaps: SimulatorCaps,
  /** Simulated state of each template in this world (plan B tests set PENDING or REJECTED). */
  templateStatus: z.partialRecord(TemplateName, TemplateStatus).default({}),
  costBudgetUsdPerConversation: z.number().min(0).optional(),
  rateLimitPerHour: z.int().min(0).optional(),
  /** Only `qa-*` worlds: test values of the stage's ceiling, under keys of their own (ops/cost-caps.ts). */
  globalCapsOverride: z
    .object({ turnsPerDay: z.int().min(0), validationsPerDay: z.int().min(0), transcribeSecondsPerDay: z.int().min(0) })
    .partial()
    .optional(),
  history: z.array(HistoryEntry).default([]),
});
export type IspSettings = z.infer<typeof IspSettings>;

export const Zone = defineEntity("Zone", {
  ispId: IspId,
  clockId: ClockId,
  zoneId: ZoneId,
  name: NonEmptyText.max(120),
  opticalClass: OpticalClass,
  acceptanceRange: AcceptanceRange,
  zoneChiefId: ZoneChiefId,
});
export type Zone = z.infer<typeof Zone>;

export const Crew = defineEntity("Crew", {
  ispId: IspId,
  clockId: ClockId,
  crewId: CrewId,
  zoneId: ZoneId,
  name: NonEmptyText.max(120),
});
export type Crew = z.infer<typeof Crew>;

/** Supervisors of a crew for one simulated day: on duty (`PRIMARY`) and backup (`SECONDARY`). */
export const ShiftRoster = defineEntity("ShiftRoster", {
  ispId: IspId,
  clockId: ClockId,
  crewId: CrewId,
  date: CalendarDate,
  primaryId: SupervisorId,
  secondaryId: SupervisorId,
  startsAtSim: IsoInstant,
  endsAtSim: IsoInstant,
  history: z.array(HistoryEntry).default([]),
});
export type ShiftRoster = z.infer<typeof ShiftRoster>;

/**
 * A console user. The row, found by the Cognito `sub` (`GSI1 SUB#<sub>`), is the only source of the
 * token's `ispId` and role (never `custom:ispId`). Seeded with an empty `cognitoSub`, which
 * `console:invite` fills and a reload keeps.
 */
export const ConsoleUser = defineEntity("ConsoleUser", {
  ispId: IspId,
  userId: ConsoleUserId,
  role: ConsoleRole,
  name: NonEmptyText.max(120),
  cognitoSub: z.string().max(128).default(""),
  active: z.boolean().default(true),
  email: EmailAddress.optional(),
});
export type ConsoleUser = z.infer<typeof ConsoleUser>;
