// `channels:waba-event-destination` (docs/pending.md P-01 step 7, docs/test-plan.md §3): the topic comes
// from the WABA's own ARN, a WABA with another destination or other numbers is never touched (not even
// with --apply), a WABA already pointing at our topic is left alone, and nothing is written without --apply.
import { describe, expect, it } from "vitest";
import { type DestinationDeps, DestinationRefused, TOPIC_NAME, parseDestinationArgs, runDestination, topicArnFor } from "./waba-event-destination";

const WABA_ARN = "arn:aws:social-messaging:us-east-1:776805327629:waba/0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const TOPIC_ARN = `arn:aws:sns:us-east-1:776805327629:${TOPIC_NAME}`;
const OURS = `phone-number-id-${"a1".repeat(16)}`;
const THEIRS = `phone-number-id-${"b2".repeat(16)}`;

function deps(fixture: { readonly destinations?: string[]; readonly numbers?: string[]; readonly connected?: boolean } = {}) {
  const puts: string[] = [];
  const ports: DestinationDeps = {
    get: async () => ({ arn: WABA_ARN, eventDestinations: fixture.destinations ?? [], phoneNumberIds: fixture.numbers ?? [OURS] }),
    put: async (_id, topicArn) => void puts.push(topicArn),
    connection: () => (fixture.connected === false ? undefined : { wabaId: "waba-0001", phoneNumberId: OURS }),
    report: () => undefined,
  };
  return { ports, puts };
}

describe("channels:waba-event-destination", () => {
  it("derives the topic from the WABA's ARN and requires --stage poc", () => {
    expect(topicArnFor(WABA_ARN)).toBe(TOPIC_ARN);
    expect(() => topicArnFor("arn:aws:sns:us-east-1:776805327629:other")).toThrow(RangeError);
    expect(() => parseDestinationArgs(["--apply"])).toThrow(/--stage poc/);
  });

  it("aborts without --apply and with it when the WABA has another destination", async () => {
    for (const argv of [["--stage", "poc"], ["--stage", "poc", "--apply"]]) {
      const other = deps({ destinations: ["arn:aws:sns:us-east-1:776805327629:another-app-wa-inbound"] });
      await expect(runDestination(parseDestinationArgs(argv), other.ports)).rejects.toMatchObject({ reason: "OTHER_DESTINATION" });
      expect(other.puts).toEqual([]);
      const both = deps({ destinations: [TOPIC_ARN, "arn:aws:sns:us-east-1:776805327629:another-app-wa-inbound"] });
      await expect(runDestination(parseDestinationArgs(argv), both.ports)).rejects.toBeInstanceOf(DestinationRefused);
      expect(both.puts).toEqual([]);
    }
  });

  it("aborts without --apply and with it when the WABA has other numbers, or not ours", async () => {
    for (const argv of [["--stage", "poc"], ["--stage", "poc", "--apply"]]) {
      const shared = deps({ numbers: [OURS, THEIRS] });
      await expect(runDestination(parseDestinationArgs(argv), shared.ports)).rejects.toMatchObject({ reason: "OTHER_NUMBERS" });
      expect(shared.puts).toEqual([]);
      const foreign = deps({ numbers: [THEIRS] });
      await expect(runDestination(parseDestinationArgs(argv), foreign.ports)).rejects.toMatchObject({ reason: "OTHER_NUMBERS" });
    }
  });

  it("is idempotent and writes only with --apply", async () => {
    expect(await runDestination({ apply: true }, deps({ destinations: [TOPIC_ARN] }).ports)).toBe("ALREADY_SET");
    const plan = deps();
    expect(await runDestination(parseDestinationArgs(["--stage", "poc"]), plan.ports)).toBe("WOULD_SET");
    expect(plan.puts).toEqual([]);
    const apply = deps();
    expect(await runDestination(parseDestinationArgs(["--stage", "poc", "--apply"]), apply.ports)).toBe("SET");
    expect(apply.puts).toEqual([TOPIC_ARN]);
    await expect(runDestination({ apply: true }, deps({ connected: false }).ports)).rejects.toThrow(/P-01/);
  });
});
