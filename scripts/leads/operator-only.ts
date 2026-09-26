// The lead scripts handle real personal data and run only on the operator's machine, with the
// operator's profile through `sst shell` (ADR-0026): never in CI, where a runner would hold the leads'
// addresses in its logs or its workspace.

export function assertOperatorMachine(env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") throw new RangeError("the lead scripts run only on the operator's machine, never in CI");
}
