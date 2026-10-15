// `KILL_SWITCH_SET` in `AuditLog` (ADR-0019): the operator's script (`npm run ops:kill`) audits every
// change of a global switch under the stage's demo operator, since the switch is global.
import { DEMO_ISP_ID } from "@cuadrilla/shared";
import { connector } from "../connector";
import type { KillSwitchAuditEvent } from "./kill-switch";

export function auditKillSwitch(event: KillSwitchAuditEvent): Promise<void> {
  const { record } = event;
  return connector()
    .audit.append({
      ispId: DEMO_ISP_ID,
      decision: "ACTION",
      action: event.action,
      actor: record.setBy === "OPERATOR" ? "OPERATOR" : "SYSTEM",
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      detail: { scope: record.scope, state: record.state, setBy: record.setBy, setAtReal: record.setAtReal },
    })
    .then(() => undefined);
}
