import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { s3ObjectStore, s3TemplateSource } from "./sources";
import { readTemplate } from "./template";

const TEXT = '{"tables":{}}';
const SHA = createHash("sha256").update(TEXT, "utf8").digest("hex");

// The functions that use these sources link `WorldTemplates` and never the buckets themselves
// (fenced grants): any other resource name throws, as SST's Resource does.
vi.mock("sst", () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, name) {
        if (name === "WorldTemplates") {
          return {
            templates: { guest: { key: "worlds/guest.json", sha256: "0".repeat(64) } },
            buckets: { Seed: "app-seed", Media: "app-media", Evidence: "app-evidence" },
          };
        }
        throw new Error(`${String(name)} is not linked to this function`);
      },
    },
  ),
}));

type Sent = { readonly input: Record<string, unknown> };

describe("world sources over the WorldTemplates link [FL-105] [FL-118]", () => {
  it("[FL-105] reads the guest template from the Seed bucket named by the link, without the bucket linked", async () => {
    const sent: Sent[] = [];
    const sender = { send: async (command: Sent) => (sent.push(command), { Body: { transformToString: async () => TEXT } }) };
    const source = s3TemplateSource(sender as never);
    expect(source.locate("guest")).toEqual({ key: "worlds/guest.json", sha256: "0".repeat(64) });
    await expect(readTemplate({ locate: () => ({ key: "worlds/guest.json", sha256: SHA }), read: source.read })).resolves.toBe(TEXT);
    expect(sent[0]?.input).toEqual({ Bucket: "app-seed", Key: "worlds/guest.json" });
  });

  it("[FL-118] empties a guest/ prefix of Media and Evidence by the names of the link", async () => {
    const sent: Sent[] = [];
    const sender = {
      send: async (command: Sent) => {
        sent.push(command);
        return "Prefix" in command.input ? { Contents: [{ Key: `${String(command.input.Prefix)}a.jpg` }], IsTruncated: false } : {};
      },
    };
    const store = s3ObjectStore(sender as never);
    expect(await store.deletePrefix("Evidence", "guest/s261006abcde/")).toBe(1);
    expect(await store.deletePrefix("Media", "guest/s261006abcde/")).toBe(1);
    expect(sent.map((command) => command.input.Bucket)).toEqual(["app-evidence", "app-evidence", "app-media", "app-media"]);
    await expect(store.deletePrefix("Media", "sim/")).rejects.toThrow(RangeError);
  });
});
