// IAM's size limits on every role of the app [W3R1-N1]: one inline policy per role (SST merges the
// `permissions` and every link include into it) under 10,240 characters, each customer-managed policy
// under 6,144, both with every placeholder at its longest ARN (infra/role-policy-size.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expectedGrants, managedPolicies } from "./iam-capabilities";
import { QA_DRIVER_WRITE_KEYS } from "./qa-driver-fence";
import { INLINE_POLICY_MAX_CHARS, MANAGED_POLICY_MAX_CHARS, POLICY_ROLES, inlineGrants, policyChars, rolePolicySizes, sstPhysicalName, worstCaseResource } from "./role-policy-size";

describe("role policy sizes [W3R1-N1]", () => {
  it.each(POLICY_ROLES)("%s: its inline policy fits IAM's 10,240 characters and each managed policy 6,144", (role) => {
    const { inline, managed } = rolePolicySizes(role);
    expect(inline, `${role} inline`).toBeLessThan(INLINE_POLICY_MAX_CHARS);
    for (const [name, size] of Object.entries(managed)) expect(size, `${role} ${name}`).toBeLessThan(MANAGED_POLICY_MAX_CHARS);
  });

  it("would not fit inline with the QaDriver's fenced writes: that is why they are managed", () => {
    const fenced = Object.values(managedPolicies("QaDriver")).flat();
    expect(Object.keys(managedPolicies("QaDriver"))).toEqual(["QaDriverRuntimeWrites", "QaDriverWorldWrites"]);
    expect(policyChars([...inlineGrants("QaDriver"), ...fenced])).toBeGreaterThan(INLINE_POLICY_MAX_CHARS);
    expect(inlineGrants("QaDriver").some((grant) => fenced.includes(grant))).toBe(false);
    expect(expectedGrants("QaDriver")).toEqual(expect.arrayContaining(fenced));
    const leadingKeys = fenced.flatMap((grant) => grant.conditions ?? []).flatMap((condition) => condition.values);
    expect(leadingKeys).toEqual(expect.arrayContaining([...QA_DRIVER_WRITE_KEYS.Runtime]));
  });

  it("resolves placeholders to the longest names SST and AWS give them", () => {
    expect(sstPhysicalName(255, "RuntimeTable")).toBe("aws-cds-hackathon-poc-cuadrilla-poc-RuntimeTable-xxxxxxxx");
    expect(sstPhysicalName(64, "InstallerWorkerFunction")).toHaveLength(64);
    expect(worstCaseResource("{Runtime}/index/*")[0]).toBe("arn:aws:dynamodb:us-east-1:776805327629:table/aws-cds-hackathon-poc-cuadrilla-poc-RuntimeTable-xxxxxxxx/index/*");
    expect(worstCaseResource("{ToolOrders}")[0]).toMatch(/:function:x{64}$/);
    expect(worstCaseResource("{Media}/qa/*")[0]).toMatch(/^arn:aws:s3:::x{63}\/qa\/\*$/);
    expect(worstCaseResource("{model:HARNESS}").length).toBeGreaterThan(2);
    expect(() => worstCaseResource("{Unknown.thing}")).toThrow(/no worst-case ARN/);
  });

  it("lets the CI deploy role create and attach a managed policy only under the app's IAM path", () => {
    const template = readFileSync(resolve(process.cwd(), "infra/bootstrap/ci-role.yaml"), "utf8");
    const ci = readFileSync(resolve(process.cwd(), "infra/ci.ts"), "utf8");
    expect(ci).toMatch(/\$transform\(aws\.iam\.Policy, \(args\) => \{\n\s+args\.path \?\?= CI_IAM_PATH;/);
    const attach = template.slice(template.indexOf("Sid: IamAttachKnownPoliciesToBoundedAppRoles"), template.indexOf("Sid: IamManageAppRoles"));
    expect(attach).toContain('policy/${AppName}/*"');
    expect(template).toMatch(/- iam:CreatePolicy\n[\s\S]*?Resource: !Sub "arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:policy\/\$\{AppName\}\/\*"/);
  });
});
