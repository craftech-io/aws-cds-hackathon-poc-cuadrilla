// Test kit of the guest flows (never imported by a Lambda): the world harness of worlds/testing.ts, a
// memory `Leads` table with deterministic ids, a provisioner that records what it was asked for, and
// the Cognito events of the triggers. Addresses are `@example.com` or the mailbox simulator.
import type { PostAuthenticationTriggerEvent, PostConfirmationTriggerEvent } from "aws-lambda";
import { createLogger, type Logger } from "../lib/log";
import { hashOf, leadHarness, startLead, username } from "../leads/testing";
import { type WorldHarness, worldHarness } from "../worlds/testing";
import type { ConfirmationDeps } from "./confirmation";
import type { ProvisionRequest, WorldProvisioner } from "./provisioner";
import type { SignInDeps } from "./sign-in";

export class RecordingProvisioner implements WorldProvisioner {
  readonly requests: ProvisionRequest[] = [];

  async request(request: ProvisionRequest): Promise<void> {
    this.requests.push(request);
  }
}

export interface GuestHarness extends WorldHarness {
  readonly leads: ReturnType<typeof leadHarness>;
  readonly provisioner: RecordingProvisioner;
  readonly lines: string[];
  readonly log: Logger;
  confirmationDeps(suffixes?: string[]): ConfirmationDeps;
  signInDeps(suffixes?: string[]): SignInDeps;
}

const suffixOf = (suffixes: string[] | undefined) => (suffixes === undefined ? {} : { suffix: () => suffixes.shift() ?? "zzzzz" });

export function guestHarness(start = "2026-10-01T15:00:00.000Z"): GuestHarness {
  const world = worldHarness(start);
  const leads = leadHarness();
  const provisioner = new RecordingProvisioner();
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  return Object.assign(world, {
    leads,
    provisioner,
    lines,
    log,
    confirmationDeps: (suffixes?: string[]): ConfirmationDeps => ({ client: world.client, leads: leads.store, emailHash: hashOf, provisioner, now: world.now, log, ...suffixOf(suffixes) }),
    signInDeps: (suffixes?: string[]): SignInDeps => ({ client: world.client, leads: leads.store, emailHash: hashOf, provisioner, now: world.now, log, ...suffixOf(suffixes) }),
  });
}

export const EMAIL = "ana.prueba@example.com";
export const QA_EMAIL = "success+qa-812-1-1@simulator.amazonses.com";
export const SUB = "sub-0001";

/** A pending lead started by user `n` (`gst-…000n`) for `email`. */
export async function pendingLead(harness: GuestHarness, options: { readonly email?: string; readonly user?: number } = {}): Promise<void> {
  await startLead(harness.leads.store, { email: options.email ?? EMAIL, user: options.user ?? 1, at: harness.now() });
}

export function confirmationEvent(overrides: { readonly triggerSource?: string; readonly user?: number; readonly userName?: string; readonly sub?: string; readonly email?: string } = {}): PostConfirmationTriggerEvent {
  return {
    version: "1",
    region: "us-east-1",
    userPoolId: "us-east-1_TestPool",
    userName: overrides.userName ?? username(overrides.user ?? 1),
    callerContext: { awsSdkVersion: "aws-sdk-js-3", clientId: "guest-signup-client" },
    triggerSource: (overrides.triggerSource ?? "PostConfirmation_ConfirmSignUp") as PostConfirmationTriggerEvent["triggerSource"],
    request: { userAttributes: { sub: overrides.sub ?? SUB, email: overrides.email ?? EMAIL, email_verified: "true", "cognito:user_status": "CONFIRMED" } },
    response: {},
  };
}

export function authenticationEvent(overrides: { readonly triggerSource?: string; readonly sub?: string; readonly userName?: string; readonly email?: string } = {}): PostAuthenticationTriggerEvent {
  return {
    version: "1",
    region: "us-east-1",
    userPoolId: "us-east-1_TestPool",
    userName: overrides.userName ?? username(1),
    callerContext: { awsSdkVersion: "aws-sdk-js-3", clientId: "console-web-client" },
    triggerSource: (overrides.triggerSource ?? "PostAuthentication_Authentication") as PostAuthenticationTriggerEvent["triggerSource"],
    request: { userAttributes: { sub: overrides.sub ?? SUB, ...(overrides.email === undefined ? {} : { email: overrides.email, email_verified: "true" }) }, newDeviceUsed: false },
    response: {},
  };
}

export { hashOf, username };
