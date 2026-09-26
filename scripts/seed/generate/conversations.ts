// The WhatsApp history of a world before 13/10 (docs/seed-spec.md §14, invariant 10): every opt-in
// ("ALTA" and its welcome), the opt-out of 09/10 ("BAJA" and its confirmation) and the working day of
// 12/10 of each installer with closed orders (the `ordenes_del_dia` template, "Ver órdenes", the
// agent's list, the customer's conformity and the closing). Fixed texts come from copy/; each
// outbound message carries what the policy saw (`refs.policy`) and its ALLOW decision in `AuditLog`,
// and `scripts/seed/__tests__/invariants.test.ts` re-evaluates every one with the real policy.
import { formatWindow } from "../../../packages/bff/src/copy/helpers";
import { esMX } from "../../../packages/bff/src/copy/es-MX";
import { renderTemplateBody } from "../../../packages/bff/src/copy/templates";
import type { SeedItem } from "../lib/tables";
import { sha256Hex } from "../photos/prng";
import { staff, type OrderDef, type StaffDef } from "./catalog";
import { row, ulidAt } from "./context";
import { closedAt, isClosedHistory, windowOf } from "./orders";
import { optInInstants, type CustomerDef } from "./people";
import { DAYS, addMinutes, sim } from "./time";
import type { WorldSpec } from "./world";

type Form = "TEXT" | "TEMPLATE";

interface Outbound {
  readonly kind: "DAY_START" | "ORDERS_DETAIL" | "REPLY" | "SYSTEM_NOTICE";
  readonly form: Form;
  readonly author: "SYSTEM" | "AGENT";
  readonly text: string;
  readonly notice?: string;
  readonly templateName?: "ordenes_del_dia";
  readonly templateParams?: readonly string[];
  readonly inResponseToInbound: boolean;
  readonly workOrderId?: string;
}

interface Inbound {
  readonly content: "TEXT" | "BUTTON";
  readonly text?: string;
  readonly buttonAction?: "VIEW_ORDERS" | "CUSTOMER_OK" | "CLOSE_INSTALLATION";
  readonly workOrderId?: string;
}

export interface ConversationOutput {
  readonly messages: SeedItem[];
  readonly decisions: SeedItem[];
  /** Last inbound of each person, for `Person.lastInboundAtSim`. */
  readonly lastInboundAtSim: Map<string, string>;
}

class Thread {
  readonly messages: SeedItem[] = [];
  readonly decisions: SeedItem[] = [];
  readonly lastInboundAtSim = new Map<string, string>();

  constructor(private readonly world: WorldSpec) {}

  private base(personId: string, at: string, direction: "IN" | "OUT"): Record<string, unknown> {
    const messageId = `msg-${ulidAt(at, "message", personId, direction)}`;
    return {
      messageId,
      personId,
      ispId: this.world.ispId,
      clockId: this.world.clockId,
      direction,
      channel: "WHATSAPP",
      simulated: true,
      transport: "simulated",
      providerMessageId: `wamid.SIM.${sha256Hex(`${this.world.clockId}:${messageId}`).slice(0, 32)}`,
      sentAtSim: at,
    };
  }

  inbound(personId: string, at: string, message: Inbound): void {
    this.messages.push(
      row("Message", {
        ...this.base(personId, at, "IN"),
        content: message.content,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.buttonAction === undefined ? {} : { buttonAction: message.buttonAction }),
        ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }),
        status: "RECEIVED",
        author: `PERSON:${personId}`,
      }),
    );
    this.lastInboundAtSim.set(personId, at);
  }

  outbound(personId: string, at: string, message: Outbound): void {
    const fields = this.base(personId, at, "OUT");
    const decisionId = ulidAt(at, "decision", String(fields.messageId));
    this.messages.push(
      row("Message", {
        ...fields,
        content: message.form,
        kind: message.kind,
        ...(message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId }),
        text: message.text,
        ...(message.templateName === undefined ? {} : { templateName: message.templateName, templateParams: [...(message.templateParams ?? [])] }),
        status: "READ",
        policy: { decision: "ALLOW", ruleIds: [], decisionId },
        author: message.author,
        refs: {
          policy: {
            form: message.form,
            author: message.author,
            route: "SIMULATED",
            ...(message.notice === undefined ? {} : { notice: message.notice }),
            ...(message.inResponseToInbound ? { inResponseToInbound: true } : {}),
          },
        },
      }),
    );
    this.decisions.push(
      row("Decision", {
        decisionId,
        ispId: this.world.ispId,
        clockId: this.world.clockId,
        ts: at,
        atSim: at,
        atReal: at,
        decision: "ALLOW",
        action: "SEND_WHATSAPP",
        messageId: String(fields.messageId),
        actor: message.author,
        refs: message.workOrderId === undefined ? {} : { workOrderId: message.workOrderId },
        reason: "SEED_HISTORY",
      }),
    );
  }
}

function optInHistory(thread: Thread, world: WorldSpec, person: StaffDef): void {
  if (person.optIn === null) return;
  const personId = world.personId(person.personId);
  const { granted, revoked } = optInInstants(person.optIn);
  const role = person.role === "SUPERVISOR" ? "SUPERVISOR" : "INSTALLER";
  thread.inbound(personId, granted, { content: "TEXT", text: "ALTA" });
  thread.outbound(personId, addMinutes(granted, 1), { kind: "SYSTEM_NOTICE", form: "TEXT", author: "SYSTEM", notice: "welcome", text: esMX.welcome(person.firstName, role), inResponseToInbound: true });
  if (revoked === undefined) return;
  thread.inbound(personId, revoked, { content: "TEXT", text: "BAJA" });
  thread.outbound(personId, addMinutes(revoked, 1), { kind: "SYSTEM_NOTICE", form: "TEXT", author: "SYSTEM", notice: "optOutConfirmed", text: esMX.optOutConfirmed, inResponseToInbound: true });
}

/** The agent's list of the day, as a turn after "Ver órdenes" would write it (no link, no phone, no policy). */
function ordersDetail(orders: readonly OrderDef[], customers: ReadonlyMap<number, CustomerDef>): string {
  const lines = orders.map((order, index) => {
    const customer = customers.get(order.customer);
    return `${index + 1}. OT ${order.number} · ${formatWindow(order.window[0], order.window[1])} · Col. ${customer?.neighborhood ?? ""} · ${order.plan}`;
  });
  return [`Hoy tienes ${orders.length} instalaciones:`, ...lines, "Cuando llegues al domicilio, escríbeme el número de la orden."].join("\n");
}

function workingDay(thread: Thread, world: WorldSpec, installerId: string, orders: readonly OrderDef[], customers: ReadonlyMap<number, CustomerDef>): void {
  const personId = world.personId(installerId);
  const first = orders[0];
  if (first === undefined) return;
  const params = [staff(installerId).firstName, String(orders.length), formatWindow(first.window[0], first.window[1])];
  const dayStart = sim(DAYS.history, "07:30");
  thread.outbound(personId, dayStart, {
    kind: "DAY_START",
    form: "TEMPLATE",
    author: "SYSTEM",
    templateName: "ordenes_del_dia",
    templateParams: params,
    text: renderTemplateBody("ordenes_del_dia", params),
    inResponseToInbound: false,
  });
  thread.inbound(personId, addMinutes(dayStart, 4), { content: "BUTTON", buttonAction: "VIEW_ORDERS" });
  thread.outbound(personId, addMinutes(dayStart, 5), { kind: "ORDERS_DETAIL", form: "TEXT", author: "AGENT", text: ordersDetail(orders, customers), inResponseToInbound: true });
  for (const order of orders) {
    const workOrderId = world.workOrderId(order.number);
    const closed = closedAt(order);
    thread.inbound(personId, addMinutes(windowOf(order).startSim, 5), { content: "TEXT", text: `Ya llegué a la orden ${order.number}.`, workOrderId });
    thread.inbound(personId, addMinutes(closed, -8), { content: "BUTTON", buttonAction: "CUSTOMER_OK", workOrderId });
    thread.outbound(personId, addMinutes(closed, -7), {
      kind: "REPLY",
      form: "TEXT",
      author: "AGENT",
      text: "Listo, quedó registrada la conformidad del cliente. Cuando quieras, toca Cerrar instalación.",
      inResponseToInbound: true,
      workOrderId,
    });
    thread.inbound(personId, addMinutes(closed, -1), { content: "BUTTON", buttonAction: "CLOSE_INSTALLATION", workOrderId });
  }
}

export function conversationItems(world: WorldSpec, customers: ReadonlyMap<number, CustomerDef>): ConversationOutput {
  const thread = new Thread(world);
  for (const person of world.staff) optInHistory(thread, world, person);
  const closed = world.orders.filter(isClosedHistory);
  for (const installerId of [...new Set(closed.map((order) => order.installerId))]) {
    const orders = closed.filter((order) => order.installerId === installerId).sort((a, b) => (a.window[0] < b.window[0] ? -1 : 1));
    workingDay(thread, world, installerId, orders, customers);
  }
  return { messages: thread.messages, decisions: thread.decisions, lastInboundAtSim: thread.lastInboundAtSim };
}
