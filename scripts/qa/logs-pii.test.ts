import { describe, expect, it } from "vitest";
import { countMatches, literalPattern, logGroupOf } from "./logs-pii";

describe("qa:logs-pii", () => {
  it("[FL-116] searches the group the function writes to, not /aws/lambda/<function>", async () => {
    const lambda = { send: async () => ({ LoggingConfig: { LogGroup: "/aws/lambda/app-BffFunction-abc" } }) };
    expect(await logGroupOf(lambda as never, "app-BffFunction-xyz")).toBe("/aws/lambda/app-BffFunction-abc");
    const bare = { send: async () => ({}) };
    expect(await logGroupOf(bare as never, "fn")).toBe("/aws/lambda/fn");
  });

  it("[FL-116] a missing log group is never counted as zero matches", async () => {
    const missing = {
      send: async () => {
        throw Object.assign(new Error("gone"), { name: "ResourceNotFoundException" });
      },
    };
    expect(await countMatches(missing as never, "/aws/lambda/none", "simulator.amazonses.com", 0)).toBeUndefined();
    const pages = [{ events: [{}, {}], nextToken: "n" }, { events: [{}] }];
    const found = { send: async () => pages.shift() };
    expect(await countMatches(found as never, "/aws/lambda/g", "qa-run", 0)).toBe(3);
  });

  it("[FL-116] quotes the term as a literal filter", () => {
    expect(literalPattern('a"b')).toBe('"a\\"b"');
  });
});
