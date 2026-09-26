// The dependencies of a target Lambda, built once per container: the DynamoDB connector, the kill
// switch reader of ops/defaults.ts (its 30-second cache lives with the container) and the `session`
// subkey read from the linked `SessionTokenKey` on first use. Tests and the local flows pass their
// own `ToolRuntime` (common/testing.ts) instead.
import { connector } from "../../connector";
import { systemClock } from "../../lib/clock";
import { subkey } from "../../lib/secrets";
import { killSwitchReader } from "../../ops/defaults";
import type { ToolRuntime } from "./context";

let runtime: ToolRuntime | undefined;

export function defaultToolRuntime(): ToolRuntime {
  runtime ??= { connector: connector(), killSwitch: killSwitchReader(), sessionKey: () => subkey("session"), realClock: systemClock };
  return runtime;
}
