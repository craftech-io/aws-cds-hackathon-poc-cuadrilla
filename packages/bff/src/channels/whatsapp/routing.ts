// What a supervisor's own message (not a keyword, not a button) does (docs/architecture.md §7 and
// docs/design-brief.md §5.8). A supervisor talks to Cuadrilla only through the cases they took: with
// one case taken, the text or the photo goes over the bridge to its installer, as a `SUPERVISOR_ACTION`
// on that installer's queue (ADR-0017); with several, the supervisor picks the case from a list first
// (each row a nonce bound to this message); with none, a fixed reply and nothing else.
import type { Case } from "../../domain/cases";
import { BUTTON_LABELS } from "../../copy/buttons";
import { esMX } from "../../copy/es-MX";
import { type StaffDeps, type StaffMessage, messageRefOf, noticeTo } from "./context";
import { issueNonce } from "./nonces";

/** Rows of an interactive list. */
const MAX_CHOICES = 10;

/** Short label of a case as texts and templates show it ("C-0412"). */
export function caseLabelOf(caseId: string): string {
  return `C-${caseId.slice(-4)}`;
}

export type SupervisorRouting = "RELAY_QUEUED" | "NO_CASE" | "CASE_CHOICE";

async function choiceRows(cases: readonly Case[], staff: StaffMessage, deps: StaffDeps) {
  const rows = [];
  for (const taken of cases.slice(0, MAX_CHOICES)) {
    const [order, installer] = await Promise.all([deps.connector.workOrders.getWorkOrder(taken.workOrderId), deps.connector.people.getPerson(taken.installerId)]);
    const row = esMX.caseChoiceRow({ caseLabel: caseLabelOf(taken.caseId), workOrderNumber: order?.workOrderNumber ?? "", installerFirstName: installer?.firstName ?? "" });
    const id = await issueNonce(
      { clockId: staff.clockId, personId: staff.person.personId, phoneHash: staff.sender.phoneHash, action: "CHOOSE_CASE", object: { kind: "CASE", id: taken.caseId }, messageId: staff.message.messageId },
      deps.nonces,
    );
    rows.push({ id, title: row.title, description: row.description });
  }
  return rows;
}

export async function routeSupervisorMessage(staff: StaffMessage, deps: StaffDeps): Promise<SupervisorRouting> {
  const taken = (await deps.connector.cases.listTakenBy(staff.person.personId)).filter((item) => item.status === "TAKEN" && item.clockId === staff.clockId);
  const [only] = taken;
  if (only === undefined) {
    await deps.notices.send(noticeTo(staff, "supervisorNoCase", esMX.supervisorNoCase));
    return "NO_CASE";
  }
  if (taken.length === 1) {
    await deps.queue.enqueue({
      type: "SUPERVISOR_ACTION",
      action: "RELAY",
      eventId: staff.eventId,
      clockId: staff.clockId,
      ispId: staff.ispId,
      installerId: only.installerId,
      supervisorId: staff.person.personId,
      caseId: only.caseId,
      message: messageRefOf(staff.message),
    });
    return "RELAY_QUEUED";
  }
  const rows = await choiceRows(taken, staff, deps);
  await deps.notices.send(noticeTo(staff, "caseChoice", esMX.caseChoicePrompt, { list: { button: BUTTON_LABELS.CHOOSE_CASE.es, rows } }));
  return "CASE_CHOICE";
}
