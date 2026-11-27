// Texts of the SMS code screen (docs/landing-spec.md §7.10, ADR-0029), Mexican Spanish (tuteo) and
// English. Every refusal says what to do next; the daily caps and an undeliverable number offer the
// contact of Craftech.
import { CONTACT_URL, type RichText } from "../signup/copy";
import type { PhoneErrorCode } from "./phone-model";

export interface PhoneCopy {
  readonly enrolTitle: string;
  readonly enrolLead: string;
  readonly signInTitle: string;
  readonly signInLead: (masked: string) => string;
  readonly phone: string;
  readonly phoneHint: string;
  readonly send: string;
  readonly resend: string;
  readonly resendIn: (countdown: string) => string;
  readonly sent: (where: string) => string;
  readonly code: string;
  readonly verify: string;
  readonly changeNumber: string;
  readonly signOut: string;
  readonly loading: string;
  readonly retry: string;
  readonly errors: Readonly<Record<PhoneErrorCode, RichText>>;
}

const talkEs = { label: "escríbenos", href: CONTACT_URL, external: true } as const;
const talkEn = { label: "write to us", href: CONTACT_URL, external: true } as const;

export const phoneCopy: Readonly<Record<"es" | "en", PhoneCopy>> = {
  es: {
    enrolTitle: "Verifica tu celular",
    enrolLead: "Te enviamos un código por SMS para confirmar que eres tú. Después te lo pediremos en cada ingreso.",
    signInTitle: "Ingresa el código",
    signInLead: (masked) => `Para entrar te enviamos un código por SMS a tu celular ${masked}.`,
    phone: "Celular",
    phoneHint: "Con el prefijo internacional, por ejemplo +52 55 1234 5678.",
    send: "Enviar código",
    resend: "Reenviar código",
    resendIn: (countdown) => `Puedes pedir otro código en ${countdown}`,
    sent: (where) => `Código enviado a ${where}. Vence en 10 minutos.`,
    code: "Código de 6 dígitos",
    verify: "Verificar",
    changeNumber: "Corregir el número",
    signOut: "Cerrar sesión",
    loading: "Un momento…",
    retry: "Reintentar",
    errors: {
      PHONE_INVALID: ["Revisa el número: escríbelo con el prefijo internacional, + y de 8 a 15 dígitos."],
      PHONE_NOT_PERSONAL: ["Usa un celular personal."],
      PHONE_REQUIRED: ["Escribe el celular que va a recibir el código."],
      PHONE_IN_USE: ["Ese número ya está en uso en otra cuenta. Usa otro celular o ", talkEs, "."],
      PHONE_LOCKED: ["El celular verificado de tu cuenta no se puede cambiar desde aquí. Si lo perdiste, ", talkEs, "."],
      RESEND_TOO_SOON: ["Espera un minuto antes de pedir otro código."],
      CODE_INVALID: ["El código tiene 6 dígitos."],
      CODE_WRONG: ["El código no es correcto. Revisa el SMS e intenta de nuevo."],
      CODE_EXPIRED: ["El código venció. Pide uno nuevo."],
      CODE_EXHAUSTED: ["Demasiados intentos con este código. Pide uno nuevo."],
      SMS_ACCOUNT_LIMIT: ["Tu cuenta ya recibió todos los códigos de hoy: podrás entrar mañana. Si lo necesitas antes, ", talkEs, "."],
      SMS_NUMBER_LIMIT: ["Ese número ya recibió todos los códigos de hoy. Intenta mañana o ", talkEs, "."],
      SMS_IP_LIMIT: ["Desde esta conexión ya se pidieron todos los códigos de hoy. Intenta mañana o ", talkEs, "."],
      SMS_DAILY_LIMIT: ["Hoy no podemos enviar más códigos. Intenta mañana o ", talkEs, " y te preparamos una demo guiada."],
      SMS_FOREIGN_LIMIT: ["Hoy ya no podemos enviar más códigos a números fuera de Latinoamérica y España. Intenta mañana o ", talkEs, " y te preparamos una demo guiada."],
      SMS_NOT_DELIVERABLE: ["No podemos enviar SMS a ese número (algunos países exigen un registro previo). Prueba con otro celular o ", talkEs, "."],
      UNAVAILABLE: ["No pudimos completar el paso en este momento. Intenta de nuevo en unos minutos."],
    },
  },
  en: {
    enrolTitle: "Verify your phone",
    enrolLead: "We'll text you a code to confirm it's you. After that we'll ask for one at every sign-in.",
    signInTitle: "Enter the code",
    signInLead: (masked) => `To sign in we text a code to your phone ${masked}.`,
    phone: "Mobile phone",
    phoneHint: "With the international prefix, for example +1 415 555 0100.",
    send: "Send code",
    resend: "Resend code",
    resendIn: (countdown) => `You can ask for another code in ${countdown}`,
    sent: (where) => `Code sent to ${where}. It expires in 10 minutes.`,
    code: "6-digit code",
    verify: "Verify",
    changeNumber: "Fix the number",
    signOut: "Sign out",
    loading: "One moment…",
    retry: "Try again",
    errors: {
      PHONE_INVALID: ["Check the number: write it with the international prefix, + and 8 to 15 digits."],
      PHONE_NOT_PERSONAL: ["Use a personal mobile phone."],
      PHONE_REQUIRED: ["Type the phone that will receive the code."],
      PHONE_IN_USE: ["That number is already in use by another account. Use another phone or ", talkEn, "."],
      PHONE_LOCKED: ["Your account's verified phone can't be changed here. If you lost it, ", talkEn, "."],
      RESEND_TOO_SOON: ["Wait a minute before asking for another code."],
      CODE_INVALID: ["The code has 6 digits."],
      CODE_WRONG: ["That code isn't right. Check the SMS and try again."],
      CODE_EXPIRED: ["The code expired. Ask for a new one."],
      CODE_EXHAUSTED: ["Too many attempts with this code. Ask for a new one."],
      SMS_ACCOUNT_LIMIT: ["Your account got all of today's codes: you can sign in tomorrow. If you need it sooner, ", talkEn, "."],
      SMS_NUMBER_LIMIT: ["That number got all of today's codes. Try tomorrow or ", talkEn, "."],
      SMS_IP_LIMIT: ["This connection asked for all of today's codes. Try tomorrow or ", talkEn, "."],
      SMS_DAILY_LIMIT: ["We can't send more codes today. Try tomorrow, or ", talkEn, " and we'll set up a guided demo."],
      SMS_FOREIGN_LIMIT: ["We can't send more codes today to numbers outside Latin America and Spain. Try tomorrow, or ", talkEn, " and we'll set up a guided demo."],
      SMS_NOT_DELIVERABLE: ["We can't text that number (some countries require a prior registration). Try another phone or ", talkEn, "."],
      UNAVAILABLE: ["We couldn't complete this step right now. Please try again in a few minutes."],
    },
  },
};
