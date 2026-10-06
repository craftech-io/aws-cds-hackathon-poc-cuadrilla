// The received-power range an order must reach to close (manual §MED-01, docs/tool-catalog.md
// `get_onu_status`: "inRange lo calcula el código con el rango de la zona"). The zone of the order
// carries its optical class and range; when the zone is missing or names another class than the
// order, the range of the order's class from §MED-01 applies, so the verdict is always by class and
// never by what the model writes. Shared by `get_work_order` and `get_onu_status`.
import type { OnuOperState, OpticalClass } from "@cuadrilla/shared";
import { formatDecimal } from "../../copy/helpers";
import type { AcceptanceRange, Zone } from "../../domain/isps";
import type { WorkOrder } from "../../domain/work-orders";

/** §MED-01: received power at 1490 nm a closing needs, by optical class. */
export const CLASS_ACCEPTANCE_RANGES: Readonly<Record<OpticalClass, AcceptanceRange>> = {
  "B+": { minDbm: -25, maxDbm: -8 },
  "C+": { minDbm: -28, maxDbm: -8 },
};

/** The range of the order: its zone's when the zone has the order's class, else the class's. */
export function acceptanceRangeOf(order: Pick<WorkOrder, "opticalClass">, zone?: Pick<Zone, "opticalClass" | "acceptanceRange">): AcceptanceRange {
  if (zone !== undefined && zone.opticalClass === order.opticalClass) return zone.acceptanceRange;
  return CLASS_ACCEPTANCE_RANGES[order.opticalClass];
}

/** An ONU reading closes only ONLINE and with its received power inside the range, ends included. */
export function readingInRange(operState: OnuOperState, rxPowerDbm: number | undefined, range: AcceptanceRange): boolean {
  return operState === "ONLINE" && rxPowerDbm !== undefined && rxPowerDbm >= range.minDbm && rxPowerDbm <= range.maxDbm;
}

function dbm(value: number): string {
  return formatDecimal(value, Number.isInteger(value) ? 0 : 1);
}

/** "de −8 a −25 dBm (clase B+)", the way §MED-01 writes it. */
export function acceptanceRangeText(range: AcceptanceRange, opticalClass: OpticalClass): string {
  return `de ${dbm(range.maxDbm)} a ${dbm(range.minDbm)} dBm (clase ${opticalClass})`;
}
