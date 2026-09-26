// Contract check of the network orchestrator (docs/architecture.md §18, docs/architecture-integrations.md
// §6). Fails when the zod schemas the BFF client and the mock validate with differ from
// `packages/network-contract/openapi.yaml`, or when something only the mock understands (its control
// routes and simulation headers) shows up in the contract. Exit 1 on any difference.
//
//   npm run network:contract
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_ROUTES, MOCK_HEADERS, NETWORK_OPERATIONS, type NetworkOperation } from "@cuadrilla/network-contract";
import { parse } from "yaml";
import { z } from "zod";
import { CLIENT_CONTRACT } from "../../packages/bff/src/network/contract";
import { MOCK_CONTRACT } from "../../packages/network-mock/src/contract";

export const OPENAPI_FILE = "packages/network-contract/openapi.yaml";

/** What one side of the wire validates with. */
export interface ContractBinding {
  readonly label: string;
  readonly onuStatus: z.ZodType;
  readonly serial: z.ZodType;
  readonly world: z.ZodType;
  readonly operations: Readonly<Record<string, NetworkOperation>>;
}

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);
const node = (value: unknown): Node => (isNode(value) ? value : {});
const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

/** Keywords that change what a value may be; descriptions and examples do not count. */
const COMPARED = ["type", "format", "enum", "pattern", "required", "minLength", "maxLength", "minimum", "maximum", "items", "properties"] as const;

function resolveRef(doc: Node, schema: unknown): Node {
  const ref = node(schema).$ref;
  if (typeof ref !== "string") return node(schema);
  if (!ref.startsWith("#/")) return {};
  return node(ref.slice(2).split("/").reduce<unknown>((at, key) => node(at)[key], doc));
}

/** The constraining part of a schema, `$ref`s resolved; zod's pattern for a `format` is the format. */
export function normaliseSchema(doc: Node, schema: unknown): Node {
  const source = resolveRef(doc, schema);
  const out: Node = {};
  for (const keyword of COMPARED) {
    const value = source[keyword];
    if (value === undefined || (keyword === "pattern" && source.format !== undefined)) continue;
    if (keyword === "properties") {
      out.properties = Object.fromEntries(Object.entries(node(value)).map(([name, property]) => [name, normaliseSchema(doc, property)]));
    } else if (keyword === "items") {
      out.items = normaliseSchema(doc, value);
    } else if (keyword === "enum" || keyword === "required") {
      out[keyword] = Array.isArray(value) ? [...value].map(String).sort() : value;
    } else {
      out[keyword] = value;
    }
  }
  return out;
}

export interface OperationShape {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: Readonly<Record<string, Node>>;
  /** Required headers, lower-case names, with their schemas. */
  readonly headers: Readonly<Record<string, Node>>;
  readonly optionalParams: readonly string[];
  readonly responses: readonly number[];
  readonly okSchema?: Node;
}

/** Operations of an OpenAPI document, reduced to what the wire depends on. */
export function operationsOf(doc: Node): OperationShape[] {
  const out: OperationShape[] = [];
  for (const [path, item] of Object.entries(node(doc.paths))) {
    for (const method of HTTP_METHODS) {
      const operation = node(node(item)[method]);
      if (Object.keys(operation).length === 0) continue;
      const pathParams: Record<string, Node> = {};
      const headers: Record<string, Node> = {};
      const optionalParams: string[] = [];
      for (const raw of Array.isArray(operation.parameters) ? operation.parameters : []) {
        const param = node(raw);
        const name = String(param.name ?? "");
        if (param.required !== true) optionalParams.push(name.toLowerCase());
        else if (param.in === "path") pathParams[name] = normaliseSchema(doc, param.schema);
        else if (param.in === "header") headers[name.toLowerCase()] = normaliseSchema(doc, param.schema);
        else optionalParams.push(name.toLowerCase());
      }
      const responses = node(operation.responses);
      const okContent = node(node(node(responses["200"]).content)["application/json"]);
      out.push({
        operationId: String(operation.operationId ?? ""),
        method: method.toUpperCase(),
        path,
        pathParams,
        headers,
        optionalParams,
        responses: Object.keys(responses).map(Number).sort((a, b) => a - b),
        ...(okContent.schema === undefined ? {} : { okSchema: normaliseSchema(doc, okContent.schema) }),
      });
    }
  }
  return out.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

/** The structure of a contract: security, operations and the schemas they return. */
export function contractShape(doc: Node) {
  const sigv4 = node(node(node(doc.components).securitySchemes).sigv4);
  return {
    openapi: String(doc.openapi ?? ""),
    security: doc.security,
    sigv4: { type: sigv4.type, in: sigv4.in, name: sigv4.name },
    operations: operationsOf(doc),
    schemas: Object.fromEntries(Object.entries(node(node(doc.components).schemas)).map(([name, schema]) => [name, normaliseSchema(doc, schema)])),
  };
}

/** Differences between two normalised schemas, as `path: what`. */
export function schemaDifferences(expected: Node, actual: Node, path: string): string[] {
  const differences: string[] = [];
  for (const keyword of COMPARED) {
    const want = expected[keyword];
    const got = actual[keyword];
    if (keyword === "properties" && (want !== undefined || got !== undefined)) {
      const wantProps = node(want);
      const gotProps = node(got);
      for (const name of new Set([...Object.keys(wantProps), ...Object.keys(gotProps)])) {
        if (!(name in gotProps)) differences.push(`${path}.${name}: in the contract, missing in zod`);
        else if (!(name in wantProps)) differences.push(`${path}.${name}: in zod, missing in the contract`);
        else differences.push(...schemaDifferences(node(wantProps[name]), node(gotProps[name]), `${path}.${name}`));
      }
    } else if (keyword === "items" && (want !== undefined || got !== undefined)) {
      differences.push(...schemaDifferences(node(want), node(got), `${path}[]`));
    } else if (JSON.stringify(want) !== JSON.stringify(got)) {
      differences.push(`${path}: ${keyword} is ${JSON.stringify(want)} in the contract and ${JSON.stringify(got)} in zod`);
    }
  }
  return differences;
}

const zodSchema = (schema: z.ZodType): Node => normaliseSchema({}, z.toJSONSchema(schema, { io: "input" }));

function checkBinding(doc: Node, operations: readonly OperationShape[], binding: ContractBinding): string[] {
  const errors: string[] = [];
  const status = node(node(node(doc.components).schemas).OnuStatus);
  errors.push(...schemaDifferences(normaliseSchema(doc, status), zodSchema(binding.onuStatus), `${binding.label}: OnuStatus`));
  const bound = Object.values(binding.operations);
  for (const operation of bound) {
    const found = operations.find((candidate) => candidate.operationId === operation.operationId);
    if (found === undefined) {
      errors.push(`${binding.label}: operation ${operation.operationId} is not in the contract`);
      continue;
    }
    const where = `${binding.label}: ${operation.operationId}`;
    if (found.method !== operation.method || found.path !== operation.path) errors.push(`${where}: ${operation.method} ${operation.path} is ${found.method} ${found.path} in the contract`);
    if (JSON.stringify(Object.keys(found.pathParams).sort()) !== JSON.stringify([...operation.pathParams].sort())) errors.push(`${where}: path parameters differ`);
    const required = operation.requiredHeaders.map((name) => name.toLowerCase()).sort();
    if (JSON.stringify(Object.keys(found.headers).sort()) !== JSON.stringify(required)) errors.push(`${where}: required headers differ`);
    if (JSON.stringify(found.responses) !== JSON.stringify([...operation.responses].sort((a, b) => a - b))) errors.push(`${where}: responses ${found.responses.join(",")} in the contract, ${operation.responses.join(",")} in zod`);
    if (found.pathParams.serial !== undefined) errors.push(...schemaDifferences(found.pathParams.serial, zodSchema(binding.serial), `${where}: serial`));
    const world = found.headers["x-world"];
    if (world !== undefined) errors.push(...schemaDifferences(world, zodSchema(binding.world), `${where}: X-World`));
  }
  for (const operation of operations) {
    if (!bound.some((candidate) => candidate.operationId === operation.operationId)) errors.push(`${binding.label}: contract operation ${operation.operationId} is not served or called`);
  }
  const getOnu = operations.find((operation) => operation.operationId === NETWORK_OPERATIONS.getOnu.operationId);
  if (getOnu !== undefined && JSON.stringify(getOnu.okSchema) !== JSON.stringify(normaliseSchema(doc, status))) errors.push(`${binding.label}: getOnu 200 is not OnuStatus`);
  return errors;
}

/** Every difference between the contract and the bindings, plus anything mock-only inside the contract. */
export function checkContract(doc: unknown, bindings: readonly ContractBinding[]): string[] {
  const root = node(doc);
  const errors: string[] = [];
  if (!String(root.openapi ?? "").startsWith("3.1")) errors.push("openapi: expected 3.1.x");
  const shape = contractShape(root);
  if (JSON.stringify(shape.sigv4) !== JSON.stringify({ type: "apiKey", in: "header", name: "Authorization" })) errors.push("security: sigv4 scheme missing or changed");
  if (!JSON.stringify(shape.security ?? []).includes('"sigv4"')) errors.push("security: the contract does not require sigv4");
  for (const binding of bindings) errors.push(...checkBinding(root, shape.operations, binding));
  for (const route of Object.values(CONTROL_ROUTES)) {
    const path = `${NETWORK_OPERATIONS.getOnu.path}${route.suffix}`;
    if (path in node(root.paths)) errors.push(`${path}: a control route of the mock is in the contract`);
  }
  const params = new Set(shape.operations.flatMap((operation) => [...Object.keys(operation.headers), ...operation.optionalParams]));
  for (const header of Object.values(MOCK_HEADERS)) if (params.has(header.toLowerCase())) errors.push(`${header}: a simulation header of the mock is in the contract`);
  return errors;
}

export function loadOpenApi(cwd = process.cwd()): unknown {
  return parse(readFileSync(resolve(cwd, OPENAPI_FILE), "utf8"));
}

export const BINDINGS: readonly ContractBinding[] = [CLIENT_CONTRACT, MOCK_CONTRACT];

function main(): void {
  const errors = checkContract(loadOpenApi(), BINDINGS);
  if (errors.length > 0) {
    console.error(`network:contract: ${errors.length} difference(s) with ${OPENAPI_FILE}:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`network:contract: ${BINDINGS.map((binding) => binding.label).join(" and ")} match ${OPENAPI_FILE}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
