import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NETWORK_OPERATIONS, OnuSerialParam, OnuStatus, OperState } from "@cuadrilla/network-contract";
import { OnuOperState } from "@cuadrilla/shared";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "../../packages/bff/src/lib/log";
import { createNetworkClient } from "../../packages/bff/src/network/client";
import { CLIENT_CONTRACT } from "../../packages/bff/src/network/contract";
import { InMemoryOnuStore, handleNetworkRequest, newOnuRow, onuKey, readsByReader } from "../../packages/network-mock/src/index";
import { BINDINGS, checkContract, contractShape, loadOpenApi, type ContractBinding } from "./contract-check";

type Doc = Record<string, any>;

const ROOT = resolve(import.meta.dirname, "../..");
const contract = () => structuredClone(loadOpenApi(ROOT)) as Doc;
const bound = (change: Partial<ContractBinding>): ContractBinding[] => [{ ...CLIENT_CONTRACT, ...change }];

/** The ```yaml block of docs/architecture-integrations.md §6. */
function documentedContract(): Doc {
  const markdown = readFileSync(resolve(ROOT, "docs/architecture-integrations.md"), "utf8");
  const section = markdown.slice(markdown.indexOf("## 6. Orquestador de red"), markdown.indexOf("## 7."));
  const block = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
  if (block === undefined) throw new Error("the contract block of §6 was not found");
  return parse(block) as Doc;
}

describe("network:contract", () => {
  it("passes for the repository: the client and the mock validate with the contract's schemas", () => {
    expect(checkContract(loadOpenApi(ROOT), BINDINGS)).toEqual([]);
    expect(BINDINGS.map((binding) => binding.label)).toEqual(["bff network client", "network-mock"]);
  });

  it("keeps openapi.yaml equal to the contract of docs/architecture-integrations.md §6", () => {
    expect(contractShape(contract())).toEqual(contractShape(documentedContract()));
  });

  it("keeps the contract's operational states equal to the product's", () => {
    expect(OperState.options).toEqual(OnuOperState.options);
  });

  it("fails when a zod schema drifts from the contract", () => {
    const doc = contract();
    const widerState = OnuStatus.extend({ operState: z.enum([...OperState.options, "REBOOTING"]) });
    expect(checkContract(doc, bound({ onuStatus: widerState })).join("\n")).toMatch(/OnuStatus\.operState: enum/);
    expect(checkContract(doc, bound({ onuStatus: OnuStatus.extend({ observedAt: z.iso.datetime({ offset: true }).optional() }) })).join("\n")).toMatch(/OnuStatus: required/);
    expect(checkContract(doc, bound({ onuStatus: OnuStatus.extend({ vendor: z.string().optional() }) })).join("\n")).toMatch(/OnuStatus\.vendor: in zod, missing in the contract/);
    expect(checkContract(doc, bound({ onuStatus: OnuStatus.omit({ profile: true }) })).join("\n")).toMatch(/OnuStatus\.profile: in the contract, missing in zod/);
    expect(checkContract(doc, bound({ onuStatus: OnuStatus.extend({ rxPowerDbm: z.string().optional() }) })).join("\n")).toMatch(/OnuStatus\.rxPowerDbm: type/);
    expect(checkContract(doc, bound({ serial: OnuSerialParam.and(z.string().regex(/^DEMO/)) })).length).toBeGreaterThan(0);
    expect(checkContract(doc, bound({ serial: z.string().regex(/^[A-Z0-9]{6,16}$/) })).join("\n")).toMatch(/serial: pattern/);
    expect(checkContract(doc, bound({ world: z.string().min(3) })).join("\n")).toMatch(/X-World: minLength/);
  });

  it("fails when an operation is called or served differently from the contract", () => {
    const doc = contract();
    const extra = { ...NETWORK_OPERATIONS, reboot: { operationId: "rebootOnu", method: "POST", path: "/v1/onus/{serial}/reboot", pathParams: ["serial"], requiredHeaders: [], responses: [202] } } as const;
    expect(checkContract(doc, bound({ operations: extra })).join("\n")).toMatch(/rebootOnu is not in the contract/);
    const { health: _health, ...onlyGetOnu } = NETWORK_OPERATIONS;
    expect(checkContract(doc, bound({ operations: onlyGetOnu })).join("\n")).toMatch(/contract operation health is not served or called/);
    const moved = { ...NETWORK_OPERATIONS, getOnu: { ...NETWORK_OPERATIONS.getOnu, path: "/v2/onus/{serial}" } };
    expect(checkContract(doc, bound({ operations: moved })).join("\n")).toMatch(/getOnu: GET \/v2\/onus\/\{serial\} is GET \/v1\/onus\/\{serial\}/);
  });

  it("fails when the contract changes under the client and the mock", () => {
    const noRetry = contract();
    delete noRetry.paths["/v1/onus/{serial}"].get.responses["503"];
    expect(checkContract(noRetry, BINDINGS).join("\n")).toMatch(/responses 200,404 in the contract, 200,404,503 in zod/);
    const optionalWorld = contract();
    optionalWorld.paths["/v1/onus/{serial}"].get.parameters[1].required = false;
    expect(checkContract(optionalWorld, BINDINGS).join("\n")).toMatch(/required headers differ/);
    const otherBody = contract();
    otherBody.paths["/v1/onus/{serial}"].get.responses["200"].content["application/json"].schema = { type: "object" };
    expect(checkContract(otherBody, BINDINGS).join("\n")).toMatch(/getOnu 200 is not OnuStatus/);
    const unsigned = contract();
    delete unsigned.security;
    expect(checkContract(unsigned, BINDINGS)).toContain("security: the contract does not require sigv4");
    const older = contract();
    older.openapi = "3.0.3";
    expect(checkContract(older, BINDINGS)).toContain("openapi: expected 3.1.x");
  });

  it("fails when a control route or a simulation header of the mock leaks into the contract", () => {
    const withControl = contract();
    withControl.paths["/v1/onus/{serial}/physical-action"] = { post: { operationId: "physicalAction", responses: { "200": { description: "ok" } } } };
    expect(checkContract(withControl, BINDINGS).join("\n")).toMatch(/\/v1\/onus\/\{serial\}\/physical-action: a control route of the mock is in the contract/);
    const withHeader = contract();
    withHeader.paths["/v1/onus/{serial}"].get.parameters.push({ name: "X-Fault", in: "header", required: false, schema: { type: "string" } });
    expect(checkContract(withHeader, BINDINGS).join("\n")).toMatch(/X-Fault: a simulation header of the mock is in the contract/);
  });
});

describe("the client and the mock on the same wire", () => {
  const AT = "2026-10-13T09:20:00-06:00";
  const SERIAL = "DEMO3F2C19A0";

  function wire(clockId: string, fault?: "ERROR_503") {
    const store = new InMemoryOnuStore();
    store.put(newOnuRow({ clockId, serial: SERIAL, behaviour: "LOS_THEN_ONLINE", rxPowerDbm: -21.4, nowIso: "2026-09-26T10:00:00.000Z" }));
    const deps = { store, now: () => new Date("2026-09-26T10:00:00.000Z"), sleep: async () => undefined };
    const client = createNetworkClient({
      transport: (request) => handleNetworkRequest(request, deps),
      faults: { networkFault: async () => fault },
      sleep: async () => undefined,
      logger: createLogger({ sink: () => undefined }),
    });
    return { client, store };
  }

  it("reads LOS, applies the installer's step and reads ONLINE −21.4, counting reads per reader", async () => {
    const { client, store } = wire("GLOBAL#isp-demo");
    const call = { clockId: "GLOBAL#isp-demo", serial: SERIAL, atSim: AT } as const;
    expect(await client.getOnuStatus({ ...call, caller: "HARNESS" })).toMatchObject({ kind: "OK", value: { operState: "LOS", observedAt: AT } });
    expect(await client.getOnuStatus({ ...call, caller: "CONSOLE" })).toMatchObject({ kind: "OK", value: { operState: "LOS" } });
    expect(await client.reportPhysicalAction({ ...call, caller: "WORKER", kind: "INSTALLER_STEP" })).toMatchObject({ kind: "OK", value: { changed: true, fixedAtSim: AT } });
    expect(await client.getOnuStatus({ ...call, caller: "HARNESS" })).toMatchObject({ kind: "OK", value: { operState: "ONLINE", rxPowerDbm: -21.4 } });
    const row = await store.get(onuKey("GLOBAL#isp-demo", SERIAL));
    expect(row?.queryCount).toBe(3);
    expect(row === undefined ? undefined : readsByReader(row)).toMatchObject({ HARNESS: 2, CONSOLE: 1, WORKER: 0 });
  });

  it("answers UNAVAILABLE after the client's three attempts against a faulted qa world, all seen by the mock", async () => {
    const { client, store } = wire("qa-812-1-sc-02", "ERROR_503");
    const outcome = await client.getOnuStatus({ clockId: "qa-812-1-sc-02", serial: SERIAL, atSim: AT, caller: "HARNESS" });
    expect(outcome).toEqual({ kind: "UNAVAILABLE", reason: "HTTP_5XX", attempts: 3 });
    const row = await store.get(onuKey("qa-812-1-sc-02", SERIAL));
    expect(row).toMatchObject({ faultCount: 3, queryCount: 0 });
  });

  it("rejects an event the mock does not accept from that principal", async () => {
    const { client } = wire("GLOBAL#isp-demo");
    const outcome = await client.reportPhysicalAction({ clockId: "GLOBAL#isp-demo", serial: SERIAL, atSim: AT, caller: "HARNESS", kind: "INSTALLER_STEP" });
    expect(outcome).toEqual({ kind: "UNAVAILABLE", reason: "FORBIDDEN", attempts: 1 });
  });
});
