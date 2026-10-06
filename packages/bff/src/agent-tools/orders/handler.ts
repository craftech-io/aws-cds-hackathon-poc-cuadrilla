// The three tools of the `orders` target (`ToolOrders`, docs/tool-catalog.md) bound to their logic:
// the day of the installer and one order in detail (reads.ts) and the ONU of the active order from the
// network orchestrator (onu.ts). index.ts wraps them in `createToolHandler`.
import type { ToolImplementation } from "../common/context";
import type { OrdersRuntime } from "./context";
import { getOnuStatus } from "./onu";
import { getWorkOrder, getWorkOrders } from "./reads";

export const ORDERS_IMPLEMENTATIONS: readonly ToolImplementation<OrdersRuntime>[] = [getWorkOrders, getWorkOrder, getOnuStatus];
