// Form controls of the sign-in screens. Autocomplete hints let password managers do their job
// (`username`, `current-password`, `new-password`, `one-time-code`); nothing here stores a value.
import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { FIELD_CLASS } from "../../components/form-classes";
import { missingPasswordRules, type PasswordRule } from "../../lib/auth/credentials";
import { loginCopy } from "./copy";

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  readonly label: string;
  readonly trailing?: ReactNode;
}

export function Field({ label, trailing, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <input id={id} className={`${FIELD_CLASS} w-full py-2.5 ${trailing ? "pr-20" : ""}`} {...input} />
        {trailing ? <div className="absolute inset-y-0 right-2 flex items-center">{trailing}</div> : null}
      </div>
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, "type" | "trailing">) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      {...props}
      type={visible ? "text" : "password"}
      spellCheck={false}
      autoCapitalize="off"
      trailing={
        <button type="button" className="rounded px-2 py-1 text-xs font-semibold text-cyan-deep hover:bg-cyan-soft" onClick={() => setVisible((shown) => !shown)} aria-pressed={visible}>
          {visible ? loginCopy.password.hide : loginCopy.password.show}
        </button>
      }
    />
  );
}

export function CodeField({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <Field
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/[^\d\s]/g, "").slice(0, 7))}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]*"
      placeholder="000000"
      required
    />
  );
}

/** The pool's password policy as a checklist that ticks while the person types. */
export function PasswordRules({ password }: { readonly password: string }) {
  const missing = new Set<PasswordRule>(missingPasswordRules(password));
  const rules = Object.entries(loginCopy.password.rules) as Array<[PasswordRule, string]>;
  return (
    <div className="rounded-md bg-paper px-3 py-2 text-xs text-slate">
      <p className="font-medium">{loginCopy.password.rulesTitle}</p>
      <ul className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {rules.map(([rule, text]) => {
          const met = password.length > 0 && !missing.has(rule);
          return (
            <li key={rule} className={met ? "text-success" : undefined}>
              <span aria-hidden="true">{met ? "✓ " : "· "}</span>
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ErrorNote({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}

export function NoticeNote({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
      {children}
    </p>
  );
}

export function SubmitButton({ busy, children }: { readonly busy: boolean; readonly children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex w-full items-center justify-center rounded-md bg-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-navy-soft disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? loginCopy.working : children}
    </button>
  );
}

export function LinkButton({ onClick, children }: { readonly onClick: () => void; readonly children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-sm font-medium text-cyan-deep underline-offset-2 hover:underline">
      {children}
    </button>
  );
}

/** The step's title: the page heading on the login screen, a sub-heading inside a drawer. */
export function StepHeading({ title, lead, inDrawer = false }: { readonly title: string; readonly lead?: string; readonly inDrawer?: boolean }) {
  const Heading = inDrawer ? "h3" : "h1";
  return (
    <div>
      <Heading className={inDrawer ? "text-lg font-semibold text-navy" : "text-2xl font-semibold text-navy"}>{title}</Heading>
      {lead ? <p className="mt-1.5 text-sm text-slate">{lead}</p> : null}
    </div>
  );
}
