// Texts of the sign-in screens, the recent-login step-up and the optional TOTP enrolment, in Mexican
// Spanish (tuteo); copy.en.ts has the same keys in English (docs/landing-spec.md §7.7). Error texts
// never say whether an email has an account (lib/auth/errors.ts).
import type { AuthFlowErrorCode } from "../../lib/auth/errors";
import type { PasswordRule } from "../../lib/auth/credentials";

/** The shape of a copy object with every text as a plain string: the English copy fills the same keys. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : { readonly [K in keyof T]: Widen<T[K]> };

const es = {
  panel: {
    tagline: "Copiloto de campo en WhatsApp para instaladores de fibra",
    title: "Cada instalación, cerrada con evidencia a la primera.",
    lead: "El instalador pregunta por WhatsApp, con texto o nota de voz; el agente lee la orden y el estado de la ONU, lo guía con el manual citado, valida cada foto y escala a un supervisor cuando hace falta.",
    points: ["La validación manual es siempre de una persona", "Política de contacto en código", "Demo sintética: datos 100 % inventados"],
  },
  credentials: {
    title: "Inicia sesión en la consola",
    lead: "Usa tu email y tu contraseña.",
    email: "Email",
    password: "Contraseña",
    submit: "Iniciar sesión",
    forgot: "Olvidé mi contraseña",
    hint: "Tu usuario se crea por invitación. Si no lo tienes, pídeselo a tu supervisor.",
    tryDemo: { before: "¿Nunca has usado Cuadrilla? ", link: "Prueba la demo" },
    passwordReset: "Listo: tu contraseña cambió. Inicia sesión con la nueva.",
    sessionExpired: "La sesión venció. Inicia sesión de nuevo.",
  },
  password: {
    show: "Mostrar",
    hide: "Ocultar",
    rulesTitle: "La contraseña necesita:",
    rules: {
      length: "12 caracteres o más",
      lower: "una minúscula",
      upper: "una mayúscula",
      number: "un número",
      symbol: "un símbolo (por ejemplo ! # $ -)",
    } satisfies Record<PasswordRule, string>,
    confirm: "Repite la contraseña",
    mismatch: "Las dos contraseñas no coinciden.",
    outerSpaces: "La contraseña no puede empezar ni terminar con un espacio.",
  },
  newPassword: {
    title: "Elige tu contraseña",
    lead: "Es tu primer inicio de sesión: reemplaza la contraseña temporal por una propia.",
    field: "Contraseña nueva",
    submit: "Guardar y seguir",
  },
  mfaSetup: {
    title: "Activa el código de verificación",
    leadRequired: "Tu cuenta pide el código de verificación (TOTP). Se configura una sola vez.",
    leadOptional: "Es opcional y suma una capa de seguridad a tu usuario. Se configura una sola vez.",
    steps: [
      "Abre tu app de autenticación: Google Authenticator, Microsoft Authenticator, 1Password o similar.",
      "Escanea el código QR, o captura la clave a mano.",
      "Escribe el código de 6 dígitos que te muestra la app.",
    ],
    qrLabel: "Código QR para tu app de autenticación",
    manualKey: "Clave para capturar a mano",
    code: "Código de 6 dígitos",
    submit: "Activar",
    skip: "Ahora no",
  },
  totp: {
    title: "Código de verificación",
    lead: "Escribe el código de 6 dígitos que muestra tu app de autenticación.",
    code: "Código",
    submit: "Verificar",
  },
  forgot: {
    title: "Restablece tu contraseña",
    lead: "Escribe el email de tu usuario y te enviamos un código para elegir una contraseña nueva.",
    submit: "Enviar código",
  },
  reset: {
    title: "Revisa tu email",
    lead: (email: string) =>
      `Si ${email} corresponde a un usuario de la consola, te enviamos un código de 6 dígitos. Si no llega en unos minutos, revisa el correo no deseado o pide a tu supervisor que te invite de nuevo.`,
    code: "Código del email",
    submit: "Cambiar la contraseña",
  },
  back: "Volver al inicio de sesión",
  otherUser: "Iniciar sesión con otro usuario",
  working: "Un momento…",
  errors: {
    INVALID_CREDENTIALS: "El email o la contraseña no son correctos. Si no recuerdas la contraseña, puedes restablecerla.",
    INVALID_CODE: "El código no es válido o ya venció. Intenta con el que muestra ahora.",
    WEAK_PASSWORD: "La contraseña no cumple los requisitos.",
    SESSION_EXPIRED: "Pasó demasiado tiempo. Empieza de nuevo con tu email y tu contraseña.",
    TOO_MANY_ATTEMPTS: "Demasiados intentos. Espera unos minutos y vuelve a intentar.",
    UNAVAILABLE: "No pudimos comunicarnos con el servicio de inicio de sesión. Revisa tu conexión e intenta de nuevo.",
    UNSUPPORTED: "Tu usuario pide un método de verificación que la consola no admite. Pide ayuda a tu supervisor.",
    DIFFERENT_USER: "Ese no es el usuario de esta sesión. Confirma con el tuyo.",
  } satisfies Record<AuthFlowErrorCode, string>,
  stepUp: {
    title: "Confirma que eres tú",
    lead: "La validación manual de evidencia pide haber iniciado sesión en los últimos 15 minutos. Confirma con tu contraseña.",
    done: "Listo. Ya puedes volver a intentar la acción.",
  },
  enroll: {
    title: "Código de verificación",
    done: "Código activado. Desde el próximo inicio de sesión te lo vamos a pedir.",
    unavailable: "No pudimos preparar el código de verificación. Intenta de nuevo en unos segundos.",
    retry: "Reintentar",
  },
  close: "Cerrar",
  legal: { privacy: "Privacidad", terms: "Términos" },
  lang: { label: "Idioma", switchTo: "English", short: "EN" },
} as const;

export type LoginCopy = Widen<typeof es>;

/** The sign-in's texts in Mexican Spanish (the console's language, and the default of `/login`). */
export const loginCopy: LoginCopy = es;
