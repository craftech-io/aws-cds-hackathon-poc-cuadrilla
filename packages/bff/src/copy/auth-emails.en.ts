// The authentication emails in English (ADR-0025 §1): the same four messages and the same keys as
// copy/auth-emails.ts, chosen by the `locale` the visitor picked on the sign-up form. Neutral brand in
// every mode; nothing the visitor wrote is ever part of them.
import type { AuthEmailTexts } from "./auth-emails";

export const AUTH_EMAILS_EN: AuthEmailTexts = {
  htmlLang: "en",
  syntheticTag: "(synthetic demo)",
  disclaimer: "Cuadrilla is a demo with synthetic data: the operator, the manual, the policies, the people and the work orders are fictitious.",
  poweredBy: "Powered by",
  codeLabel: "Your code",
  SIGN_UP: {
    subject: "Your code to create your Cuadrilla account",
    title: "Confirm your email",
    lead: "Use this code to finish creating your Cuadrilla test account, the WhatsApp field copilot for fiber installers.",
    expiry: "The code expires in 24 hours.",
    ignore: "If you didn't ask for this account, ignore this email: nothing is created without the code.",
  },
  RESEND_CODE: {
    subject: "Your new Cuadrilla code",
    title: "Your new code",
    lead: "Use this code to confirm your Cuadrilla test account.",
    expiry: "The code expires in 24 hours.",
    ignore: "If you didn't ask for this account, ignore this email: nothing is created without the code.",
  },
  FORGOT_PASSWORD: {
    subject: "Your code to reset your Cuadrilla password",
    title: "Reset your password",
    lead: "Use this code in Cuadrilla together with your new password.",
    expiry: "The code expires in one hour.",
    ignore: "If you didn't ask for it, ignore this email: your password hasn't changed.",
  },
  ADMIN_CREATE_USER: {
    subject: "Your access to the Cuadrilla console",
    title: "Welcome to Cuadrilla",
    lead: "You've been invited to the Cuadrilla console, the WhatsApp field copilot for fiber installers. These are your details for your first sign-in:",
    usernameLabel: "Your username",
    passwordLabel: "Temporary password",
    firstSteps: "Sign in with your username and the temporary password; then choose a password of your own.",
    button: "Go to the console",
    expiry: "The temporary password expires in 7 days.",
    ignore: "If you weren't expecting this invitation, ignore this email.",
  },
};
