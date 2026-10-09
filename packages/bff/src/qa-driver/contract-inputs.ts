// The input of every `QaDriver` action (docs/tool-catalog.md "Acciones del QaDriver"), parsed with zod
// `.strict()` before anything is read: an unknown key is INVALID. Ids name rows of the world; the guard
// (guard.ts) resolves each one to its own world from stored data and never trusts a clock the input
// pairs it with. `world.create` takes the factory's own request (worlds/qa-world.ts, worlds/worlds.ts),
// and the evaluation's two actions their own inputs (evaluation/ports.ts).
import { z } from "zod";
import { AppointmentWindow, DispatchReason } from "@cuadrilla/dispatch-mock";
import { NetworkFault, OnuBehaviour, PhysicalActionKind } from "@cuadrilla/network-contract";
import {
  CaseId,
  CaseReason,
  ClockId,
  ConsoleRole,
  GUEST_TEST_CLOCK_ID,
  InstallerId,
  IsoInstant,
  PersonId,
  PhotoId,
  PhotoItem,
  VoiceNoteId,
  WaButtonAction,
  WorkOrderId,
} from "@cuadrilla/shared";
import type { QaActionName } from "./contract";

const Timeout = (fallback: number, max = 840) => z.int().min(1).max(max).default(fallback);
const World = { clockId: ClockId };
const QaWorld = z.object(World).strict();
const OrderRef = { workOrderId: WorkOrderId };
/** A `gst-<ULID>` user of the own sign-up (leads/model.ts `SIGNUP_USERNAME_PATTERN`). */
const SignupUser = z.string().regex(/^gst-[0-9A-HJKMNP-TV-Z]{26}$/, "expected a gst-<ULID> user");
/** What the seam accepts as an address: only the QA expression (the fence reads Cognito's value again). */
export const QaSignupEmail = z.string().regex(/^success\+qa-[a-z0-9-]{1,60}@simulator\.amazonses\.com$/, "expected success+qa-…@simulator.amazonses.com");

/** What a person of the world sends through the simulated channel. */
export const InboundContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(4096) }).strict(),
  /** The latest offer of `action` to the identity (or to `fromPersonId`, to tap a nonce of someone else, FL-094). */
  z
    .object({
      type: z.literal("button"),
      action: WaButtonAction,
      fromPersonId: PersonId.optional(),
      title: z.string().min(1).max(64).optional(),
      /** Only a button whose nonce points at this object (a case, an order, an item). */
      objectId: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ type: z.literal("voice"), voiceId: VoiceNoteId }).strict(),
  z.object({ type: z.literal("photo"), photoId: PhotoId, caption: z.string().trim().min(1).max(1024).optional() }).strict(),
  /** A JPEG of `bytes` (over the channel's limit, FL-046 b) built by the driver. */
  z.object({ type: z.literal("oversizeImage"), bytes: z.int().min(1).max(6 * 1024 * 1024) }).strict(),
  z.object({ type: z.literal("other"), kind: z.enum(["sticker", "video", "document", "location"]) }).strict(),
]);
export type InboundContent = z.infer<typeof InboundContent>;

/**
 * A dispatcher's change; `platformKey` is the mock's idempotency key (the step's key by default): the same
 * key again republishes the stored event, which `FeedEvents` must ignore (SC-01/9).
 */
const Dispatch = { ...OrderRef, reason: DispatchReason.default("CUSTOMER_REQUEST"), platformKey: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional() };

const FaultInput = <T extends z.ZodType>(mode: T) => z.object({ ...World, mode: mode.nullable() }).strict();

export const ACTION_INPUTS = {
  "world.create": z.unknown(),
  "world.destroy": QaWorld,
  "world.settle": z.object({ ...World, timeoutSec: Timeout(300), holdSec: z.int().min(0).max(60).default(10) }).strict(),
  "installer.settle": z.object({ installerId: InstallerId, timeoutSec: Timeout(300), holdSec: z.int().min(0).max(60).default(10) }).strict(),
  "case.open": z.object({ ...OrderRef, reason: CaseReason }).strict(),
  "clock.advance": z.object({ ...World, minutes: z.int().min(1).max(3 * 24 * 60) }).strict(),
  "clock.advanceTo": z.object({ ...World, to: IsoInstant }).strict(),
  "clock.advanceToNext": QaWorld,
  "clock.forceCaseTimeout": z.object({ caseId: CaseId }).strict(),
  "clock.fireTimer": z.object({ ...World, timerKey: z.string().min(1).max(256) }).strict(),
  "clock.fireDayStart": z.object({ personId: InstallerId }).strict(),
  "clock.unfreeze": z.object({ ...World, leadSec: z.int().min(0).max(1800).optional(), timerKey: z.string().min(1).max(256).optional() }).strict(),
  "clock.freeze": QaWorld,
  "wa.inbound": z
    .object({
      ...World,
      identity: z.union([PersonId, z.literal("UNKNOWN")]),
      content: InboundContent,
      /** The `wamid` derives from this label instead of the call's key: two calls, one message id (a redelivery, FL-093). */
      wamidKey: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
    })
    .strict(),
  "wa.publishForeign": z.object({}).strict(),
  "probe.foreign": z.object({ eventId: z.string().min(1).max(128), timeoutSec: Timeout(60, 300) }).strict(),
  "mail.outcome": z.object({ ...World, mailId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), until: z.enum(["ANY", "FINAL"]).default("FINAL"), timeoutSec: Timeout(300) }).strict(),
  "nonce.expire": z.object({ ...World, personId: PersonId, action: WaButtonAction }).strict(),
  "network.setBehaviour": z.object({ ...OrderRef, behaviour: OnuBehaviour.optional(), rxPowerDbm: z.number().min(-50).max(10).optional(), fixed: z.boolean().optional() }).strict(),
  "network.fix": z.object({ ...OrderRef, kind: PhysicalActionKind }).strict(),
  "network.setFaults": FaultInput(NetworkFault),
  "knowledge.setFaults": FaultInput(z.enum(["ERROR_503", "TIMEOUT", "EMPTY"])),
  "transcribe.setFaults": FaultInput(z.enum(["ERROR", "FAILED", "TIMEOUT"])),
  "validator.setFaults": FaultInput(z.enum(["ERROR_503", "TIMEOUT", "NO_TOOL_USE", "INVALID_OUTPUT"])),
  "kill.set": z.object({ ...World, scope: z.literal("AGENT"), on: z.boolean() }).strict(),
  "dispatch.reschedule": z.object({ ...Dispatch, newWindow: AppointmentWindow }).strict(),
  "dispatch.reassign": z.object({ ...Dispatch, newInstallerId: InstallerId }).strict(),
  "dispatch.cancel": z.object(Dispatch).strict(),
  console: z
    .object({
      ...World,
      /** A procedure of the `appRouter` (`orders.list`, `clock.jumpToScene`, …). */
      procedure: z.string().regex(/^[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*){1,3}$/),
      input: z.unknown().optional(),
      role: ConsoleRole.default("SUPERVISOR"),
      /** Seconds since the "sign-in" (`authTime`); 0 = now. `SC-13/2` uses 1200. */
      authTimeAgoSec: z.int().min(0).max(86_400).default(0),
      sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
      /** The principal of `auth.qaLogin` for this `gst-*` user instead of a server-built one. */
      signupUser: SignupUser.optional(),
    })
    .strict(),
  "tool.invoke": z
    .object({
      ...World,
      tool: z.enum(["validate_install_photo", "close_installation", "get_checklist", "get_onu_status", "search_procedures"]),
      args: z.record(z.string(), z.unknown()).default({}),
      installerId: InstallerId,
      workOrderId: WorkOrderId.optional(),
    })
    .strict(),
  "eval.runQuestions": z.unknown(),
  "eval.runPhotos": z.unknown(),
  "fence.probe": z.object({ ...World, addresses: z.array(z.string().min(3).max(320)).min(1).max(20) }).strict(),
  "guardrail.probe": z.object({ text: z.string().min(1).max(2000).optional() }).strict(),
  "turn.forceFailure": QaWorld,
  "event.poison": z.object({ installerId: InstallerId }).strict(),
  "dlq.find": z.object({ ...World, eventId: z.string().regex(/^qa-[0-9a-f]{40}$/).optional() }).strict(),
  "dlq.delete": z.object({ ...World, eventId: z.string().regex(/^qa-[0-9a-f]{40}$/).optional() }).strict(),
  "alarm.history": z.object({ sinceReal: IsoInstant }).strict(),
  "schedule.fireStale": z.object({ ...World, timerKey: z.string().min(1).max(256), staleBy: z.int().min(1).max(10).default(1) }).strict(),
  "memory.inspect": z
    .object({
      installerId: InstallerId,
      /** An earlier epoch of the world (its actor after a reset, FL-086); the current one by default. */
      epoch: z.int().min(0).optional(),
      waitForExtraction: z
        .object({
          sentinel: z.object({ keywords: z.array(z.string().min(1).max(40)).min(1).max(10) }).strict().optional(),
          afterTs: IsoInstant.optional(),
          timeoutSec: Timeout(600, 840),
          stableSec: z.int().min(0).max(300).default(60),
          minQuietSec: z.int().min(0).max(600).default(180),
        })
        .strict()
        .optional(),
    })
    .strict(),
  snapshot: z
    .object({
      ...World,
      workOrderIds: z.array(WorkOrderId).max(30).default([]),
      personIds: z.array(PersonId).max(20).default([]),
      caseIds: z.array(CaseId).max(20).default([]),
      audit: z.boolean().default(true),
    })
    .strict(),
  "policyAudit.run": QaWorld,
  "metrics.get": QaWorld,
  "probe.mocks": z.object({}).strict(),
  /** Through the knowledge target with `caller QA` in a world of the run (the driver holds no `Retrieve`). */
  "kb.probe": z.object({ ...World, installerId: InstallerId, query: z.string().min(3).max(500).optional() }).strict(),
  "waf.probe": z.object({}).strict(),
  "auth.probe": z.object({}).strict(),
  "auth.signUp": z.object({ username: SignupUser, email: QaSignupEmail, ticket: z.string().min(1).max(4096).optional(), omitTicket: z.boolean().default(false) }).strict(),
  "auth.confirmQaSignup": z.object({ username: SignupUser }).strict(),
  "auth.qaLogin": z.object({ username: SignupUser }).strict(),
  "auth.cleanupQaSignup": z.object({ username: SignupUser }).strict(),
  "guest.forceExpire": z.object({ username: SignupUser }).strict(),
  "guest.capsOverride": z.object({ activeWorlds: z.int().min(0).max(100).optional(), signupsPerDay: z.int().min(0).max(1000).optional() }).strict(),
  /** By the `gst-*` user (fenced by its address in Cognito), or by a QA address itself (a lead before its `SignUp`). */
  "leads.get": z.union([z.object({ username: SignupUser }).strict(), z.object({ email: QaSignupEmail }).strict()]),
} as const satisfies Record<QaActionName, z.ZodType>;

export type QaInput<A extends QaActionName> = z.input<(typeof ACTION_INPUTS)[A]>;
export type QaParsedInput<A extends QaActionName> = z.output<(typeof ACTION_INPUTS)[A]>;

/** `world.create` of the test guest's world (the only `world.create` of `GUEST#isp-guest-test`). */
export const GuestTestCreate = z.object({ clockId: z.literal(GUEST_TEST_CLOCK_ID), template: z.literal("guest") }).strict();

/** The checklist item a photo stands for in `tool.invoke(validate_install_photo)`. */
export const ValidatePhotoArgs = z.object({ candidateId: z.string().min(1).max(200), item: PhotoItem }).strict();
