import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAMBDA_CAPABILITIES, type LambdaName, expectedGrants, resolveCapabilities } from "./iam-capabilities";
import { linkNameOnly, nameOnly } from "./storage-access";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("links of tables and buckets [SEC-W1-01]", () => {
  it("wraps sst.aws.Dynamo and sst.aws.Bucket so a link carries the name and no include", () => {
    class Dynamo {}
    class Bucket {}
    const wrap = vi.fn();
    vi.stubGlobal("sst", { Linkable: { wrap }, aws: { Dynamo, Bucket } });
    linkNameOnly();
    expect(wrap.mock.calls.map(([cls]) => cls)).toEqual([Dynamo, Bucket]);
    for (const [, definition] of wrap.mock.calls) {
      const link = (definition as typeof nameOnly)({ name: "physical-name", arn: "arn:aws:dynamodb:us-east-1:1:table/x" } as { name: string });
      expect(link).toEqual({ properties: { name: "physical-name" } });
      expect(link).not.toHaveProperty("include");
    }
  });

  it("is called by sst.config.ts before any infra module is imported", () => {
    const config = readFileSync(resolve(process.cwd(), "sst.config.ts"), "utf8");
    const call = config.indexOf("linkNameOnly();");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(config.indexOf('await import("./infra/tags")'));
    expect(call).toBeLessThan(config.indexOf('await import("./infra/storage")'));
  });
});

describe("SEND_EMAIL / SEND_WHATSAPP attachments", () => {
  it("[FL-048] every role that sends the certificate reads it in every world, the guest worlds' prefix included", () => {
    const senders = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((role) => resolveCapabilities(LAMBDA_CAPABILITIES[role].capabilities).includes("SEND_EMAIL"));
    expect(senders).toContain("InstallerWorker");
    for (const role of senders) {
      const reads = expectedGrants(role).filter((grant) => grant.actions.includes("s3:GetObject")).flatMap((grant) => grant.resources);
      expect(reads, role).toEqual(expect.arrayContaining(["{Evidence}/certificates/*", "{Evidence}/guest/*/certificates/*"]));
    }
  });
});
