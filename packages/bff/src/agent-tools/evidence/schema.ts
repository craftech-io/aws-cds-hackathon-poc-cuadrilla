// Target `evidence` (`ToolEvidence`, docs/tool-catalog.md, docs/design-brief.md §5.10): the closing
// checklist, the isolated validation of a candidate photo and the checklist update that needs a PASS
// validation (`LAM-EVIDENCE`). There is no tool that validates evidence by hand (ADR-0011): `override`
// is declared only so Cedar can forbid it, and zod refuses it with any value.
import { z } from "zod";
import { ChecklistItem, ChecklistItemStatus, PhotoItem, RejectReason, ValidationId, Verdict } from "@cuadrilla/shared";
import { defineTool, deniedField } from "../common/definition";
import { CaseOpened } from "../common/fields";

export const getChecklistTool = defineTool({
  target: "evidence",
  name: "get_checklist",
  description:
    "Returns the closing checklist of the active work order: each item with its label, status, rejected attempts, last rejection reason and the rubric hint to ask for the photo well, and whether the checklist is complete.",
  principals: ["HARNESS", "CONSOLE"],
  args: z.strictObject({}),
  output: z.strictObject({
    items: z.array(
      z.strictObject({
        item: ChecklistItem,
        label: z.string(),
        status: ChecklistItemStatus,
        attempts: z.int().min(0),
        lastRejectReason: RejectReason.optional(),
        rubricHint: z.string().optional(),
      }),
    ),
    complete: z.boolean(),
  }),
});

export const validateInstallPhotoTool = defineTool({
  target: "evidence",
  name: "validate_install_photo",
  description:
    "Validates a photo the installer sent for a checklist item, in an isolated check you never see: verdict PASS, REJECT or UNSURE with an actionable reason text, the readings it found and the attempts so far. Use the candidateId of the <attachment/> of this turn. A third rejection of the same item opens a case by itself. UNSURE goes to human review: ask for another photo.",
  principals: ["HARNESS", "QA"],
  args: z.strictObject({
    candidateId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).describe("candidateId of the <attachment kind=\"IMAGE\"/> of this turn"),
    item: PhotoItem.describe("Checklist item the photo is for"),
  }),
  output: z.strictObject({
    validationId: ValidationId,
    verdict: Verdict,
    reasonCode: RejectReason.optional(),
    reasonText: z.string().optional(),
    readings: z.strictObject({ readingDbm: z.number().optional(), wavelengthNm: z.number().optional(), serialMatches: z.boolean().optional() }),
    attempts: z.int().min(0),
    caseOpened: CaseOpened.optional(),
  }),
});

export const updateChecklistTool = defineTool({
  target: "evidence",
  name: "update_checklist",
  description:
    "Marks a checklist item PASSED (or back to PENDING). A photo item needs the validationId of a PASS validation of the same order and item; ONU_ONLINE needs a get_onu_status of this turn that was ONLINE and in range. CUSTOMER_OK is only set by the installer's button.",
  principals: ["HARNESS"],
  args: z.strictObject({
    item: ChecklistItem.exclude(["CUSTOMER_OK"]).describe("Checklist item to update"),
    status: z.enum(["PASSED", "PENDING"]).describe("New status of the item"),
    validationId: ValidationId.optional().describe("validationId of the PASS validation; required for photo items"),
    override: deniedField("boolean", "CED-NO-OVERRIDE"),
  }),
  output: z.strictObject({ item: ChecklistItem, status: ChecklistItemStatus, complete: z.boolean() }),
});

export const EVIDENCE_TOOLS = [getChecklistTool, validateInstallPhotoTool, updateChecklistTool] as const;
