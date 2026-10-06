// Lambda entry of `ToolOrders` (target `orders`, docs/architecture.md §9.2): `packages/bff/src/agent-tools/orders/index.handler`
// serves the Gateway and direct invocations through `createToolHandler`, so every fence (`LAM-CALLER`,
// `LAM-SCOPE`, `LAM-KILL`, `LAM-STRICT`) holds before the logic of handler.ts runs. The dependencies
// are built once per container: the common tool runtime, the network orchestrator's client and the
// `open_case(NOT_PROVISIONED)` of the second reading in a row (FL-022), over the stage's cases module
// (cases/stage.ts), built on its first call.
import { createToolHandler } from "../common/handler";
import { defaultToolRuntime } from "../common/runtime";
import { stageCases } from "../../cases/stage";
import { createLogger } from "../../lib/log";
import { networkClient } from "../../network/client";
import { notProvisionedCases } from "../cases/actions";
import type { OrdersRuntime } from "./context";
import { ORDERS_IMPLEMENTATIONS } from "./handler";

let runtime: OrdersRuntime | undefined;

function ordersRuntime(): OrdersRuntime {
  if (runtime === undefined) {
    const network = networkClient();
    let cases: ReturnType<typeof stageCases> | undefined;
    const logger = createLogger({ bindings: { component: "cases", target: "orders" } });
    runtime = { ...defaultToolRuntime(), network, notProvisionedCases: { open: (request) => notProvisionedCases((cases ??= stageCases(logger, { network })).deps).open(request) } };
  }
  return runtime;
}

export const ordersTools = createToolHandler({ target: "orders", deps: ordersRuntime, tools: ORDERS_IMPLEMENTATIONS });

export const handler = ordersTools.handler;
