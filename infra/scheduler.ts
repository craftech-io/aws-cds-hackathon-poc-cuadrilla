// EventBridge Scheduler for the timers, and WorldJanitor (docs/architecture.md §8, §9.3 and §14,
// ADR-0004, ADR-0010, docs/build-plan.md WP-27).
//
// Timers. Everything that happens at a simulated hour is a `TIMER#` item in WorkOrders, Cases or People
// (ADR-0004). A world whose clock is RUNNING gives each timer due within the next real hour at most one
// one-time schedule `tm-<w>-<timerId>` (`at()`, FlexibleTimeWindow OFF, ActionAfterCompletion DELETE),
// which the code holding TIMERS creates, moves and deletes at runtime (packages/bff/src/timers, WP-36).
// A PAUSED world has none. This module creates what those schedules need and nothing that fires by
// itself:
//
//   Schedules group          `<app>-<stage>-schedules`: the fence of `scheduler:*` for the code (TIMERS),
//                            for the CI deploy role (by name) and for the permissions boundary.
//   SchedulerInvocation      role `<app>-<stage>-SchedulerInvocation` (inside IAM_ARNS.schedulerRole):
//                            every timer schedule runs with it. Trusted only by scheduler.amazonaws.com
//                            for this account and this group; its only permission is
//                            lambda:InvokeFunction on ScheduleDispatch.
//   ScheduleDispatch         target of every schedule, input {clockId, timerKey, dueAtSim, version}:
//                            re-reads the timer's version and enqueues TIMER in the group of the
//                            installer it belongs to (docs/architecture.md §7). Its resource policy
//                            names the invocation role.
//   Scheduler (Linkable)     the capability TIMERS: `Resource.Scheduler.{groupName, roleArn, targetArn}`,
//                            the four schedule actions on the group's schedules and iam:PassRole of the
//                            invocation role, only towards scheduler.amazonaws.com. Every role that holds
//                            TIMERS links it; no other role does.
//
// WorldJanitor. The world factory's background worker (capability WORLDS, the mocks' tables fenced to
// judge worlds by dynamodb:LeadingKeys). Two entries:
//   - MEMORY_PURGE, invoked asynchronously by Bff and QaDriver after "Reiniciar demo" or world.destroy:
//     the second pass and the listings of the Memory purge, up to 10 minutes (docs/architecture.md §9.3),
//     hence Lambda's maximum timeout. Its resource policy names those two roles; within one account an
//     identity policy alone also invokes, so the fence that counts is that no other role of the app
//     holds lambda:InvokeFunction on it (infra/iam-capabilities.ts).
//   - The nightly reset of judge worlds idle for 24 real hours, at 04:00 America/Mexico_City
//     (docs/architecture.md §8): an EventBridge rule on the default bus (`sst.aws.Cron`),
//     cron(0 10 * * ? *) in UTC, since Mexico City keeps UTC−6 all year (no daylight saving time
//     since 2022). A rule and not a Scheduler schedule: the CI deploy role creates rules tagged with
//     the app (CreateTaggedAsThisApp), while schedules carry no tags and are created only by the code,
//     inside the group above. The Cron's permission (`events.amazonaws.com`, the rule as SourceArn) is
//     the rest of the resource policy.
//
// Cost: per schedule invocation and per Lambda run; nothing bills while every world is paused.
//
// Verify:
//   aws --profile craftech-demos scheduler get-schedule-group --name aws-cds-hackathon-poc-cuadrilla-poc-schedules
//   aws --profile craftech-demos scheduler list-schedules --group-name aws-cds-hackathon-poc-cuadrilla-poc-schedules
//     → empty while every world is PAUSED
//   aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-cuadrilla-poc-SchedulerInvocation
//     → Path /aws-cds-hackathon-poc-cuadrilla/, PermissionsBoundary …-ci-boundary, trust scheduler.amazonaws.com
//       with aws:SourceAccount and the group as aws:SourceArn
//   aws --profile craftech-demos lambda get-policy --function-name <ScheduleDispatch name>   → the invocation role
//   aws --profile craftech-demos lambda get-policy --function-name <WorldJanitor name>
//     → events.amazonaws.com from the nightly rule, and the Bff and QaDriver roles
//   aws --profile craftech-demos events list-rule-names-by-target --target-arn <WorldJanitor ARN>
//     → the nightly rule, ScheduleExpression cron(0 10 * * ? *)

import { CAPABILITIES, IAM_ARNS, type LambdaName } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import { BrandConfig, SeedOverrides, SessionTokenKey } from "./secrets";
import { mediaBucket, seedBucket, storageLinks, storagePermissions } from "./storage";
import { InstallerEvents, conditionsOf, lateCall, lateModule, storageGrantPermissions } from "./workers";

export const SCHEDULER_SERVICE = "scheduler.amazonaws.com";

/** The group every timer schedule of the stage lives in (docs/architecture.md §1 and §8). */
export function scheduleGroupName(app: string, stage: string): string {
  return `${app}-${stage}-schedules`;
}

/** The role every timer schedule of the stage runs with; its name is what IAM_ARNS.schedulerRole matches. */
export function schedulerInvocationRoleName(app: string, stage: string): string {
  return `${app}-${stage}-SchedulerInvocation`;
}

/** Lambda entries; each file belongs to the WP that writes the code (docs/build-plan.md §2). */
export const SCHEDULER_HANDLERS = {
  ScheduleDispatch: "packages/bff/src/handlers/schedule-dispatch.handler", // WP-33
  WorldJanitor: "packages/bff/src/handlers/world-janitor.handler", // WP-39
} as const satisfies Partial<Record<LambdaName, string>>;

export const SCHEDULE_DISPATCH = { timeoutSeconds: 30, memoryMb: 256 } as const;

export const WORLD_JANITOR = {
  /** The Memory purge may list for 10 minutes after its 60-second second pass (docs/architecture.md §9.3). */
  timeoutSeconds: 15 * 60,
  // Reloads world templates from Seed and rewrites every item of a world.
  memoryMb: 512,
  /** 04:00 America/Mexico_City = 10:00 UTC all year; EventBridge rules run in UTC. */
  nightlySchedule: "cron(0 10 * * ? *)",
  /** Input of the nightly run (packages/bff/src/handlers/world-janitor.ts validates it with zod, WP-39). */
  nightlyEvent: { kind: "IDLE_JUDGE_RESET" },
} as const;

/** Callers of the asynchronous MEMORY_PURGE, by the export of infra/bff.ts (WP-38) that creates each one. */
export const MEMORY_PURGE_INVOKERS = { Bff: "bff", QaDriver: "qaDriver" } as const satisfies Partial<Record<LambdaName, string>>;

/**
 * Linkables of modules another work package builds, taken late (infra/late-links.ts, mode `optional`):
 * `Memory`, with `Resource.Memory.*` and exactly MEMORY_ADMIN on the stage's Memory (WP-26). The mocks'
 * tables and their statement fenced by dynamodb:LeadingKeys come from `mockLinks`/`mockPermissions` of
 * infra/mocks.ts (LATE_CALLS of infra/workers.ts).
 */
export const JANITOR_LATE_LINKS = { agentcore: ["Memory"] } as const;

/** Trust of the invocation role: the Scheduler of this account, for schedules of this group only. */
export function schedulerTrustDocument(accountId: string, groupArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: SCHEDULER_SERVICE },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": accountId, "aws:SourceArn": groupArn } },
      },
    ],
  };
}

/** The invocation role's only permission (SERVICE_ROLES.SchedulerInvocation). */
export function schedulerInvokeDocument(targetArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "InvokeScheduleDispatchOnly", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [targetArn] }],
  };
}

const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

// ---- Timers ----------------------------------------------------------------------------------------

export const scheduleGroup = new aws.scheduler.ScheduleGroup("Schedules", { name: scheduleGroupName($app.name, $app.stage) });

export const scheduleDispatch = new sst.aws.Function("ScheduleDispatch", {
  description: "Target of every timer schedule: re-reads the timer's version and enqueues TIMER in its installer's group.",
  handler: SCHEDULER_HANDLERS.ScheduleDispatch,
  timeout: `${SCHEDULE_DISPATCH.timeoutSeconds} seconds`,
  memory: `${SCHEDULE_DISPATCH.memoryMb} MB`,
  link: [...storageLinks("ScheduleDispatch"), InstallerEvents],
  permissions: storagePermissions("ScheduleDispatch"),
});

export const schedulerInvocationRole = new aws.iam.Role("SchedulerInvocationRole", {
  name: schedulerInvocationRoleName($app.name, $app.stage),
  description: "Assumed by EventBridge Scheduler for the timer schedules of the app's group; invokes ScheduleDispatch only.",
  assumeRolePolicy: $util.all([accountId, scheduleGroup.arn]).apply(([account, groupArn]) => JSON.stringify(schedulerTrustDocument(account, groupArn))),
});

export const schedulerInvocationPolicy = new aws.iam.RolePolicy("SchedulerInvocationPolicy", {
  role: schedulerInvocationRole.id,
  policy: scheduleDispatch.arn.apply((arn) => JSON.stringify(schedulerInvokeDocument(arn))),
});

/** Resource policy of ScheduleDispatch: the invocation role, the only invoker the app declares. */
export const scheduleDispatchInvoke = new aws.lambda.Permission("ScheduleDispatchInvokedByScheduler", {
  action: "lambda:InvokeFunction",
  function: scheduleDispatch.name,
  principal: schedulerInvocationRole.arn,
});

const groupSchedules = $interpolate`arn:aws:scheduler:${region}:${accountId}:schedule/${scheduleGroup.name}/*`;

/** The resources of CAPABILITIES.TIMERS, bound to the group and the role this module creates. */
const TIMER_RESOURCES: Readonly<Record<string, $util.Output<string>>> = {
  [IAM_ARNS.schedules]: groupSchedules,
  [IAM_ARNS.schedulerRole]: schedulerInvocationRole.arn,
};

/** Capability TIMERS: `Resource.Scheduler.{groupName, roleArn, targetArn}` and exactly its grants. */
export const Scheduler = new sst.Linkable("Scheduler", {
  properties: {
    groupName: scheduleGroup.name,
    roleArn: schedulerInvocationRole.arn,
    targetArn: scheduleDispatch.arn,
  },
  include: CAPABILITIES.TIMERS.grants.map((grant) =>
    sst.aws.permission({
      actions: [...grant.actions],
      resources: grant.resources.map((resource) => {
        const bound = TIMER_RESOURCES[resource];
        if (bound === undefined) throw new Error(`TIMERS names ${resource}, which infra/scheduler.ts does not create.`);
        return bound;
      }),
      ...conditionsOf(grant.conditions),
    }),
  ),
});

// ---- WorldJanitor ----------------------------------------------------------------------------------

const JANITOR: LambdaName = "WorldJanitor";

export const worldJanitor = new sst.aws.Function(JANITOR, {
  description: "Continues the Memory purge of a reset or destroyed world (MEMORY_PURGE) and resets idle judge worlds nightly.",
  handler: SCHEDULER_HANDLERS.WorldJanitor,
  timeout: `${WORLD_JANITOR.timeoutSeconds} seconds`,
  memory: `${WORLD_JANITOR.memoryMb} MB`,
  link: links(
    // WORLDS: its tables, Seed (templates) and Media (simulator media) by name, the timers, the key that
    // derives a new epoch's hashes, the live world it must never touch and the brand of the worlds.
    [...storageLinks(JANITOR), seedBucket, mediaBucket, Scheduler, SessionTokenKey, SeedOverrides, BrandConfig],
    lateLinks("scheduler", "agentcore", () => lateModule("agentcore"), JANITOR_LATE_LINKS.agentcore, "optional"),
    // The mocks' tables, by name only.
    lateCall("scheduler", "mocks", "mockLinks", JANITOR),
  ),
  // Its tables, WORLDS's objects (Seed templates, simulator media) and the mocks' tables of judge worlds.
  permissions: $util
    .all([storagePermissions(JANITOR), storageGrantPermissions(JANITOR), lateCall("scheduler", "mocks", "mockPermissions", JANITOR)])
    .apply((parts) => parts.flat() as Array<{ actions: string[]; resources: string[] }>),
});

export const worldJanitorNightly = new sst.aws.Cron("WorldJanitorNightly", {
  function: worldJanitor.arn,
  schedule: WORLD_JANITOR.nightlySchedule,
  event: WORLD_JANITOR.nightlyEvent,
});

/**
 * Resource policy of WorldJanitor for MEMORY_PURGE: one permission per calling role. infra/bff.ts
 * (WP-38) creates both callers and is evaluated after this module, so they are resolved late; until it
 * exports them the deploy warns and the policy names only the nightly rule.
 */
export const worldJanitorPurgeInvokers = $util.output(
  import("./bff").then((module) =>
    (Object.entries(MEMORY_PURGE_INVOKERS) as Array<[string, string]>).flatMap(([caller, exportName]) => {
      const created: unknown = Reflect.get(module, exportName);
      if (!(created instanceof sst.aws.Function)) {
        $util.log.warn(`infra/bff.ts exports no ${exportName} yet: WorldJanitor's resource policy does not name the ${caller} role.`);
        return [];
      }
      return [
        new aws.lambda.Permission(`WorldJanitorPurgeBy${caller}`, {
          action: "lambda:InvokeFunction",
          function: worldJanitor.name,
          principal: created.nodes.role.arn,
        }),
      ];
    }),
  ),
);
