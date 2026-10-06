// Test support for the day plan and the `orders` tools (never imported by runtime code): the demo
// operator of docs/seed-spec.md §4 with its settings, zone Norte (B+, −8 to −25 dBm) and the customers of
// the orders the fixtures use, plus a recorder of `TimerPort.arm` over the in-memory connector. Every
// name is the synthetic one of the seed.
import { CLOCK, ISP } from "../connector/testing";
import type { Connector } from "../connector/ports";
import type { NewEntity } from "../domain/common";
import type { Customer } from "../domain/people";
import type { Timer } from "../domain/timers";
import type { ArmTimerRequest, TimerPort } from "../agent-tools/common/ports";
import { renderTemplateBody } from "../copy/templates";
import { policyInputAt } from "../policy/context";
import { evaluate } from "../policy/engine";
import { loadPolicyRecords } from "../policy/records";
import { demoSettings } from "../policy/testing";
import type { DayStartSendRequest, DayStartSender } from "./ports";

/** Customers of the fixture orders: Lucía Treviño (24817) and three more, all synthetic. */
export const CUSTOMERS: ReadonlyArray<NewEntity<typeof Customer>> = [
  { customerId: "cust-10421", firstName: "Lucía", lastName: "Treviño", addressLine: "Calle Jacaranda 214", neighborhood: "Las Lomitas" },
  { customerId: "cust-10422", firstName: "Elena", lastName: "Robles", addressLine: "Calle Magnolia 58", neighborhood: "Arboledas" },
  { customerId: "cust-10423", firstName: "Jorge", lastName: "Salas", addressLine: "Calle Fresno 12", neighborhood: "El Mirador" },
  { customerId: "cust-10424", firstName: "Irma", lastName: "Peña", addressLine: "Calle Ciprés 9", neighborhood: "Los Encinos" },
  { customerId: "cust-10425", firstName: "Raúl", lastName: "Durán", addressLine: "Calle Laurel 31", neighborhood: "Valle Sereno" },
].map((customer) => ({ ...customer, ispId: ISP, clockId: CLOCK, email: `success+${customer.customerId}@simulator.amazonses.com` }));

/** The world clock of the fixtures: paused on 13/10 at 09:20 (the turn of the tool tests). */
export const PAUSED_AT = "2026-10-13T09:20:00-06:00";

/** The operator `isp-demo` with its settings, its paused clock, zone Norte and the fixture customers. */
export async function seedOperator(connector: Pick<Connector, "isps" | "people" | "runtime">, pausedSimNow: string = PAUSED_AT): Promise<void> {
  await connector.isps.putIsp({ ispId: ISP, kind: "DEMO", clockId: CLOCK });
  await connector.runtime.createClock({ clockId: CLOCK, ispId: ISP, kind: "DEMO", mode: "PAUSED", offsetMs: 0, pausedSimNow, worldEpoch: 1 });
  await connector.isps.putSettings(demoSettings());
  await connector.isps.putZone({ ispId: ISP, clockId: CLOCK, zoneId: "zone-norte", name: "Zona Norte", opticalClass: "B+", acceptanceRange: { minDbm: -25, maxDbm: -8 }, zoneChiefId: "zc-marisol" });
  for (const customer of CUSTOMERS) await connector.people.putCustomer(customer);
}

/** `TimerPort.arm` over the connector, recording each request (timers/ implements the real one). */
export function recordingTimers(connector: Pick<Connector, "timers">): Pick<TimerPort, "arm"> & { readonly armed: ArmTimerRequest[] } {
  const armed: ArmTimerRequest[] = [];
  return {
    armed,
    async arm(request): Promise<Timer> {
      armed.push(request);
      const ref = { home: request.home, kind: request.kind, timerId: request.timerId };
      const existing = await connector.timers.getTimer(ref);
      if (existing !== undefined) return existing;
      return connector.timers.createTimer({ ...ref, clockId: request.clockId, dueAtSim: request.dueAtSim, status: "SCHEDULED", ...(request.reason === undefined ? {} : { reason: request.reason }), payload: request.payload ?? {} });
    },
  };
}

/**
 * The outbound pipeline's part a day start needs, over the real contact policy: decide with the stored
 * records at the start's instant, audit the decision and, when allowed, store the `Message OUT`. Local
 * flows and these tests use it until outbound/ provides the real sender.
 */
export function policySender(connector: Connector, realNow: string): DayStartSender & { readonly requests: DayStartSendRequest[] } {
  const requests: DayStartSendRequest[] = [];
  return {
    requests,
    async sendDayStart(request) {
      requests.push(request);
      const at = { sim: new Date(request.eventAtSim).toISOString(), real: realNow };
      const records = await loadPolicyRecords(connector, { ispId: request.ispId, personId: request.installerId, route: "SIMULATED", at });
      const text = renderTemplateBody(request.templateName, request.params);
      const message = { kind: request.kind, channel: "WHATSAPP", form: "TEMPLATE", author: "SYSTEM", templateName: request.templateName, text } as const;
      const decision = evaluate(policyInputAt(message, { kind: "PERSON", route: "SIMULATED" }, records, at));
      const refs = { installerId: request.installerId, ...(request.timerKey === undefined ? {} : { timerKey: request.timerKey }) };
      await connector.audit.append({ ispId: request.ispId, clockId: request.clockId, atSim: at.sim, decision: decision.outcome, action: "DAY_START", ruleIds: [...decision.ruleIds], evaluated: decision.evaluated, actor: "SYSTEM", refs });
      if (decision.outcome === "DENY") return { status: "DENIED", ruleIds: decision.ruleIds, ...(decision.reason === undefined ? {} : { reason: decision.reason }) };
      if (decision.outcome === "DEFER") return { status: "DEFERRED", ruleIds: decision.ruleIds, nextAllowedAt: decision.nextAllowedAt ?? at.sim };
      const messageId = `msg-day-${request.installerId}-${request.date}-${requests.length}`;
      await connector.conversations.appendMessage({
        messageId,
        personId: request.installerId,
        ispId: request.ispId,
        clockId: request.clockId,
        direction: "OUT",
        channel: "WHATSAPP",
        content: "TEMPLATE",
        kind: "DAY_START",
        templateName: request.templateName,
        templateParams: [...request.params],
        text,
        status: "SENT",
        author: "SYSTEM",
        simulated: true,
        sentAtSim: at.sim,
        refs: { workOrderIds: [...request.workOrderIds] },
      });
      return { status: "SENT", messageId, ruleIds: decision.ruleIds };
    },
  };
}
