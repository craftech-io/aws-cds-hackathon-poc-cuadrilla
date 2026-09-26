// Texts shared by the data-driven views: loading and error states and the refusal of each BFF
// `reason` (packages/bff/src/auth/errors.ts and the routers). The server messages are English and
// technical; what the supervisor reads comes from here.

export const dataCopy = {
  loading: "Cargando…",
  retry: "Reintentar",
  reference: "Código de referencia",
  recentLogin: {
    confirm: "Confirmar con mi contraseña",
  },
  unauthorized: {
    signIn: "Iniciar sesión de nuevo",
  },
  byKind: {
    recentLogin: "La validación manual de evidencia pide haber iniciado sesión con tu contraseña en los últimos 15 minutos.",
    unauthorized: "La sesión venció. Inicia sesión de nuevo.",
    forbidden: "Tu rol no tiene acceso a esta información o acción.",
    notFound: "No encontramos lo que buscabas.",
    conflict: "Alguien ya resolvió esto o cambió mientras lo mirabas. Actualiza y vuelve a intentar.",
    invalid: "Los datos no pasaron la validación.",
    precondition: "La acción no se puede hacer en el estado actual.",
    unavailable: "El servicio no respondió. Intenta de nuevo en unos segundos.",
    network: "No pudimos comunicarnos con la consola. Revisa tu conexión e intenta de nuevo.",
    unknown: "Algo salió mal. Si se repite, comparte el código de referencia con el equipo técnico.",
  },
  byReason: {
    LOGIN_NOT_RECENT: "Pasaron más de 15 minutos desde que iniciaste sesión. Confirma tu contraseña para seguir.",
    ROLE_NOT_ALLOWED: "Tu rol no puede hacer esta acción.",
    CROSS_ISP: "Ese dato no pertenece a tu operadora.",
    USER_INACTIVE: "Tu usuario ya no está activo en la operadora.",
  } as Readonly<Record<string, string>>,
} as const;
