// What `signup.start` accepts (ADR-0025 §3, ADR-0026): the email, the three optional fields, the language
// of the form, the two consents as the visitor left them and the attribution the landing captured. Never
// the password (it goes from the browser to Cognito only) and never an `origin`: whether a lead is `WEB`
// or `QA` is the server's decision (leads/keys.ts). Every object is strict, so an extra field is refused.
//
// A refusal names the fields that failed and nothing else: never a value of the request, never a zod
// message (it could quote what the visitor typed), never an unknown key (the request chose its name).
import { z } from "zod";
import { ToolError } from "@cuadrilla/shared";
import { ConsentAnswers, LegalLocale } from "@cuadrilla/shared/legal/consents";
import { UTM_PARAMS } from "../leads/attribution";

const Optional80 = z.string().trim().min(1).max(80).optional();
/** Attribution is reduced by leads/attribution.ts: a value out of shape is dropped, never refused. */
const RawAttributionValue = z.string().max(2_048).optional();

const Utm = z.object(Object.fromEntries(UTM_PARAMS.map((param) => [param, RawAttributionValue])) as Record<(typeof UTM_PARAMS)[number], typeof RawAttributionValue>).strict();

export const SignupForm = z
  .object({
    email: z.string().trim().max(254).pipe(z.email()),
    name: Optional80,
    company: Optional80,
    jobTitle: Optional80,
    locale: LegalLocale,
    consents: ConsentAnswers,
    attribution: z.object({ utm: Utm.optional(), referrer: RawAttributionValue }).strict().optional(),
  })
  .strict();
export type SignupForm = z.infer<typeof SignupForm>;

/** `INVALID_FORM` with the failing fields only (`email`, `consents.TERMS_PRIVACY.accepted`, `(root)`). */
export function parseSignupForm(input: unknown): SignupForm {
  const parsed = SignupForm.safeParse(input);
  if (parsed.success) return parsed.data;
  const fields = [...new Set(parsed.error.issues.map((issue) => (issue.code === "unrecognized_keys" ? [...issue.path, "(extra)"] : issue.path).map(String).join(".") || "(root)"))];
  throw new ToolError("INVALID", `the sign-up form is not valid: ${fields.slice(0, 8).join(", ")}`, "INVALID_FORM");
}
