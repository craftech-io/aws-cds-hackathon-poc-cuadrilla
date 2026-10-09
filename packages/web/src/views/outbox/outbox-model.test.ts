import { describe, expect, it } from "vitest";
import { outboxCopy } from "./copy";
import { codeLabel } from "../../lib/code-label";
import { eventsInOrder, lastEvent, recipientText, statusTone } from "./outbox-model";

describe("outbox model [FL-048] [FL-061] [FL-090]", () => {
  it("names kinds, statuses and events in words, never as raw codes", () => {
    expect(codeLabel(outboxCopy.kinds, "CERTIFICATE_EMAIL")).toBe("Acta de instalación");
    expect(codeLabel(outboxCopy.kinds, "ZONE_CHIEF_ALERT")).toBe("Alerta al jefe de zona");
    expect(codeLabel(outboxCopy.events, "DELIVERY")).toBe("Entregado");
    expect(codeLabel(outboxCopy.events, "NEW_KIND_OF_EVENT")).toBe("New kind of event");
    expect(recipientText({ toRole: "OPS_MAILBOX", to: "s***@simulator.amazonses.com" })).toBe("Operaciones · s***@simulator.amazonses.com");
  });

  it("orders the SES events and summarises a row with the last one; a delivered email reads as success", () => {
    const events = [
      { type: "DELIVERY" as const, atReal: "2026-10-20T15:00:20Z" },
      { type: "SEND" as const, atReal: "2026-10-20T15:00:01Z" },
    ];
    expect(eventsInOrder(events).map((event) => event.type)).toEqual(["SEND", "DELIVERY"]);
    expect(lastEvent(events)?.type).toBe("DELIVERY");
    expect(lastEvent([])).toBeUndefined();
    expect(statusTone("DELIVERED")).toBe("success");
    expect(statusTone("BOUNCED")).toBe("danger");
    expect(statusTone("ANYTHING")).toBe("neutral");
  });
});
