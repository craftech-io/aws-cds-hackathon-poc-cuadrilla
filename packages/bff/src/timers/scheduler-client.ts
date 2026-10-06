/// <reference path="../../sst-env.d.ts" />
// The one EventBridge Scheduler client of the stage (ADR-0004, docs/architecture.md §8): every timer of
// a RUNNING world has at most one one-time schedule `tm-<w>-<hash>` in the group of the stage,
// `at(<dueAtReal UTC>)`, `FlexibleTimeWindow OFF`, `ActionAfterCompletion DELETE`, target
// `ScheduleDispatch` with the invocation role of infra/scheduler.ts and the timer's
// `ScheduleDispatchPayload`. Group, role and target come from the linked `Scheduler` (capability
// TIMERS, `Resource`, never `process.env`).
//
// Create, update and delete are idempotent: creating an existing schedule updates it, deleting a
// missing one is a no-op, so a retried move never fails half way. Every call has the SDK's timeout
// (lib/clients.ts) and a retry with backoff on throttling and 5xx; the rest maps to a typed
// `ConnectorError` (`UNAVAILABLE` is retryable upstream, `VALIDATION` is a bug).
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { z } from "zod";
import { ConnectorError } from "@cuadrilla/shared";
import { ScheduleDispatchPayload } from "../agent-tools/common/ports";
import { CLIENT_TIMEOUTS, awsClientConfig } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { atExpression } from "./schedule";

/** One schedule per timer: what the code asks the Scheduler for. */
export interface ScheduleSpec {
  readonly name: string;
  /** Real instant the schedule fires at (`dueAtSim − offsetMs`, rounded up to the second). */
  readonly at: Date;
  readonly input: ScheduleDispatchPayload;
}

export interface SchedulerPort {
  /** Creates the schedule, or moves it when it already exists. */
  put(spec: ScheduleSpec): Promise<void>;
  /** Deletes the schedule; one that is already gone (fired or never created) is fine. */
  delete(name: string): Promise<void>;
}

/** `Resource.Scheduler` (infra/scheduler.ts). */
export const SchedulerLink = z.object({ groupName: z.string().min(1), roleArn: z.string().startsWith("arn:aws:"), targetArn: z.string().startsWith("arn:aws:") });
export type SchedulerLink = z.infer<typeof SchedulerLink>;

const RETRYABLE: ReadonlySet<string> = new Set(["ThrottlingException", "InternalServerException", "ServiceQuotaExceededException"]);

function nameOf(error: unknown): string {
  return (error as { name?: unknown } | undefined)?.name?.toString() ?? "";
}

function mapped(error: unknown, what: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = nameOf(error);
  if (name === "ValidationException") return new ConnectorError("VALIDATION", `${what}: the Scheduler refused the request`, "Scheduler", { cause: error });
  if (name === "TimeoutError" || name === "AbortError") return new ConnectorError("TIMEOUT", `${what}: the Scheduler did not answer`, "Scheduler", { cause: error });
  if (RETRYABLE.has(name)) return new ConnectorError("THROTTLED", `${what}: the Scheduler is busy`, "Scheduler", { cause: error });
  return new ConnectorError("UNAVAILABLE", `${what}: the Scheduler failed`, "Scheduler", { cause: error });
}

export interface EventBridgeSchedulerOptions {
  readonly link?: () => SchedulerLink;
  readonly client?: Pick<SchedulerClient, "send">;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The production `SchedulerPort` over `@aws-sdk/client-scheduler`; the client is created on first use. */
export function eventBridgeScheduler(options: EventBridgeSchedulerOptions = {}): SchedulerPort {
  const link = options.link ?? (() => readLinked("Scheduler", SchedulerLink));
  let client = options.client;
  const scheduler = (): Pick<SchedulerClient, "send"> => (client ??= new SchedulerClient(awsClientConfig(CLIENT_TIMEOUTS.scheduler)));

  async function call(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await withRetry(run, { attempts: 3, ...(options.sleep ? { sleep: options.sleep } : {}), shouldRetry: (error) => RETRYABLE.has(nameOf(error)) });
    } catch (error) {
      throw mapped(error, what);
    }
  }

  function request(spec: ScheduleSpec) {
    const { groupName, roleArn, targetArn } = link();
    return {
      Name: spec.name,
      GroupName: groupName,
      ScheduleExpression: atExpression(spec.at),
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" as const },
      ActionAfterCompletion: "DELETE" as const,
      State: "ENABLED" as const,
      Target: { Arn: targetArn, RoleArn: roleArn, Input: JSON.stringify(ScheduleDispatchPayload.parse(spec.input)), RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 } },
    };
  }

  return {
    async put(spec) {
      await call(`schedule ${spec.name}`, async () => {
        try {
          await scheduler().send(new CreateScheduleCommand(request(spec)));
        } catch (error) {
          if (!(error instanceof ConflictException) && nameOf(error) !== "ConflictException") throw error;
          await scheduler().send(new UpdateScheduleCommand(request(spec)));
        }
      });
    },

    async delete(name) {
      await call(`delete schedule ${name}`, async () => {
        try {
          await scheduler().send(new DeleteScheduleCommand({ Name: name, GroupName: link().groupName }));
        } catch (error) {
          if (!(error instanceof ResourceNotFoundException) && nameOf(error) !== "ResourceNotFoundException") throw error;
        }
      });
    },
  };
}
