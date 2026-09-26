/// <reference path="../../sst-env.d.ts" />
// How the triggers and `guest.retryWorld` ask for a guest's world (ADR-0025 §2): one asynchronous
// invocation of `GuestWorlds` (`InvocationType: Event`) with the account and the generation it is for.
// The world is never built inside a trigger: Cognito waits 5 s and a world is a few hundred rows.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { ClockId, ConsoleUserId, GuestOrigin, ToolError } from "@cuadrilla/shared";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";

/** The only payload `GuestWorlds` accepts: nothing else of the caller reaches it. */
export const ProvisionRequest = z.object({ userId: ConsoleUserId, clockId: ClockId, origin: GuestOrigin }).strict();
export type ProvisionRequest = z.infer<typeof ProvisionRequest>;

export interface WorldProvisioner {
  /** Hands the request to `GuestWorlds` and returns: the world is built afterwards. */
  request(request: ProvisionRequest): Promise<void>;
}

const LinkedFunction = z.object({ name: z.string().min(1) });
let lambda: LambdaClient | undefined;

/** The linked `GuestWorlds`, invoked asynchronously. */
export function lambdaProvisioner(client?: Pick<LambdaClient, "send">, functionName: () => string = () => readLinked("GuestWorlds", LinkedFunction).name): WorldProvisioner {
  return {
    async request(request) {
      const payload = ProvisionRequest.parse(request);
      const sender = client ?? (lambda ??= new LambdaClient(awsClientConfig(CLIENT_TIMEOUTS.lambda)));
      const output = await sender.send(new InvokeCommand({ FunctionName: functionName(), InvocationType: "Event", Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
      if (output.StatusCode !== 202) throw new ToolError("UNAVAILABLE", "the world could not be requested right now");
    },
  };
}
