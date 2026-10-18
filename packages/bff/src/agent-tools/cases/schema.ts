// Target `cases` (`ToolCases`, docs/tool-catalog.md, docs/design-brief.md §5.8-§5.9): troubleshooting
// steps, escalation, physical safety and the close of the installation. The agent opens cases and
// never decides them (ADR-0011): `decision` and `force` are declared only so Cedar can forbid them.
import { z } from "zod";
import { CaseId, ChecklistItem, HazardCategory, Rung, StepOutcome, Symptom } from "@cuadrilla/shared";
import { FailedVisitReason, StepRef } from "../../domain/work-orders";
import { defineTool, deniedField } from "../common/definition";
import { CaseOpened, QueuedDelivery, boundedText } from "../common/fields";

export const recordTroubleshootingStepTool = defineTool({
  target: "cases",
  name: "record_troubleshooting_step",
  description:
    "Records a troubleshooting step you indicate from the manual for the active order: PENDING in the turn you indicate it, then its outcome with the same symptom and stepRef when the installer reports it. The third NO_CHANGE or WORSE of the same symptom opens a DIAGNOSIS_ATTEMPTS case by itself. stepRef must be a section returned by search_procedures in this session.",
  principals: ["HARNESS"],
  args: z.strictObject({
    symptom: Symptom.describe("Symptom the step addresses"),
    stepRef: StepRef.describe("Manual section of the step, such as DIAG-02"),
    outcome: StepOutcome.describe("What happened after the step"),
  }),
  output: z.strictObject({ stepId: z.string(), failedAttempts: z.int().min(0), caseOpened: CaseOpened.optional() }),
});

export const escalateCaseTool = defineTool({
  target: "cases",
  name: "escalate_case",
  description:
    "Opens a case for a supervisor on the active order (one per order and reason: a second call returns the existing one). Use OUT_OF_MANUAL when the manual does not cover it and the installer accepts escalating, INSTALLER_ASKED when the installer asks for a person. Never for troubleshooting steps that failed, even when the manual says to escalate after them: record each outcome with record_troubleshooting_step, which opens that case by itself. The summary states facts of the order only, no personal data. A person takes, declines and closes cases; never you.",
  principals: ["HARNESS"],
  args: z.strictObject({
    reason: z.enum(["OUT_OF_MANUAL", "INSTALLER_ASKED", "OTHER"]).describe("Why the case opens"),
    summary: boundedText(500, "Facts of the order for the supervisor, without personal data"),
    decision: deniedField("string", "CED-NO-SUPERVISOR-DECISION"),
  }),
  output: z.strictObject({ caseId: CaseId, existing: z.boolean(), rung: Rung, notifiedFirstName: z.string().optional() }),
});

export const reportSafetyHazardTool = defineTool({
  target: "cases",
  name: "report_safety_hazard",
  description:
    "Reports a physical hazard (live or fallen power line, sparks, leaning pole, storm, unsafe height, aggressive animal, threat). Call it before anything else whenever the installer describes a present risk: it sends the manual's fixed safety instruction, alerts the supervisor and the zone chief and puts the order on hold. Never write a safety instruction yourself.",
  principals: ["HARNESS"],
  args: z.strictObject({
    category: HazardCategory.describe("Kind of hazard"),
    summary: boundedText(300, "What the installer reported, without personal data"),
  }),
  output: z.strictObject({ caseId: CaseId, instructionSent: z.boolean() }),
});

export const closeInstallationTool = defineTool({
  target: "cases",
  name: "close_installation",
  description:
    "Closes the active order. INSTALLED needs the whole checklist passed, the ONU ONLINE and in range and no open safety case: then it issues the installation certificate and delivers it. Otherwise it answers NOT_COMPLETE with the missing items; tell the installer what is missing. FAILED_VISIT records a failed visit with its reason and issues no certificate.",
  principals: ["HARNESS", "CHANNEL", "QA"],
  args: z
    .strictObject({
      outcome: z.enum(["INSTALLED", "FAILED_VISIT"]).describe("How the visit ends"),
      failedReason: FailedVisitReason.optional().describe("Why the visit failed; only with FAILED_VISIT"),
      force: deniedField("boolean", "CED-NO-FORCE-CLOSE"),
    })
    .refine((args) => args.failedReason === undefined || args.outcome === "FAILED_VISIT", { message: "failedReason goes only with FAILED_VISIT", path: ["failedReason"] }),
  output: z.strictObject({
    status: z.enum(["CLOSED", "FAILED_VISIT"]),
    certificateId: z.string().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    deliveries: z.array(QueuedDelivery),
  }),
  failure: z.strictObject({ missing: z.array(ChecklistItem).optional() }),
});

export const CASES_TOOLS = [recordTroubleshootingStepTool, escalateCaseTool, reportSafetyHazardTool, closeInstallationTool] as const;
