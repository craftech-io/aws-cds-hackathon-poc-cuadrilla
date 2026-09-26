// What the login and the sign-up show on a build without the variables of the stage's pool
// (infra/auth.ts, lib/env.ts): which ones are missing, instead of a form that can never work.
import { copy } from "../../copy/console";

export function Unconfigured({ missing }: { readonly missing: readonly string[] }) {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold text-navy">{copy.login.unconfiguredTitle}</h1>
      <p className="text-sm text-slate">{copy.login.unconfiguredLead}</p>
      <ul className="list-disc pl-5 font-mono text-xs text-danger">
        {missing.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </div>
  );
}
