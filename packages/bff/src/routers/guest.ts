/// <reference path="../../sst-env.d.ts" />
// `guest` router of the console (ADR-0025 §2, docs/landing-spec.md §7.6): the guest's own world, for its
// portada (`/app/home`). Both procedures are `guestProcedure` (role GUEST, any origin) and act only on
// the principal's own account: nothing of the input names a user, an operator or a generation.
//
//   world        the state of the world (PROVISIONING, READY, FAILED, CAP_FULL), its summary when ready,
//                its dates and, for a sign-up guest only, whether it may delete its account
//   retryWorld   "Reintentar": once a real minute (429 `RETRY_TOO_SOON` otherwise); answers the new state
import { z } from "zod";
import { connector, tableClient } from "../connector/index";
import { lambdaProvisioner } from "../guest/provisioner";
import { type RetryPorts, retryWorld } from "../guest/retry";
import { GuestWorldView, type WorldStatusPorts, worldStatusOf } from "../guest/world-status";
import { guestProcedure, router } from "./trpc";

export type GuestPorts = WorldStatusPorts & RetryPorts;

/** No input is read: an empty object, or nothing. */
const NoInput = z.object({}).strict().optional();

/** `ports` for a test; otherwise the context's (a local server) or the Lambda's own, from its links. */
export function createGuestRouter(ports?: () => GuestPorts) {
  const portsOf = (deps: { readonly guest?: () => GuestPorts }): GuestPorts => (ports ?? deps.guest ?? defaultGuestPorts)();
  return router({
    world: guestProcedure
      .input(NoInput)
      .output(GuestWorldView)
      .query(({ ctx }) => worldStatusOf(portsOf(ctx.deps), ctx.principal)),
    retryWorld: guestProcedure
      .input(NoInput)
      .output(GuestWorldView)
      .mutation(async ({ ctx }) => {
        const outcome = await retryWorld(portsOf(ctx.deps), ctx.principal);
        ctx.log.info("guest.world.retry", { userId: ctx.principal.userId, outcome, metric: "GuestWorldRetry", value: 1 });
        return worldStatusOf(portsOf(ctx.deps), ctx.principal);
      }),
  });
}

let defaults: GuestPorts | undefined;

/** The linked tables and `GuestWorlds` of the BFF, built once per container. */
export function defaultGuestPorts(): GuestPorts {
  defaults ??= { client: tableClient(), connector: connector(), provisioner: lambdaProvisioner(), now: () => new Date() };
  return defaults;
}

export const guestRouter = createGuestRouter();
