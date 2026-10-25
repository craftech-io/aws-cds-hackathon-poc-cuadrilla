// Plans of the scripted Harness: the tool calls a model makes for a turn, written once, and the default
// agent of a local world for the turns no test scripted. Every parameter a message carries is copied
// from a tool result of the same turn (the outbound pipeline's grounding and fact checks read them), and
// every procedure or policy cites a section `search_procedures` returned in that turn (`CP-CITATION`).
import type { GatewayCall } from "./gateway";
import type { Plan, PlanContext, PlanSource, PlanStep } from "./scripted-harness";

type Json = Record<string, unknown>;

/** What `tool` answered last in this turn (or the worker's preloaded read of it). */
export function outputOf(context: PlanContext, tool: string): Json {
  const call = [...context.calls].reverse().find((candidate: GatewayCall) => candidate.tool === tool);
  const output = call?.output ?? context.envelope.preloaded[tool];
  if (output === undefined) throw new Error(`the plan reads ${tool} before calling it`);
  return output as Json;
}

/** The active order of the turn, as `get_work_order` (or its preloaded read) answered it. */
export function workOrderOf(context: PlanContext): Json {
  return (outputOf(context, "get_work_order").workOrder ?? {}) as Json;
}

/** The passages `search_procedures` returned in this turn, best first. */
export function passagesOf(context: PlanContext): Array<{ readonly sectionId: string; readonly title: string; readonly text: string }> {
  return ((outputOf(context, "search_procedures").passages ?? []) as Array<{ sectionId: string; title: string; text: string }>).slice();
}

export const READ_ORDERS: PlanStep = { tool: "get_work_orders", input: {} };
export const READ_ORDER: PlanStep = { tool: "get_work_order", input: {} };
export const READ_ONU: PlanStep = { tool: "get_onu_status", input: {} };
export const READ_CHECKLIST: PlanStep = { tool: "get_checklist", input: {} };

export function search(query: string, category?: string): PlanStep {
  return { tool: "search_procedures", input: { query, ...(category === undefined ? {} : { category }) } };
}

export interface ReplyOptions {
  readonly buttons?: ReadonlyArray<Json>;
  readonly refs?: Json | ((context: PlanContext) => Json);
  readonly kind?: "REPLY" | "ORDERS_DETAIL";
}

/** One message to the installer of the session (`send_whatsapp`, the only way the agent speaks). */
export function reply(text: string | ((context: PlanContext) => string), options: ReplyOptions = {}): PlanStep {
  return {
    tool: "send_whatsapp",
    input: (context) => {
      const refs = typeof options.refs === "function" ? options.refs(context) : options.refs;
      return { recipientRole: "INSTALLER", kind: options.kind ?? "REPLY", text: typeof text === "string" ? text : text(context), ...(options.buttons === undefined ? {} : { buttons: options.buttons }), ...(refs === undefined ? {} : { refs }) };
    },
  };
}

/** A reply that cites the section `sectionId` (or the best passage) of this turn's `search_procedures`. */
export function citedReply(text: (context: PlanContext, section: { readonly sectionId: string; readonly text: string }) => string, sectionId?: string, options: Omit<ReplyOptions, "refs"> & { readonly refs?: Json } = {}): PlanStep {
  const section = (context: PlanContext) => {
    const passages = passagesOf(context);
    const found = sectionId === undefined ? passages[0] : passages.find((passage) => passage.sectionId === sectionId);
    if (found === undefined) throw new Error(`search_procedures returned no ${sectionId ?? "passage"} in this turn`);
    return found;
  };
  return reply((context) => `${text(context, section(context))} (Manual v1, §${section(context).sectionId})`, { ...options, refs: (context) => ({ ...options.refs, citations: [section(context).sectionId] }) });
}

export function troubleshooting(symptom: string, stepRef: string, outcome: "PENDING" | "FIXED" | "NO_CHANGE" | "WORSE"): PlanStep {
  return { tool: "record_troubleshooting_step", input: { symptom, stepRef, outcome } };
}

/** The candidate id the turn's envelope names (evidence/candidate.ts `candidateIdOf`), as a model copies it. */
export function candidateOf(context: PlanContext): string {
  const written = context.envelope.candidateId;
  if (written === undefined) throw new Error("the turn has no photo attachment");
  return written;
}

/** `validate_install_photo` of the turn's attachment for `item`. */
export function validate(item: string): PlanStep {
  return { tool: "validate_install_photo", input: (context) => ({ candidateId: candidateOf(context), item }) };
}

/** `validate_install_photo` of the attachment a CHOOSE_ITEM tap brought back, with the item it carries. */
export const VALIDATE_CHOSEN: PlanStep = {
  tool: "validate_install_photo",
  input: (context) => {
    if (context.envelope.item === undefined) throw new Error("the turn's attachment carries no chosen item");
    return { candidateId: candidateOf(context), item: context.envelope.item };
  },
};

/** `update_checklist(item, PASSED)` with the validation of this turn, only when it passed. */
export function passItem(item: string): PlanStep {
  return {
    tool: "update_checklist",
    input: (context) => ({ item, status: "PASSED", validationId: String(outputOf(context, "validate_install_photo").validationId) }),
    when: (context) => outputOf(context, "validate_install_photo").verdict === "PASS",
  };
}

export function escalate(reason: "OUT_OF_MANUAL" | "INSTALLER_ASKED" | "OTHER", summary: string): PlanStep {
  return { tool: "escalate_case", input: { reason, summary } };
}

export function hazard(category: string, summary: string): PlanStep {
  return { tool: "report_safety_hazard", input: { category, summary } };
}

export function closeInstallation(outcome: "INSTALLED" | "FAILED_VISIT", failedReason?: string): PlanStep {
  return { tool: "close_installation", input: { outcome, ...(failedReason === undefined ? {} : { failedReason }) } };
}

/** The status of the active order in one line, from the preloaded read (FL-025 c, `ALWAYS_ANSWER`). */
export const STATUS_REPLY: PlanStep = reply(
  (context) => {
    const order = workOrderOf(context);
    const pending = ((outputOf(context, "get_work_order").checklist ?? []) as Array<{ status: string }>).filter((item) => item.status !== "PASSED").length;
    return `Hola, vas con la orden ${String(order.workOrderNumber)}: te faltan ${pending} puntos del checklist.`;
  },
  { refs: (context) => ({ workOrderIds: [String(workOrderOf(context).workOrderNumber)] }) },
);

/** The detail of the day from `get_work_orders` (FL-010, FL-016). */
export const ORDERS_DETAIL: PlanStep = reply(
  (context) => {
    const orders = (outputOf(context, "get_work_orders").workOrders ?? []) as Array<{ workOrderNumber: string; neighborhood: string; plan: string; windowText: string }>;
    return orders.map((order) => `${order.workOrderNumber} · ${order.neighborhood} · ${order.plan} · ${order.windowText}`).join("\n");
  },
  { kind: "ORDERS_DETAIL", refs: (context) => ({ workOrderIds: ((outputOf(context, "get_work_orders").workOrders ?? []) as Array<{ workOrderNumber: string }>).map((order) => order.workOrderNumber) }) },
);

/** A turn that answers nothing (a dispatcher's change the test does not follow). */
export const QUIET: Plan = { steps: [], note: "Nada que avisar en este turno." };

/**
 * What a well-behaved agent does when a test scripted nothing: the detail of the day when the installer
 * asks for it, the brief status of the order to any other message (`ALWAYS_ANSWER`), silence otherwise.
 */
export const defaultAgent: PlanSource = (envelope) => {
  if (envelope.event.type === "ORDERS_REQUESTED") return { steps: [{ ...READ_ORDERS, when: () => envelope.preloaded.get_work_orders === undefined }, ORDERS_DETAIL], note: "Le mandé el detalle del día." };
  if (envelope.event.type !== "INSTALLER_MESSAGE") return QUIET;
  if (envelope.preloaded.get_work_order === undefined) return { steps: [reply("Hola, te leo. ¿En qué orden estás?")], note: "Sin orden activa." };
  return { steps: [STATUS_REPLY], note: "Respondí con el estado de su orden." };
};
