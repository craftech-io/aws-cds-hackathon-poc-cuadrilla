// The world of a measurement run (docs/test-plan.md §4.5 `EV-01`/`EV-02`, docs/tool-catalog.md
// `eval.runQuestions`/`eval.runPhotos`): the `world.create` request built from the `eval` template, so
// the runner and the `QaDriver` agree on which operation, installer and order belongs to each item.
//
//   questions   clock `eval-<suiteRunId>-q`: one operation per question, each with an installer of its
//               own and one order made active (sessions and memory never shared, no `ORDER_CHOICE`)
//   photos      clock `eval-<suiteRunId>-p`: one operation per photo with the model the label asks for
//               (class and serial), the photo registered as the installer's candidate and the order
//               active; the order of the photo another one duplicates (`ph-meter-01` for `ph-adv-04`)
//               goes first and carries that photo as seeded PASS evidence, so the adversarial gate never
//               depends on the order of the run nor on the model (docs/seed-spec.md §10)
//
// The two kinds live in two worlds so either can run alone; each run id is the clock's suffix.
import { z } from "zod";
import { type ClockId, PhotoId, PhotoItem, ispIdOfClock, parseClockId } from "@cuadrilla/shared";
import type { CreateQaWorldRequest } from "../worlds/qa-world";
import { installerIdOf } from "../worlds/qa-rows";
import type { EvalTemplate, QaOperation } from "../worlds/templates";

export type EvalKind = "Q" | "P";

const KIND_SUFFIX: Readonly<Record<EvalKind, string>> = { Q: "q", P: "p" };

/**
 * Caps of a measurement world: the models' with room for a whole run inside a real hour (50 questions and
 * their taps, 60 validations); the stage's global ceiling still applies (ADR-0019).
 */
export const EVAL_SIMULATOR_CAPS = { turnsPerHour: 150, turnsPerDay: 300, validationsPerDay: 100, transcribeSecPerDay: 1800, emailsPerDay: 20, messagesPerRealHourPerIdentity: 20 } as const;

/** `eval-<suiteRunId>-q` or `-p`. */
export function evalClockId(suiteRunId: string, kind: EvalKind): ClockId {
  const clockId = `eval-${suiteRunId}-${KIND_SUFFIX[kind]}`;
  if (parseClockId(clockId)?.kind !== "EVAL") throw new RangeError(`"${suiteRunId}" does not make an evaluation clock id`);
  return clockId;
}

/** The measurement's run id and operator of a world (`eval-812-1-q` → `812-1-q`, `isp-eval-812-1-q`). */
export function evalRunOf(clockId: string): { readonly runId: string; readonly ispId: string } {
  if (parseClockId(clockId)?.kind !== "EVAL") throw new RangeError(`${clockId} is not an evaluation world`);
  return { runId: clockId.slice("eval-".length), ispId: ispIdOfClock(clockId) };
}

/** Operation key of an item: `q-A-07` → `qa07`, `ph-rosette-12` → `rosette12`. */
export function itemKey(itemId: string): string {
  const question = /^q-([AR])-(\d{2})$/.exec(itemId);
  if (question !== null) return `q${(question[1] ?? "").toLowerCase()}${question[2] ?? ""}`;
  const photo = /^ph-([a-z]+)-(\d{2})$/.exec(itemId);
  if (photo !== null && (photo[1] ?? "").length + 2 <= 16) return `${photo[1] ?? ""}${photo[2] ?? ""}`;
  throw new RangeError(`${itemId} is not an item of the measurement set`);
}

/** The installer of an item's own operation. */
export function itemInstallerId(clockId: string, itemId: string): string {
  return installerIdOf(clockId, itemKey(itemId));
}

const SeedPass = z.looseObject({ seedPassEvidence: z.looseObject({ photoId: PhotoId, item: PhotoItem }) });

/** The photo whose PASS evidence must exist before a photo is validated, if any (`ph-adv-04` → `ph-meter-01`). */
export function duplicatedPhotoOf(photo: EvalTemplate["photos"][number]): { readonly photoId: string; readonly item: PhotoItem } | undefined {
  const parsed = SeedPass.safeParse(photo.precondition);
  return parsed.success ? { photoId: parsed.data.seedPassEvidence.photoId, item: parsed.data.seedPassEvidence.item } : undefined;
}

function questionOperations(template: EvalTemplate): QaOperation[] {
  return template.questions.map((question) => ({ key: itemKey(question.questionId), model: question.model, installer: "own", preset: { activeWorkOrderId: true } }));
}

function photoOperations(template: EvalTemplate): QaOperation[] {
  const seeded = new Map<string, PhotoItem>();
  for (const photo of template.photos) {
    const duplicated = duplicatedPhotoOf(photo);
    if (duplicated !== undefined) seeded.set(duplicated.photoId, duplicated.item);
  }
  const operations = template.photos.map((photo): QaOperation => {
    const item = seeded.get(photo.photoId);
    const checklist = item === undefined ? undefined : { [item]: { status: "PASSED" as const, photoId: photo.photoId } };
    return { key: itemKey(photo.photoId), model: photo.model, installer: "own", preset: { activeWorkOrderId: true, candidates: [photo.photoId], ...(checklist === undefined ? {} : { checklist }) } };
  });
  // The order that carries the seeded evidence is the world's first.
  return [...operations.filter((operation) => operation.preset?.checklist !== undefined), ...operations.filter((operation) => operation.preset?.checklist === undefined)];
}

/** The `world.create` request of a measurement world. */
export function evalWorldRequest(template: EvalTemplate, suiteRunId: string, kind: EvalKind): CreateQaWorldRequest {
  return {
    clockId: evalClockId(suiteRunId, kind),
    startAtSim: template.startAtSim,
    operations: kind === "Q" ? questionOperations(template) : photoOperations(template),
    settings: { simulatorCaps: { ...EVAL_SIMULATOR_CAPS } },
  };
}
