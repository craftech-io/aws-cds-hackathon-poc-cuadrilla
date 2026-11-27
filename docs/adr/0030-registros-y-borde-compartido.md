---
status: accepted
---

# Registros de 14 días, línea de acceso, decisiones de seguridad con nombre y borde compartido `demos-borde`

Decisión del dueño del 2026-11-27, común a las demos de la cuenta Demos (especificación "Registros y observabilidad de las demos"). Después de los ataques del mismo día (altas en serie, el código por SMS pasado con un número virtual, una cuenta deshabilitada que siguió entrando), hace falta que un agente pueda leer los registros días después e investigar un incidente sin adivinar. La parte compartida de la cuenta (los registros de la web ACL `demos-borde`, la entrega de SMS, las invocaciones de modelos, las operaciones de AWS, los eventos de correo y la guía `craftech/seguridad-demos/observabilidad.md`) la crea el proyecto `craftech/demos` del repo `labs`. Este ADR es lo que hace Cuadrilla. Complementa ADR-0028 §6 (solo logs), cambia su retención y reemplaza la ACL de borde propia de ADR-0025 §4.

## La decisión

### 1. Retención de 14 días, en un solo lugar

- `infra/log-retention.ts` (`LOG_RETENTION_DAYS = 14`, `FUNCTION_LOG_RETENTION = "2 weeks"`) es la única fuente: las Lambdas por el `$transform` de `sst.config.ts`; el grupo `live` del runtime del Harness (`infra/agentcore.ts`, `AGENT_LOG_RETENTION_DAYS`); el `…-DEFAULT` por la configuración manual de `docs/architecture.md` §17 ítem 15 (el operador vuelve a correr su comando con `--retention-in-days 14`). Antes eran 30 días.
- Excepciones: ninguna en esta app. La auditoría vive en la tabla `AuditLog`, no en un grupo de registros, y ningún grupo tiene una retención menor por privacidad. `aws/spans` es de la cuenta (§17 ítem 2) y queda fuera.
- `infra/logs-only.test.ts` falla si un módulo fija otra retención.

### 2. Línea de acceso del `Bff`

- `packages/bff/src/routers/access-log.ts` envuelve el handler (`routers/handler.ts`): una línea por pedido al terminar, también para los rechazos del borde (`403` de origen, `400` de la forma del alta), las rutas desconocidas y los fallos (`500`).
- Forma, con los nombres en inglés del repo (`lib/log.ts` escribe `message`): `{"message":"access","route","method","status","ip","userAgent","sub","ms"}` más `correlationId`. Equivale a `{"msg":"acceso","ruta","metodo","estado","ip","agente","sub","ms"}` de la guía de la cuenta; se filtra por `message = "access"`.
- `ip`: el visor que nombró CloudFront (`CloudFront-Viewer-Address`, `routers/edge.ts` `viewerIpOf`, la misma que usan los topes del alta y del SMS) una vez que el encabezado de origen coincidió; en un pedido que no pasó por CloudFront (rechazado por origen), la dirección que llamó a la Function URL (`requestContext.http.sourceIp`), porque su encabezado de visor sería su propia palabra. Nunca `x-forwarded-for`.
- `sub`: el del id token que `createContext` ya verificó (`noteAccessSub`); nada decodifica un token para el registro.
- Nunca cuerpo, query, token, `authorization`, email ni teléfono; ruta (≤ 120) y agente (≤ 80) sin caracteres de control ni saltos de línea, y el agente pasa además por el enmascarador de `lib/log.ts`.
- La única entrada HTTP pública es el `Bff`. Las Function URL de los mocks son `authorization: "iam"` y no escriben la línea.
- **La IP queda en claro** en esa línea, como pide la especificación, durante los 14 días del grupo. El aviso de privacidad (versión `2026-11-27`) dice que la aplicación solo guarda una huella de la IP por 48 horas y que los registros técnicos enmascarados duran 30 días: hay que actualizarlo (versión nueva y validación legal, `docs/pending.md` P-06) antes de publicar este cambio. Ninguna otra línea lleva la IP.

### 3. Decisiones de seguridad con nombre

Cada vez que el servidor frena algo por una regla de seguridad escribe una línea con un `metric` fijo, el `reason` y nada personal:

| Decisión | `metric` | Dónde |
|---|---|---|
| Segundo factor pendiente | `SecondFactorPending` | `routers/trpc.ts` (`AUTH_REFUSAL_METRIC` de `auth/errors.ts`) |
| Cuenta bloqueada | `AccountBlocked` | ídem |
| Cruce de inquilino | `CrossTenantDenied` | ídem (además del `AuditLog DENY CROSS_ISP`) |
| Otros rechazos de la puerta | `UserInactive`, `RoleDenied`, `RecentLoginRequired`, `AuthRefused`, `AuthUnavailable` | ídem |
| Tope de SMS alcanzado (cuál) | `SmsCapHits` con `reason` `SMS_*_LIMIT` | `phone/decisions.ts` |
| Número o código rechazado | `PhoneCodeRefused` con `reason` (`PHONE_COUNTRY_NOT_ALLOWED`, `PHONE_NOT_PERSONAL`, `PHONE_INVALID`, `PHONE_IN_USE`, `PHONE_LOCKED`, `CODE_EXHAUSTED`, `CODE_EXPIRED`, `RESEND_TOO_SOON`, `ACCOUNT_BLOCKED`, `SMS_NOT_DELIVERABLE`, …) | ídem |
| Alta rechazada (motivo) | `SignupRejected` con `reason` (`DISPOSABLE`, `EMAIL_RESERVED`, `EMAIL_DOMAIN`, `DISPOSABLE_MX`, `DISPOSABLE_MX_ADDRESS`, `PHONE_INVALID`, `PHONE_NOT_PERSONAL`, `PHONE_COUNTRY_NOT_ALLOWED`, `RATE_LIMITED`, `CAP_REACHED`, …) | `signup/start.ts` |
| Topes de costo | `TurnCapHits`, `SimulatorCapHits`, `GlobalCapHits`, `GuestSignupCapHits`, `KillSwitchActive` | ya existían (ADR-0019) |

### 4. Borde compartido `demos-borde`

- El Router deja de crear su web ACL: `infra/waf.ts` busca `demos-borde` por nombre en cada deploy (`aws.wafv2.getWebAclOutput({ name: "demos-borde", scope: "CLOUDFRONT" })`) y `infra/web.ts` pone su ARN en la distribución (`transform.cdn`, `webAclArn`), como Brain y CraftHealth. Tiene que existir antes del deploy. La ACL propia `aws-cds-hackathon-poc-cuadrilla-poc-edge` se borra con ese deploy.
- La ACL del user pool (`…-poc-auth`) queda como está.
- Reglas de `demos-borde`: lista de bloqueo manual, reputación de IP, lista de IP anónimas en conteo (solo etiquetas), alta o recuperación desde un proveedor de hosting bloqueada, 20 pedidos por IP cada 5 minutos en `signup.`/`password.`, 30 en las rutas del código por SMS y 5000 en `/api/`. Las rutas del código de Cuadrilla son `phone.status`, `phone.sendCode`, `phone.verifyCode`, `phone.carrySession` y `phone.endSession`: todas bajo `phone.`, que la regla ya cubre.
- La web manda el pase en el encabezado `authorization` (`Bearer <id token>`), que los registros del borde tachan.
- **Rol de despliegue** (`infra/bootstrap/ci-role.yaml`, política `DeployEdgePolicy`): `SharedEdgeWafLookup` (`wafv2:ListWebACLs` sobre `*`) y `SharedEdgeWafRead` (`wafv2:GetWebACL` sobre `global/webacl/demos-borde/*`). Borrar la ACL vieja ya lo permite `WebAclsOfThisApp` (`<app>-*`). Ninguna `Description` cambia. El operador aplica el bootstrap a mano antes de fusionar.
- **Lo que se pierde de la ACL propia** y qué lo cubre:

  | Regla propia | Qué hacía | Ahora |
  |---|---|---|
  | `ChallengeSignup` + `BotControlSignup` | Challenge silencioso del alta (token del SDK de AWS WAF) y la URL de integración que lo hacía posible | Se pierde. La web ya no recibe la URL (`VITE_WAF_INTEGRATION_URL` vacía) y usa el `fetch` simple (`lib/waf-token.ts` lo resuelve sin token). Lo cubren el tope de 40 altas por día, los límites por IP y por persona (`signup/limits.ts`), el ticket del alta y el código por SMS. Para recuperarlo habría que sumar Bot Control dirigido y un Challenge al borde compartido (≈ USD 10 por mes más el costo por pedido) y pasar su URL de integración a cada demo |
  | `AnonymousIpSignup` (encabezado `cuadrilla-anon`) | Marcaba las IP anónimas para que `signup.start` les aplique 1 alta por hora y 30 por día | Se pierde: la ACL compartida solo etiqueta, y las etiquetas no llegan al origen. El código del BFF que lee el encabezado sigue (`routers/edge.ts`) y vuelve a actuar si `demos-borde` suma una regla que inserte un encabezado para las IP anónimas en el alta (propuesta). Las IP de hosting ya quedan bloqueadas en el alta por `HostingSignup` |
  | `RateSignupPerIp` (10 cada 5 min) | Tasa del alta por IP | Más laxa en el borde (20); el servidor sigue con 5 por IP por hora |
  | `RatePerIp` (1.000 cada 5 min) | Tasa general | Más laxa (5000 en `/api/`). Las rutas que llaman a un modelo (simulador, validación de fotos, transcripción) siguen con sus topes por mundo, por cuenta y globales (ADR-0019), reservados antes de gastar |
  | `AWSManagedRulesAmazonIpReputationList` | Reputación | La tiene `demos-borde` |

- El `QaDriver` deja de leer la ACL de borde (`waf.probe` devuelve la del pool y su asociación); `SC-00/9`, `qa:edge-probes` y el smoke interino esperan ahora la negativa de la app a un formulario vacío (`400 INVALID_FORM`) y el `400` sin cuerpo para un lote, no el Challenge.

## Alternativas descartadas

- **Mantener la ACL propia y además asociar la compartida.** Una distribución de CloudFront tiene una sola web ACL.
- **Registrar la IP como huella.** Cumple el aviso de privacidad actual, pero no deja cruzar la línea con los registros del borde ni cargar la dirección en la lista de bloqueo de `demos-borde`; la especificación pide la dirección.
- **Nombres en español en la línea de acceso.** El repo escribe sus registros en inglés (`message`, no `msg`); la especificación permite respetarlo y documentar la equivalencia.

## Consecuencias

- Los registros duran la mitad; la guía de la cuenta explica cómo leerlos con CloudWatch Logs Insights (README, "Logs").
- Sin Challenge, un bot que no ejecuta JavaScript llega a `signup.start`; lo frenan el servidor y el SMS.
- Antes de fusionar: el operador aplica `infra/bootstrap/ci-role.yaml`, confirma que `demos-borde` existe y actualiza el aviso de privacidad (IP en claro en los registros de 14 días).
