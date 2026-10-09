import { describe, expect, it } from "vitest";
import { DEMO_CLOCK_ID } from "@cuadrilla/shared";
import { POLICY_AUDIT } from "../../../../infra/observability-spec";
import { worldsOf } from "./policy-audit";

describe("PolicyAudit event contract", () => {
  it("audits the demo world on the daily rule's input and on a bare scheduled event", () => {
    expect(worldsOf({ ...POLICY_AUDIT.event })).toEqual([DEMO_CLOCK_ID]);
    expect(worldsOf({ source: "aws.events", "detail-type": "Scheduled Event" })).toEqual([DEMO_CLOCK_ID]);
  });

  it("audits the worlds the QaDriver names", () => {
    expect(worldsOf({ clockId: DEMO_CLOCK_ID })).toEqual([DEMO_CLOCK_ID]);
    expect(worldsOf({ clockIds: [DEMO_CLOCK_ID] })).toEqual([DEMO_CLOCK_ID]);
  });

  it("refuses anything else", () => {
    expect(worldsOf({ kind: "NIGHTLY" })).toBeUndefined();
    expect(worldsOf({ clockIds: [] })).toBeUndefined();
    expect(worldsOf({ clockId: DEMO_CLOCK_ID, extra: true })).toBeUndefined();
  });
});
