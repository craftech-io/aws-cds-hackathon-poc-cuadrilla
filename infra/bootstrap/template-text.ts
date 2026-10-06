// The CI bootstrap template and the deploy workflow as text, for ci-role.test.ts and
// ci-role-fences.test.ts. The repository has no YAML parser and needs none: each check is a line
// someone under pressure would be tempted to write, and must not.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";

export const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
export const withoutComments = (yaml: string): string =>
  yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

export const template = withoutComments(read("infra/bootstrap/ci-role.yaml"));
export const deployWorkflow = withoutComments(read(".github/workflows/deploy.yml"));

export function block(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `marker "${startMarker}"`).toBeGreaterThanOrEqual(0);
  expect(end, `marker "${endMarker}"`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Lines of one entry of `Parameters:` (two-space key), up to the next entry. */
export function parameterBlock(name: string): string {
  const lines = template.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start, `parameter ${name}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return rest.slice(0, next === -1 ? undefined : next).join("\n");
}

export interface Statement {
  readonly sid: string;
  readonly body: string;
}

/** Every statement of every policy, as text from its `- Sid:` line up to the next statement or resource. */
export function statementsOf(source: string): Statement[] {
  const statements: Statement[] = [];
  let current: { sid: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current) statements.push({ sid: current.sid, body: current.lines.join("\n") });
    current = undefined;
  };
  for (const line of source.split("\n")) {
    const sid = /^\s*- Sid: (\w+)/.exec(line)?.[1];
    if (sid) {
      flush();
      current = { sid, lines: [line] };
    } else if (/^ {0,4}\S/.test(line)) {
      flush();
    } else {
      current?.lines.push(line);
    }
  }
  flush();
  return statements;
}

export const statements = statementsOf(template);
export const statement = (sid: string): string => {
  const found = statements.filter((candidate) => candidate.sid === sid);
  expect(found, `statement ${sid}`).toHaveLength(1);
  return found[0]?.body ?? "";
};
export const allows = statements.filter(({ body }) => body.includes("Effect: Allow"));


/** An Allow statement of the boundary with its actions and ARNs (the defaults of this account substituted). */
export interface BoundaryAllow {
  readonly sid: string;
  readonly actions: string[];
  readonly resources: string[];
  /** Fenced by `aws:ResourceTag/sst:app`. */
  readonly tagged: boolean;
}

const substitute = (text: string): string =>
  text.replace(/^!Sub /, "").replace(/^"|"$/g, "").replace("${AWS::Partition}", "aws").replace("${Region}", "us-east-1").replace("${AWS::AccountId}", "776805327629");

/** The values of `key:` in a statement body: inline, or the `- item` lines under it. */
function listOf(body: string, key: string): string[] {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => line.trim().startsWith(`${key}:`));
  if (at < 0) return [];
  const inline = lines[at]?.trim().slice(key.length + 1).trim() ?? "";
  if (inline !== "") return [substitute(inline)];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+- (.+)$/.exec(line)?.[1];
    if (item === undefined) break;
    items.push(substitute(item));
  }
  return items;
}

/** Every Allow statement of the permissions boundary, the ceiling of the roles the app creates. */
export function boundaryAllows(): BoundaryAllow[] {
  return statementsOf(block(template, "  DeployBoundary:", "  DeploySstHomePolicy:"))
    .filter(({ body }) => body.includes("Effect: Allow"))
    .map(({ sid, body }) => ({ sid, actions: listOf(body, "Action"), resources: listOf(body, "Resource"), tagged: body.includes("aws:ResourceTag/sst:app") }));
}
