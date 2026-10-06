// Lambda entry of `ToolMessaging` (target `messaging`, docs/architecture.md §9.2): `packages/bff/src/agent-tools/messaging/index.handler`
// serves the Gateway (and the QaDriver's direct probes) through `createToolHandler`, so every fence
// (`LAM-CALLER`, `LAM-SCOPE`, `LAM-KILL`, `LAM-STRICT`) holds before `send_whatsapp` runs. The tool
// speaks through the outbound pipeline of the container (outbound/stage.ts), built on first use.
import { createLogger } from "../../lib/log";
import { stageOutboundDeps } from "../../outbound/stage";
import { createToolHandler } from "../common/handler";
import { defaultToolRuntime } from "../common/runtime";
import { MESSAGING_IMPLEMENTATIONS, type MessagingRuntime } from "./handler";

let runtime: MessagingRuntime | undefined;

function messagingRuntime(): MessagingRuntime {
  runtime ??= { ...defaultToolRuntime(), outbound: () => stageOutboundDeps(createLogger({ bindings: { component: "outbound", target: "messaging" } })) };
  return runtime;
}

export const messagingTools = createToolHandler({ target: "messaging", deps: messagingRuntime, tools: [...MESSAGING_IMPLEMENTATIONS] });

export const handler = messagingTools.handler;
