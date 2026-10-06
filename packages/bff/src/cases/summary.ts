// What a case says about itself, built by code from the order (never from free text of the model):
// the category in words (`{{4}}` of the case templates, the zone chief's email) and the fixed summary
// a case opens with when the agent gave none or G2 refused the agent's (docs/tool-catalog.md,
// `escalate_case`). Every piece of an installer's words that ends up here was masked by the normalizer
// and is masked again: a summary reaches supervisors, the zone chief and the console.
import { type CaseReason, type PhotoItem, PhotoItem as PhotoItemSchema, type Symptom } from "@cuadrilla/shared";
import { esMX } from "../copy/es-MX";
import { formatDbm } from "../copy/helpers";
import type { CaseReasonInput } from "../copy/types";
import type { Case } from "../domain/cases";
import type { ChecklistEntry, TroubleshootingStep, WorkOrder } from "../domain/work-orders";
import { LOG_KINDS, type PrefilterBlockKind, maskText } from "../lib/mask";

/** `Case.summary` holds at most this much (domain/cases.ts). */
export const SUMMARY_MAX = 1000;

/** History field that keeps what a case was opened about when the reason alone does not say it. */
export const REASON_DETAIL_FIELD = "reasonDetail";

const FAILED_OUTCOMES = new Set<TroubleshootingStep["outcome"]>(["NO_CHANGE", "WORSE"]);

/** Masks every kind of `lib/mask.ts` and bounds the text: the form a summary is stored in. */
export function cleanSummary(text: string, max = SUMMARY_MAX): string {
  const masked = maskText(text.replace(/\s+/g, " ").trim(), LOG_KINDS);
  return masked.length <= max ? masked : `${masked.slice(0, max - 1)}…`;
}

/** Failed steps (`NO_CHANGE`/`WORSE`) of each symptom of an order. */
export function failedStepsBySymptom(steps: readonly TroubleshootingStep[]): Map<Symptom, TroubleshootingStep[]> {
  const bySymptom = new Map<Symptom, TroubleshootingStep[]>();
  for (const step of steps) {
    if (!FAILED_OUTCOMES.has(step.outcome)) continue;
    bySymptom.set(step.symptom, [...(bySymptom.get(step.symptom) ?? []), step]);
  }
  return bySymptom;
}

/** The symptom a `DIAGNOSIS_ATTEMPTS` case is about: the one with the most failed steps. */
export function escalatedSymptom(steps: readonly TroubleshootingStep[]): Symptom | undefined {
  let best: { symptom: Symptom; count: number } | undefined;
  for (const [symptom, failed] of failedStepsBySymptom(steps)) if (best === undefined || failed.length > best.count) best = { symptom, count: failed.length };
  return best?.symptom;
}

/** The photo item a `PHOTO_ATTEMPTS` case is about: the one with the most rejected photos. */
export function escalatedItem(checklist: readonly ChecklistEntry[]): PhotoItem | undefined {
  let best: { item: PhotoItem; attempts: number } | undefined;
  for (const entry of checklist) {
    const item = PhotoItemSchema.safeParse(entry.item);
    if (!item.success || entry.attempts === 0) continue;
    if (best === undefined || entry.attempts > best.attempts) best = { item: item.data, attempts: entry.attempts };
  }
  return best?.item;
}

/** What `caseReason` reads for a case, from the order's steps and checklist and the case's history. */
export function reasonInputOf(caseItem: Pick<Case, "reason" | "history">, steps: readonly TroubleshootingStep[], checklist: readonly ChecklistEntry[]): CaseReasonInput {
  const sensitive = caseItem.history.find((entry) => entry.field === REASON_DETAIL_FIELD)?.to;
  const symptom = caseItem.reason === "DIAGNOSIS_ATTEMPTS" ? escalatedSymptom(steps) : undefined;
  const item = caseItem.reason === "PHOTO_ATTEMPTS" ? escalatedItem(checklist) : undefined;
  return {
    reason: caseItem.reason,
    ...(symptom === undefined ? {} : { symptom }),
    ...(item === undefined ? {} : { item }),
    ...(sensitive === "CARD" ? { sensitive: sensitive satisfies PrefilterBlockKind } : {}),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface FixedSummaryInput {
  readonly reason: CaseReason;
  readonly reasonText: string;
  readonly workOrder: Pick<WorkOrder, "workOrderNumber" | "lastOnuReading">;
  readonly steps?: readonly TroubleshootingStep[];
  /** `OUT_OF_MANUAL` from the button: the installer's last question (already masked by the normalizer). */
  readonly question?: string;
  /** Sections the offer cited (`OUT_OF_MANUAL`). */
  readonly citations?: readonly string[];
  /** What the installer reported (`SAFETY`), already masked. */
  readonly report?: string;
}

/** The summary a case opens with when it has no verified one of the agent: facts of the order only. */
export function fixedSummary(input: FixedSummaryInput): string {
  const parts = [`${capitalize(input.reasonText)} · orden ${input.workOrder.workOrderNumber}.`];
  const failed = (input.steps ?? []).filter((step) => FAILED_OUTCOMES.has(step.outcome)).map((step) => step.stepRef);
  if (input.reason === "DIAGNOSIS_ATTEMPTS" && failed.length > 0) parts.push(`Pasos sin cambio: ${[...new Set(failed)].join(", ")}.`);
  const reading = input.workOrder.lastOnuReading;
  if (reading !== undefined && (input.reason === "DIAGNOSIS_ATTEMPTS" || input.reason === "NOT_PROVISIONED")) {
    parts.push(`Última lectura de la ONU: ${reading.operState}${reading.rxPowerDbm === undefined ? "" : `, ${formatDbm(reading.rxPowerDbm)}`}.`);
  }
  if (input.question !== undefined && input.question.trim() !== "") parts.push(`Pregunta: ${input.question.trim()}`);
  if (input.citations !== undefined && input.citations.length > 0) parts.push(`Secciones consultadas: ${[...new Set(input.citations)].join(", ")}.`);
  if (input.report !== undefined && input.report.trim() !== "") parts.push(`Reporte: ${input.report.trim()}`);
  return cleanSummary(parts.join(" "));
}

/** `{{4}}` of a case template and the category of the zone chief's email. */
export function caseReasonText(caseItem: Pick<Case, "reason" | "history" | "hazardCategory">, steps: readonly TroubleshootingStep[], checklist: readonly ChecklistEntry[]): string {
  if (caseItem.reason === "SAFETY" && caseItem.hazardCategory !== undefined) return esMX.hazard[caseItem.hazardCategory];
  return esMX.caseReason(reasonInputOf(caseItem, steps, checklist));
}
