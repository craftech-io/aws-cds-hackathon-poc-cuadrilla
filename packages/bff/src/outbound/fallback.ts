// `WINDOW_FALLBACK` (ADR-0002, docs/design-brief.md §5.7; channels/whatsapp/events.ts): Meta refused a
// free text to a real phone because its 24 h window closed (`131047`). The equivalent `UTILITY`
// template goes out once, through the pipeline and its policy:
//
//   ORDERS_DETAIL  → `ordenes_del_dia` (name, number of orders of the day, first window), "Ver órdenes"
//   RELAY          → `respuesta_supervisor` (the supervisor's name, the order), "Ver respuesta"
//
// Any other kind waits for the person's next inbound: the bridge keeps it pending (cases/bridge.ts), so
// this module hands it to the port the caller wires, or only logs it.
import type { TemplateName } from "@cuadrilla/shared";
import type { WindowFallbackPort } from "../channels/whatsapp/events";
import type { WorldTimeReader } from "../channels/whatsapp/ports";
import { formatWindow } from "../copy/helpers";
import type { Message } from "../domain/conversations";
import type { Logger } from "../lib/log";
import { localDateOf, zonedParts } from "../services/business-hours/zoned-time";
import type { OutboundDeps } from "./deps";
import { sendOutbound } from "./pipeline";
import type { WhatsAppSendInput } from "./types";

export interface FallbackDeps {
  readonly outbound: () => OutboundDeps;
  readonly worldTime: WorldTimeReader;
  readonly logger: Logger;
  /** Keeps a failed message pending until the person writes again (the bridge's list). */
  readonly hold?: (original: Message) => Promise<void>;
}

async function ordersParams(deps: OutboundDeps, original: Message, atSim: string, timeZone: string): Promise<string[] | undefined> {
  const person = await deps.connector.people.getPerson(original.personId);
  const orders = await deps.connector.workOrders.listInstallerDay(original.personId, localDateOf(new Date(Date.parse(atSim)), timeZone));
  const first = orders[0];
  if (person === undefined || first === undefined) return undefined;
  const at = (instant: string) => zonedParts(new Date(Date.parse(instant)), timeZone).time;
  return [person.firstName, String(orders.length), formatWindow(at(first.appointmentWindow.startSim), at(first.appointmentWindow.endSim))];
}

async function replyParams(deps: OutboundDeps, original: Message): Promise<string[] | undefined> {
  const supervisorId = original.author.startsWith("PERSON:") ? original.author.slice("PERSON:".length) : undefined;
  const [supervisor, order] = await Promise.all([
    supervisorId === undefined ? undefined : deps.connector.people.getPerson(supervisorId),
    original.workOrderId === undefined ? undefined : deps.connector.workOrders.getWorkOrder(original.workOrderId),
  ]);
  return supervisor === undefined || order === undefined ? undefined : [supervisor.firstName, order.workOrderNumber];
}

export function createWindowFallback(deps: FallbackDeps): WindowFallbackPort {
  return {
    async sendTemplate(original, template: TemplateName) {
      const outbound = deps.outbound();
      const world = await deps.worldTime(original.clockId);
      if (world === undefined) return;
      const atSim = world.simNow.toISOString();
      const params = template === "ordenes_del_dia" ? await ordersParams(outbound, original, atSim, world.timeZone) : await replyParams(outbound, original);
      if (params === undefined) {
        deps.logger.warn("outbound.window_fallback_skipped", { messageId: original.messageId, template });
        return;
      }
      const request: WhatsAppSendInput = {
        channel: "WHATSAPP",
        kind: template === "ordenes_del_dia" ? "ORDERS_DETAIL" : "SUPERVISOR_REPLY_TEMPLATE",
        author: "SYSTEM",
        personId: original.personId,
        eventAtSim: atSim,
        messageId: `${original.messageId}.fallback`,
        template: { name: template, params },
        ...(original.workOrderId === undefined ? {} : { workOrderId: original.workOrderId }),
        ...(original.caseId === undefined ? {} : { caseId: original.caseId }),
        refs: { fallbackOf: original.messageId },
      };
      const result = await sendOutbound(outbound, request, { actor: "CHANNEL", correlationId: original.messageId, log: deps.logger });
      if (result.status === "REFUSED") deps.logger.warn("outbound.window_fallback_refused", { messageId: original.messageId, code: result.failure.error.code });
    },
    async holdForNextInbound(original) {
      if (deps.hold !== undefined) return deps.hold(original);
      deps.logger.info("outbound.window_fallback_held", { messageId: original.messageId, kind: original.kind });
    },
  };
}
