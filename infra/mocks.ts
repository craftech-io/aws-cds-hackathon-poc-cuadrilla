// The external systems the app simulates (docs/architecture-integrations.md §6-§7, docs/architecture.md
// §5 and §14, docs/build-plan.md WP-24): the network orchestrator and the dispatcher, each a Lambda
// behind a Function URL with AWS_IAM and its own table. Their code is packages/network-mock and
// packages/dispatch-mock.
//
// Tables. `Network` (`ONU#<clockId>#<serial>` / `META`) and `Dispatch` (`DWO#<ispId>#<number>` /
// `META`, `EVT#<ts>`): PK + SK strings, no GSI, TTL `expiresAt` (QA, evaluation and judge worlds),
// on-demand, encrypted, no stream. Each mock writes only its own table; `DispatchMock` also puts its
// events on the `Feeds` bus (`events:PutEvents` on it, nothing else). The world factory writes both
// tables directly (WORLDS), fenced by `dynamodb:LeadingKeys` per role (`WORLDS_LEADING_KEYS`).
//
// Callers. The capability Linkables `NetworkMock` and `DispatchMock` carry `Resource.<Mock>.{name, url}`
// and exactly MOCK_NETWORK / MOCK_DISPATCH of infra/iam-capabilities.ts: `lambda:InvokeFunctionUrl`
// with `lambda:FunctionUrlAuthType` = AWS_IAM and `lambda:InvokeFunction`, on that mock only (since
// October 2025 a Function URL with AWS_IAM needs both). Only the roles holding the capability link
// them (NetworkMock: InstallerWorker, ToolOrders, ToolEvidence, ToolCases, Bff, QaDriver;
// DispatchMock: Bff, QaDriver). A role links `mockLinks(fn)` (the mocks it calls, the mocks' tables it
// writes by name only) and adds `mockPermissions(fn)` (the fenced table statements).
//
// Resource policy. Each mock names every calling role in a pair of aws.lambda.Permission: InvokeFunctionUrl
// with auth type AWS_IAM, and InvokeFunction only through the URL (`lambda:InvokedViaFunctionUrl`). No
// mock has a public URL nor a statement for `*` or a service. The callers are created by modules
// evaluated after this one (workers.ts, agent-tools.ts, bff.ts) that import it to link the mocks, so
// their Functions are read late (`lateFunction`: exported under the SST name or camelCased); a caller
// not exported yet gets no pair, and the deploy log says so.
//
// Verify:
//   aws --profile craftech-demos lambda get-function-url-config --function-name <NetworkMockApi name>   → AuthType AWS_IAM
//   aws --profile craftech-demos lambda get-policy --function-name <NetworkMockApi name>
//     → per calling role: lambda:InvokeFunctionUrl (lambda:FunctionUrlAuthType AWS_IAM) and
//       lambda:InvokeFunction (lambda:InvokedViaFunctionUrl true), Principal = that role's ARN
//   aws --profile craftech-demos dynamodb describe-time-to-live --table-name <Network name>   → expiresAt ENABLED

import { Feeds } from "./feeds";
import { CAPABILITIES, LAMBDA_CAPABILITIES, expectedGrants, resolveCapabilities, type CapabilityName, type Grant, type LambdaName } from "./iam-capabilities";
import { dataAccessGrants } from "./storage-access";
import { PRIMARY_KEY, TABLE_INDEXES, TTL_ATTRIBUTE, storageFor, tableFields, type MockTable, type TableSpec } from "./storage-keys";

export const NETWORK_MOCK_HANDLER = "packages/network-mock/src/handler.handler";
export const DISPATCH_MOCK_HANDLER = "packages/dispatch-mock/src/handler.handler";

export const MOCKS = ["NetworkMock", "DispatchMock"] as const;
export type Mock = (typeof MOCKS)[number];

export const MOCK_CAPABILITY = { NetworkMock: "MOCK_NETWORK", DispatchMock: "MOCK_DISPATCH" } as const satisfies Record<Mock, CapabilityName>;

/** Keys and TTL of the mocks' tables (docs/architecture.md §5): no GSI, items expire in temporary worlds. */
export const MOCK_TABLE_SPECS = {
  Network: { indexes: {}, ttl: true },
  Dispatch: { indexes: {}, ttl: true },
} as const satisfies Record<MockTable, TableSpec>;

// ---- Late reads of the Functions of later modules ---------------------------------------------------

export type LateModule = "workers" | "agent-tools" | "bff";

const LOAD: Readonly<Record<LateModule, () => Promise<object>>> = {
  workers: () => import("./workers"),
  "agent-tools": () => import("./agent-tools"),
  bff: () => import("./bff"),
};

/** Module that creates each Lambda this infra reads late (docs/build-plan.md §1). */
export const LATE_FUNCTION_OWNERS = {
  InstallerWorker: "workers",
  ToolOrders: "agent-tools",
  ToolEvidence: "agent-tools",
  ToolCases: "agent-tools",
  Bff: "bff",
  QaDriver: "bff",
} as const satisfies Partial<Record<LambdaName, LateModule>>;

export type LateFunction = keyof typeof LATE_FUNCTION_OWNERS;

// One load per module, shared by every read: all of them see the module once it has been evaluated.
const loaded = new Map<LateModule, Promise<object>>();

function load(owner: LateModule): Promise<object> {
  const pending = loaded.get(owner) ?? LOAD[owner]();
  loaded.set(owner, pending);
  return pending;
}

/** A Function its owner module exports under its SST name or camelCased; `undefined` (and a warning) until it does. */
export function lateFunction(name: LateFunction, consequence: string): $util.Output<sst.aws.Function | undefined> {
  const owner = LATE_FUNCTION_OWNERS[name];
  const camel = `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
  return $util.output(
    load(owner).then((module) => {
      const value: unknown = Reflect.get(module, name) ?? Reflect.get(module, camel);
      if (value instanceof sst.aws.Function) return value;
      $util.log.warn(`infra/${owner}.ts exports no ${name} Function yet: ${consequence} until it does.`);
      return undefined;
    }),
  );
}

// ---- IAM statements ------------------------------------------------------------------------------

export type Statement = sst.aws.FunctionPermissionArgs;

/** An iam-capabilities.ts grant as a permission statement, each placeholder resolved by `resolve`. */
export function grantStatement(grant: Grant, resolve: (resource: string) => $util.Input<string>): Statement {
  const statement: Statement = { actions: [...grant.actions], resources: grant.resources.map(resolve) };
  if (grant.conditions) statement.conditions = grant.conditions.map((condition) => ({ test: condition.test, variable: condition.variable, values: [...condition.values] }));
  return statement;
}

/** The roles that call a mock: the holders of its capability in infra/iam-capabilities.ts. */
export function mockInvokers(mock: Mock): LambdaName[] {
  return (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities).includes(MOCK_CAPABILITY[mock]));
}

const only = (placeholder: string, value: () => $util.Input<string>) => (resource: string) => {
  if (resource !== placeholder) throw new Error(`infra/mocks.ts resolves ${placeholder}, not "${resource}".`);
  return value();
};

// ---- Tables ------------------------------------------------------------------------------------

function mockTable(name: MockTable): sst.aws.Dynamo {
  return new sst.aws.Dynamo(name, {
    fields: tableFields(MOCK_TABLE_SPECS[name]),
    primaryIndex: PRIMARY_KEY,
    ttl: TTL_ATTRIBUTE,
    transform: { table: { serverSideEncryption: { enabled: true } } },
  });
}

export const Network = mockTable("Network");
export const Dispatch = mockTable("Dispatch");

export const mockTables = { Network, Dispatch } as const satisfies Record<MockTable, sst.aws.Dynamo>;

const TABLE_REF = /^\{(Network|Dispatch)\}(\/index\/\*)?$/;

function tableArn(resource: string): $util.Input<string> {
  const [, name, indexes] = TABLE_REF.exec(resource) ?? [];
  if (name === undefined) throw new Error(`"${resource}" is not a table of infra/mocks.ts.`);
  const arn = mockTables[name as MockTable].arn;
  return indexes === undefined ? arn : $interpolate`${arn}/${TABLE_INDEXES}`;
}

/**
 * What a role adds to its `permissions` from this module: item actions on the mocks' tables, fenced by
 * `dynamodb:LeadingKeys` for WORLDS roles, whole for each mock. The invoke grants of the mocks it calls
 * travel with the Linkables of `mockLinks`.
 */
export function mockPermissions(fn: LambdaName): Statement[] {
  return dataAccessGrants(fn).mocks.map((grant) => grantStatement(grant, tableArn));
}

// ---- The mocks ---------------------------------------------------------------------------------

export const networkMock = new sst.aws.Function("NetworkMockApi", {
  description: "Simulated network orchestrator: ONU status and behaviours per world (Function URL, AWS_IAM).",
  handler: NETWORK_MOCK_HANDLER,
  url: { authorization: "iam" },
  link: [Network],
  permissions: mockPermissions("NetworkMock"),
  // Above the 4 s of the TIMEOUT fault of QA worlds, which has to outlive the client's 3 s timeout.
  timeout: "10 seconds",
  memory: "256 MB",
});

export const dispatchMock = new sst.aws.Function("DispatchMockApi", {
  description: "Simulated dispatcher: work orders per operator; publishes its changes on the Feeds bus (Function URL, AWS_IAM).",
  handler: DISPATCH_MOCK_HANDLER,
  url: { authorization: "iam" },
  link: [Dispatch, Feeds],
  permissions: [...mockPermissions("DispatchMock"), ...expectedGrants("DispatchMock").map((grant) => grantStatement(grant, only("{Feeds}", () => Feeds.arn)))],
  // DynamoDB and PutEvents, each with at most 3 attempts of 2 s.
  timeout: "20 seconds",
  memory: "256 MB",
});

export const MOCK_FUNCTIONS: Readonly<Record<Mock, sst.aws.Function>> = { NetworkMock: networkMock, DispatchMock: dispatchMock };

function capabilityLink(mock: Mock) {
  const fn = MOCK_FUNCTIONS[mock];
  return new sst.Linkable(mock, {
    properties: { name: fn.name, url: fn.url },
    include: CAPABILITIES[MOCK_CAPABILITY[mock]].grants.map((grant) => sst.aws.permission(grantStatement(grant, only(`{${mock}}`, () => fn.arn)))),
  });
}

/** MOCK_NETWORK: `Resource.NetworkMock.{name, url}`, InvokeFunctionUrl (AWS_IAM) and InvokeFunction on it. */
export const NetworkMock = capabilityLink("NetworkMock");
/** MOCK_DISPATCH: `Resource.DispatchMock.{name, url}`, InvokeFunctionUrl (AWS_IAM) and InvokeFunction on it. */
export const DispatchMock = capabilityLink("DispatchMock");

/** What a role links from this module: the mocks it calls and the mocks' tables it writes (by name only). */
export function mockLinks(fn: LambdaName): Array<typeof NetworkMock | sst.aws.Dynamo> {
  const held = resolveCapabilities(LAMBDA_CAPABILITIES[fn].capabilities);
  const calls = MOCKS.filter((mock) => held.includes(MOCK_CAPABILITY[mock])).map((mock) => (mock === "NetworkMock" ? NetworkMock : DispatchMock));
  return [...calls, ...storageFor(fn).mockTables.map((name) => mockTables[name])];
}

// ---- One pair of permissions per calling role, on the mock ----------------------------------------

function invokePair(mock: Mock, caller: LateFunction, role: $util.Input<string>): aws.lambda.Permission[] {
  const target = { function: MOCK_FUNCTIONS[mock].name, principal: role };
  return [
    new aws.lambda.Permission(`${mock}UrlFor${caller}`, { ...target, action: "lambda:InvokeFunctionUrl", functionUrlAuthType: "AWS_IAM" }),
    new aws.lambda.Permission(`${mock}InvokeFor${caller}`, { ...target, action: "lambda:InvokeFunction", invokedViaFunctionUrl: true }),
  ];
}

const isLateFunction = (name: LambdaName): name is LateFunction => name in LATE_FUNCTION_OWNERS;

export interface InvokeGrant {
  readonly mock: Mock;
  readonly caller: LateFunction;
  readonly permissions: aws.lambda.Permission[];
}

/** The pairs, once every owner module has been evaluated; a caller not exported yet is absent. */
export const mockInvokeGrants: $util.Output<InvokeGrant[]> = $util
  .all(
    MOCKS.flatMap((mock) =>
      mockInvokers(mock).map((caller) => {
        if (!isLateFunction(caller)) throw new Error(`infra/mocks.ts does not know which module creates ${caller}, which calls ${mock}: add it to LATE_FUNCTION_OWNERS.`);
        return lateFunction(caller, `${mock} names no role of it`).apply((fn) => (fn === undefined ? undefined : { mock, caller, permissions: invokePair(mock, caller, fn.nodes.role.arn) }));
      }),
    ),
  )
  .apply((grants) => grants.filter((grant): grant is InvokeGrant => grant !== undefined));
