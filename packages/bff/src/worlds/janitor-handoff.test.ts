// What the console's reset and jump hand to `WorldJanitor` instead of doing in the request (W4 review,
// security B2): the whole Memory purge (`MEMORY_PURGE` with `fromPass: 1`) and the historical certificates'
// PDFs (`RENDER_CERTIFICATES`), both asynchronous; and the janitor's side of the second.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import { GUEST_TEST_CLOCK_ID, GUEST_TEST_ISP_ID } from "@cuadrilla/shared";
import { handleWorldJanitor } from "../handlers/world-janitor";
import { factoryDepsOf } from "./deps";
import { buildWorld } from "./factory";
import { janitorCertificates, janitorPurge } from "./stage";
import { worldsHarness } from "./testing";

const lambda = mockClient(LambdaClient);
afterEach(() => lambda.reset());

const payloadOf = (call: number): Record<string, unknown> => {
  const input = lambda.commandCalls(InvokeCommand)[call]?.args[0].input;
  expect(input).toMatchObject({ FunctionName: "world-janitor", InvocationType: "Event" });
  return JSON.parse(new TextDecoder().decode(input?.Payload as Uint8Array)) as Record<string, unknown>;
};

describe("hand-offs to WorldJanitor", () => {
  it("sends the whole purge with fromPass 1 and the certificates of the reloaded world, asynchronously", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 202 });
    const target = { clockId: GUEST_TEST_CLOCK_ID, epoch: 3, actorIds: ["inst-rogelio-gtest-e3"], sessions: [], startedAtReal: "2026-10-06T15:00:00.000Z" };
    await janitorPurge(() => "world-janitor")(target, 1);
    expect(payloadOf(0)).toEqual({ kind: "MEMORY_PURGE", ...target, fromPass: 1 });
    expect(await janitorCertificates(() => "world-janitor").render({ clockId: GUEST_TEST_CLOCK_ID, ispId: GUEST_TEST_ISP_ID }, "PENDING")).toBe(0);
    expect(payloadOf(1)).toEqual({ kind: "RENDER_CERTIFICATES", clockId: GUEST_TEST_CLOCK_ID });
  });

  it("a hand-off WorldJanitor did not accept throws (the reset stops before deleting anything)", async () => {
    lambda.on(InvokeCommand).resolves({ StatusCode: 500 });
    await expect(janitorPurge(() => "world-janitor")({ clockId: GUEST_TEST_CLOCK_ID, epoch: 1, actorIds: [], sessions: [], startedAtReal: "2026-10-06T15:00:00.000Z" }, 1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("WorldJanitor renders the pending historical certificates of a guest world, never of a QA world", async () => {
    const harness = worldsHarness();
    await buildWorld(factoryDepsOf(harness.deps), { ispId: GUEST_TEST_ISP_ID, origin: "TEST" });
    const janitor = { worlds: () => harness.deps, log: harness.deps.log, sleep: async () => undefined };
    expect(await handleWorldJanitor(janitor, { kind: "RENDER_CERTIFICATES", clockId: GUEST_TEST_CLOCK_ID })).toMatchObject({ kind: "RENDER_CERTIFICATES", complete: true });
    expect(harness.pdfs.size).toBeGreaterThan(0);
    const pending = harness.client.dump("WorkOrders").filter((row) => row.entity === "Certificate" && row.clockId === GUEST_TEST_CLOCK_ID && row.pdfPending === true);
    expect(pending).toEqual([]);
    await expect(handleWorldJanitor(janitor, { kind: "RENDER_CERTIFICATES", clockId: "qa-31-sc-18" })).rejects.toThrow();
  });
});
