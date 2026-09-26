import type { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { faultsKey, mayHaveFaults, runtimeFaultReader } from "./faults";

function getter(item: Record<string, unknown> | undefined) {
  const send = vi.fn(async (_command: GetCommand) => (item === undefined ? {} : { Item: item }));
  return { send };
}

describe("[FL-026] faults of a world", () => {
  it("[FL-026] exist only for qa-* clocks", () => {
    expect(mayHaveFaults("qa-812-1-sc-02")).toBe(true);
    expect(mayHaveFaults("qa-local-01J9ZQX-sc04-dup")).toBe(true);
    for (const clockId of ["GLOBAL#isp-demo", "GUEST#isp-guest-07", "GUEST#isp-guest-test", "eval-812-1", "qa-", "nonsense"]) expect(mayHaveFaults(clockId)).toBe(false);
  });

  it("[FL-026] reads the network attribute of Runtime/FAULTS#<clockId>", async () => {
    const client = getter({ ...faultsKey("qa-812-1-sc-02"), network: "ERROR_503", knowledge: "TIMEOUT" });
    const reader = runtimeFaultReader(client, () => "Runtime");
    expect(await reader.networkFault("qa-812-1-sc-02")).toBe("ERROR_503");
    expect(client.send.mock.calls[0]?.[0].input).toEqual({ TableName: "Runtime", Key: { PK: "FAULTS#qa-812-1-sc-02", SK: "META" } });
  });

  it("[FL-026] has no fault when the item or its network attribute is absent, and rejects an unknown fault", async () => {
    expect(await runtimeFaultReader(getter(undefined), () => "Runtime").networkFault("qa-812-1-sc-02")).toBeUndefined();
    expect(await runtimeFaultReader(getter({ knowledge: "TIMEOUT" }), () => "Runtime").networkFault("qa-812-1-sc-02")).toBeUndefined();
    await expect(runtimeFaultReader(getter({ network: "MELTDOWN" }), () => "Runtime").networkFault("qa-812-1-sc-02")).rejects.toThrow();
  });
});
