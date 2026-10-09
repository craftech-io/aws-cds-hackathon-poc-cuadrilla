// The Memory purge in passes (docs/architecture.md §9.3, FL-086): first pass in the call, second at 60 s,
// listings every 15 s until two come back empty, a 10-minute cap with `MEMORY_PURGE_INCOMPLETE`, only
// actors of the world and epoch it names; over a reset, a destruction, `WorldJanitor` and the deletion of
// a sign-up account.
import { describe, expect, it } from "vitest";
import { GUEST_TEST_CLOCK_ID, GUEST_TEST_ISP_ID } from "@cuadrilla/shared";
import { handleWorldJanitor } from "../handlers/world-janitor";
import { createLogger } from "../lib/log";
import { runtimeSessionId } from "../lib/crypto";
import { factoryDepsOf } from "./deps";
import { buildWorld } from "./factory";
import { destroyGeneration } from "./guest-lifecycle";
import { MEMORY_PURGE_INCOMPLETE_METRIC, type MemoryAdmin, PURGE_TIMING, PurgeBudgetExceeded, type PurgeDeps, actorBelongsTo, purgeAllPasses, purgeFirstPass, purgeRemainingPasses } from "./memory-purge";
import { purgeTargetOf, scopeOfWorld } from "./memory-targets";
import { resetWorld } from "./rebuild";
import { FakeMemory, RUNTIME_SESSION_KEY, SIGNUP_CLOCK, SIGNUP_ISP, SIGNUP_USER, worldsHarness } from "./testing";

const ACTOR = "inst-rogelio-gtest-e1";

/** A clock that only moves when the purge sleeps, and a Memory that keeps extracting for `late` sleeps. */
function timedPurge(memory: FakeMemory, options: { readonly late?: number } = {}) {
  let nowMs = Date.parse("2026-10-06T15:00:00.000Z");
  const sleeps: number[] = [];
  const lines: string[] = [];
  const audits: unknown[] = [];
  let extracted = 0;
  const deps: PurgeDeps = {
    memory,
    data: { audit: { append: async (input: unknown) => void audits.push(input) } as unknown as PurgeDeps["data"]["audit"] },
    log: createLogger({ sink: (line) => void lines.push(line) }),
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
      if (extracted < (options.late ?? 0)) memory.addRecord(ACTOR, `late-${(extracted += 1)}`);
    },
  };
  return { deps, sleeps, lines, audits };
}

const TARGET = { clockId: GUEST_TEST_CLOCK_ID, epoch: 1, actorIds: [ACTOR], sessions: [{ actorId: ACTOR, sessionId: "session-1" }] };

describe("[FL-086] Memory purge in passes", () => {
  it("[FL-086] deletes events and records in pass 1, again at 60 s, and stops after two empty listings 15 s apart", async () => {
    const memory = new FakeMemory();
    memory.addEvent(ACTOR, "session-1", "event-1");
    memory.addEvent(ACTOR, "session-other", "event-2");
    memory.addRecord(ACTOR, "record-1");
    memory.addRecord("inst-rogelio-gtest-e2", "record-new-epoch");
    const purge = timedPurge(memory, { late: 1 });
    const outcome = await purgeAllPasses(purge.deps, TARGET);
    expect(outcome).toMatchObject({ complete: true, deleted: 4 });
    expect(purge.sleeps).toEqual([PURGE_TIMING.secondPassAfterMs, PURGE_TIMING.listingEveryMs, PURGE_TIMING.listingEveryMs]);
    expect(memory.eventsOf(ACTOR)).toBe(0);
    expect(memory.recordsOf(ACTOR)).toBe(0);
    expect(memory.recordsOf("inst-rogelio-gtest-e2")).toBe(1);
  });

  it("[FL-086] audits MEMORY_PURGE_INCOMPLETE and logs its metric when records keep coming for 10 minutes", async () => {
    // The strategies keep extracting: every listing finds a record that was not there before.
    class ExtractingMemory extends FakeMemory {
      private next = 0;
      override async listRecordIds(prefix: string): Promise<string[]> {
        this.addRecord(ACTOR, `extracted-${(this.next += 1)}`);
        return super.listRecordIds(prefix);
      }
    }
    const memory = new ExtractingMemory();
    const purge = timedPurge(memory);
    const outcome = await purgeAllPasses(purge.deps, TARGET);
    expect(outcome.complete).toBe(false);
    expect(purge.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(PURGE_TIMING.capMs);
    expect(purge.audits).toEqual([expect.objectContaining({ action: "MEMORY_PURGE_INCOMPLETE", ispId: GUEST_TEST_ISP_ID, clockId: GUEST_TEST_CLOCK_ID })]);
    expect(purge.lines.some((line) => line.includes(MEMORY_PURGE_INCOMPLETE_METRIC))).toBe(true);
  });

  it("purges only actors of the world and epoch it names", async () => {
    expect(actorBelongsTo(GUEST_TEST_CLOCK_ID, 1, "inst-rogelio-gtest-e1")).toBe(true);
    expect(actorBelongsTo(GUEST_TEST_CLOCK_ID, 1, "inst-rogelio-g07-e1")).toBe(false);
    expect(actorBelongsTo(GUEST_TEST_CLOCK_ID, 2, "inst-rogelio-gtest-e1")).toBe(false);
    expect(actorBelongsTo("GLOBAL#isp-demo", 3, "inst-rogelio-e3")).toBe(true);
    expect(actorBelongsTo("GLOBAL#isp-demo", 3, "inst-qa-1-sc-02-a-e3")).toBe(false);
    expect(actorBelongsTo("qa-1-sc-02", 1, "inst-qa-1-sc-02-a-e1")).toBe(true);
    expect(actorBelongsTo("qa-1-sc-02", 1, "inst-qa-1-sc-03-a-e1")).toBe(false);
    const memory = new FakeMemory();
    await expect(purgeFirstPass({ memory, now: () => new Date() }, { ...TARGET, actorIds: ["inst-rogelio-g07-e1"] })).rejects.toThrow(/do not belong/);
    await expect(purgeRemainingPasses(timedPurge(memory).deps, { ...TARGET, actorIds: ["inst-rogelio-e1"], startedAtReal: new Date().toISOString() })).rejects.toThrow(/do not belong/);
  });
});

describe("[FL-086] purge of a reset world", () => {
  it("[FL-086] the old actor ends with 0 events and 0 records, also without ListSessions; the new actor is untouched", async () => {
    const harness = worldsHarness({ sessionListing: false });
    await buildWorld(factoryDepsOf(harness.deps), { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
    const session = runtimeSessionId(RUNTIME_SESSION_KEY, { kind: "WORK_ORDER", workOrderId: "wo-24817-gtest", clockId: GUEST_TEST_CLOCK_ID, worldEpoch: 1, sessionEpoch: 0 });
    const day = runtimeSessionId(RUNTIME_SESSION_KEY, { kind: "DAY", installerId: "inst-rogelio-gtest", simDate: "2026-10-13", clockId: GUEST_TEST_CLOCK_ID, worldEpoch: 1 });
    harness.memory.addEvent(ACTOR, session, "event-1");
    harness.memory.addEvent(ACTOR, day, "event-2");
    harness.memory.addRecord(ACTOR, "record-1");
    harness.memory.addRecord(ACTOR, "record-2", "preferences");
    harness.memory.addRecord("inst-rogelio-gtest-e2", "record-new");

    await resetWorld(harness.deps, { clockId: GUEST_TEST_CLOCK_ID, caller: "QA", actor: "QA" });
    // The whole purge goes to WorldJanitor, handed off before the items went: nothing slow in the request.
    expect(harness.memory.recordsOf(ACTOR)).toBe(2);
    expect(harness.purges).toHaveLength(1);
    const target = harness.purges[0];
    if (target === undefined) throw new Error("no purge target");
    expect(target).toMatchObject({ clockId: GUEST_TEST_CLOCK_ID, epoch: 1, fromPass: 1, actorIds: expect.arrayContaining([ACTOR]) });
    expect(target.sessions.map((entry) => entry.sessionId)).toEqual(expect.arrayContaining([session, day]));
    harness.memory.addRecord(ACTOR, "late-record");
    const outcome = await handleWorldJanitor({ worlds: () => harness.deps, log: harness.deps.log, sleep: async () => undefined }, { kind: "MEMORY_PURGE", ...target });
    expect(outcome).toMatchObject({ kind: "MEMORY_PURGE", complete: true });
    expect(harness.memory.eventsOf(ACTOR)).toBe(0);
    expect(harness.memory.recordsOf(ACTOR)).toBe(0);
    expect(harness.memory.recordsOf("inst-rogelio-gtest-e2")).toBe(1);
  });

  it("WorldJanitor refuses an event that is not one of its two", async () => {
    const harness = worldsHarness();
    await expect(handleWorldJanitor({ worlds: () => harness.deps, log: harness.deps.log, sleep: async () => undefined }, { kind: "MEMORY_PURGE", clockId: "GLOBAL#isp-demo" })).rejects.toThrow();
    await expect(handleWorldJanitor({ worlds: () => harness.deps, log: harness.deps.log, sleep: async () => undefined }, { kind: "DELETE_EVERYTHING" })).rejects.toThrow();
  });
});

describe("Memory of sign-up generations", () => {
  it("the deletion of an account purges the generation's actors before its items go", async () => {
    const harness = worldsHarness();
    await buildWorld(factoryDepsOf(harness.deps), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    const actor = "inst-rogelio-gs261001abcde-e1";
    harness.memory.addRecord(actor, "record-1");
    harness.memory.addRecord("inst-rogelio-gtest-e1", "record-other");
    const seen: number[] = [];
    await destroyGeneration(
      {
        ...harness.destroyDeps(),
        purgeMemory: async (clockId, epoch) => {
          const scope = await scopeOfWorld(harness.connector, { clockId, ispId: SIGNUP_ISP, epoch, startDate: "2026-10-13" });
          seen.push(scope.installerIds.length);
          await purgeFirstPass({ memory: harness.memory, now: harness.now }, purgeTargetOf(scope, RUNTIME_SESSION_KEY));
        },
      },
      SIGNUP_CLOCK,
    );
    expect(seen[0]).toBeGreaterThan(0);
    expect(harness.memory.recordsOf(actor)).toBe(0);
    expect(harness.memory.recordsOf("inst-rogelio-gtest-e1")).toBe(1);
  });

  it("[W4 review B4] after 20 epochs the deletion purges only the current one, a bounded number of Memory calls", async () => {
    const harness = worldsHarness();
    await buildWorld(factoryDepsOf(harness.deps), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    while ((await harness.connector.runtime.currentEpoch(SIGNUP_CLOCK)) < 20) await harness.connector.runtime.nextEpoch(SIGNUP_CLOCK);
    let calls = 0;
    const counted: MemoryAdmin = {
      listSessionIds: (actorId) => ((calls += 1), harness.memory.listSessionIds(actorId)),
      listEventIds: (actorId, sessionId) => ((calls += 1), harness.memory.listEventIds(actorId, sessionId)),
      deleteEvent: (actorId, sessionId, eventId) => ((calls += 1), harness.memory.deleteEvent(actorId, sessionId, eventId)),
      listRecordIds: (prefix) => ((calls += 1), harness.memory.listRecordIds(prefix)),
      deleteRecord: (recordId) => ((calls += 1), harness.memory.deleteRecord(recordId)),
      listRecordActors: () => ((calls += 1), harness.memory.listRecordActors()),
    };
    const epochs: number[] = [];
    let perEpoch = 0;
    await destroyGeneration(
      {
        ...harness.destroyDeps(),
        purgeMemory: async (clockId, epoch) => {
          epochs.push(epoch);
          const target = purgeTargetOf(await scopeOfWorld(harness.connector, { clockId, ispId: SIGNUP_ISP, epoch, startDate: "2026-10-13" }), RUNTIME_SESSION_KEY);
          perEpoch = target.actorIds.length * 2 + target.sessions.length;
          await purgeFirstPass({ memory: counted, now: harness.now }, target, 10_000);
        },
      },
      SIGNUP_CLOCK,
    );
    expect(epochs).toEqual([20]);
    expect(calls).toBeLessThanOrEqual(perEpoch);
  });

  it("[W4 review B4] a Memory purge that fails or runs out of its budget never holds back the destruction", async () => {
    const harness = worldsHarness();
    await buildWorld(factoryDepsOf(harness.deps), { ispId: SIGNUP_ISP, origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    const lines: string[] = [];
    const result = await destroyGeneration({ ...harness.destroyDeps(), purgeMemory: async () => Promise.reject(new Error("ThrottlingException")), log: createLogger({ sink: (line) => void lines.push(line) }) }, SIGNUP_CLOCK);
    expect(result.items).toBeGreaterThan(0);
    expect(await harness.connector.runtime.getClock(SIGNUP_CLOCK)).toBeUndefined();
    expect(lines.some((line) => line.includes(MEMORY_PURGE_INCOMPLETE_METRIC))).toBe(true);
    // The budget stops a pass between two calls; what is left goes at night.
    harness.memory.addRecord("inst-rogelio-gs261001abcde-e1", "record-1");
    await expect(purgeFirstPass({ memory: harness.memory, now: harness.now }, { clockId: SIGNUP_CLOCK, epoch: 1, actorIds: ["inst-rogelio-gs261001abcde-e1"], sessions: [] }, -1)).rejects.toBeInstanceOf(PurgeBudgetExceeded);
  });

  it("WorldJanitor purges at night the records of generations that expired, never of a living one", async () => {
    const harness = worldsHarness({ start: "2026-10-20T15:00:00.000Z" });
    // Living: built today. Expired: of 2026-10-01 (its items went by TTL on 2026-10-11), never built here.
    await buildWorld(factoryDepsOf(harness.deps), { ispId: "isp-guest-s261020abcde", origin: "SIGNUP", ownerUserId: SIGNUP_USER });
    harness.memory.addRecord("inst-rogelio-gs261020abcde-e1", "record-living");
    harness.memory.addRecord("inst-rogelio-gs261001zzzzz-e1", "record-expired");
    harness.memory.addRecord("inst-karina-gs261001zzzzz-e2", "record-expired-2");
    harness.memory.addRecord("inst-rogelio-g07-e1", "record-invited");
    const outcome = await handleWorldJanitor({ worlds: () => harness.deps, log: harness.deps.log, sleep: async () => undefined }, { kind: "IDLE_GUEST_RESET" });
    expect(outcome).toMatchObject({ kind: "IDLE_GUEST_RESET", purgedActors: 2 });
    expect(harness.memory.recordsOf("inst-rogelio-gs261001zzzzz-e1")).toBe(0);
    expect(harness.memory.recordsOf("inst-karina-gs261001zzzzz-e2")).toBe(0);
    expect(harness.memory.recordsOf("inst-rogelio-gs261020abcde-e1")).toBe(1);
    expect(harness.memory.recordsOf("inst-rogelio-g07-e1")).toBe(1);
  });
});
