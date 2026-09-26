// `Cases` table (docs/architecture.md §5, docs/design-brief.md §5.8): a request for human help on an
// order that climbs the escalation ladder. Every transition is a conditional write on `version`
// and, for the ladder, on `rungVersion`: a timeout or a button with an old `rungVersion` is ignored.
import { z } from "zod";
import {
  CaseId,
  CaseKind,
  CaseReason,
  CaseStatus,
  ClockId,
  EvidenceId,
  HazardCategory,
  InstallerId,
  IsoInstant,
  IspId,
  Rung,
  RungOutcome,
  SupervisorId,
  WorkOrderId,
  ZoneChiefId,
} from "@cuadrilla/shared";
import { Actor, HistoryEntry, defineEntity } from "./common";

/** The shift roster a case was opened with; a rung whose person is missing is skipped. */
export const CaseRoster = z.object({
  primaryId: SupervisorId.optional(),
  secondaryId: SupervisorId.optional(),
  zoneChiefId: ZoneChiefId.optional(),
});
export type CaseRoster = z.infer<typeof CaseRoster>;

/** Why a rung was skipped (`LAD-*`): no reachable channel, the person opted out, or is off roster. */
export const RungSkipReason = z.enum(["NO_CHANNEL", "OPTED_OUT", "OFF_ROSTER", "NO_PERSON"]);
export type RungSkipReason = z.infer<typeof RungSkipReason>;

/** One step of the ladder as the console draws it. */
export const LadderEntry = z.object({
  rung: Rung,
  outcome: RungOutcome,
  personId: z.string().min(1).max(128).optional(),
  reason: z.string().max(200).optional(),
  channel: z.enum(["TEMPLATE", "INTERACTIVE", "EMAIL", "CONSOLE"]).optional(),
  messageId: z.string().min(1).max(128).optional(),
  atSim: IsoInstant,
});
export type LadderEntry = z.infer<typeof LadderEntry>;

/** A bridge message that could not be delivered yet (installer window closed): sent on "Ver respuesta". */
export const PendingRelay = z.object({
  messageId: z.string().min(1).max(128),
  from: z.enum(["SUPERVISOR", "INSTALLER"]),
  atSim: IsoInstant,
});
export type PendingRelay = z.infer<typeof PendingRelay>;

export const Bridge = z.object({
  open: z.boolean(),
  pendingRelays: z.array(PendingRelay).default([]),
});
export type Bridge = z.infer<typeof Bridge>;

export const Case = defineEntity("Case", {
  caseId: CaseId,
  ispId: IspId,
  clockId: ClockId,
  workOrderId: WorkOrderId,
  installerId: InstallerId,
  kind: CaseKind,
  reason: CaseReason,
  status: CaseStatus,
  rung: Rung,
  /** Bumped by every rung change; timeouts and buttons carry the one they were armed with. */
  rungVersion: z.int().min(0),
  roster: CaseRoster,
  ladder: z.array(LadderEntry).default([]),
  takenBy: SupervisorId.optional(),
  takenAtSim: IsoInstant.optional(),
  /** Summary verified by G2 and the deterministic checks, or the fixed one built by code. */
  summary: z.string().max(1000),
  evidenceIds: z.array(EvidenceId).max(10).default([]),
  hazardCategory: HazardCategory.optional(),
  bridge: Bridge.default({ open: false, pendingRelays: [] }),
  createdAtSim: IsoInstant,
  closedAtSim: IsoInstant.optional(),
  closedBy: Actor.optional(),
  closeSummary: z.string().max(1000).optional(),
  history: z.array(HistoryEntry).default([]),
});
export type Case = z.infer<typeof Case>;
