---
status: accepted
---

# Código por SMS: verificación del celular en el alta y segundo factor en cada ingreso

Decisión del dueño del 2026-11-27, común a las demos públicas de Craftech. Ese día un atacante registró cuentas en serie con casillas descartables (ADR-0025 ya las rechaza por lista y por MX): el correo solo no prueba que hay una persona. Desde ahora ninguna cuenta usa la demo ni cuenta como lead sin un celular verificado por SMS, y el código se pide **en cada ingreso**, para que adivinar o robar una contraseña no alcance para entrar. Complementa ADR-0025 (alta propia) y ADR-0026 (leads) y cambia el momento del aviso de lead.

## La decisión

### 1. Teléfono en el alta

- `signup.start` exige `phone`: formato internacional E.164 de un país de América (`+` y 8 a 15 dígitos; solo `+1` y `+5` desde el 2026-11-27, §12), normalizado sin espacios, guiones, puntos ni paréntesis (`phone/number.ts`); fuera de forma, `PHONE_INVALID`. Se guarda en el inicio pendiente del lead (`pending[<username>].phone`) y la confirmación lo promueve al lead como `phone` **sin verificar**: solo sirve para precargar la pantalla del código.
- El formulario lo pide con el prefijo internacional y lo marca obligatorio. La casilla `TERMS_PRIVACY` (versión `2026-11-27`) dice que el celular se usa para verificar la cuenta con un código por SMS; el aviso de privacidad lo lista entre los datos tratados, nombra a Amazon SNS y la retención del código y de sus contadores.
- El teléfono **no** es un atributo de Cognito: ninguna decisión del repo lee `phone_number` ni `phone_number_verified`, así que el BFF no los fija y el visitante no tiene nada que escribir ahí.

### 2. Dos momentos, un mismo código

- **Enrolamiento** (la fila `Isps/USER#` sin `phoneVerifiedAt`): la pantalla pide el número, precargado con el del alta y editable hasta verificar; el código correcto hace de ese número el celular de la cuenta (`phone`, `phoneVerifiedAt` en la fila del registro, solo donde no había uno: `absent: [phoneVerifiedAt]`).
- **Ingreso** (la fila con celular verificado): el servidor manda el código a ese número, que la pantalla muestra solo por sus últimos cuatro dígitos; un número en el pedido se rechaza (`PHONE_LOCKED`), con la sesión verificada o sin verificar. Cambiar el celular verificado es tarea del operador (`npm run console:phone -- --reset-phone`): el usuario nunca puede, ni desde la web ni con su token.
- Vale para **todas** las cuentas de Cognito: personal interno (`SUPERVISOR`, `OPS`), invitados con credenciales entregadas (`guest-NN`, `guest-test`), cuentas de alta propia nuevas y las que ya existían (al próximo ingreso se enrolan). La única excepción son las cuentas de automatización (§5).
- **Convivencia con el TOTP de Cognito del personal.** El personal conserva la verificación en dos pasos de Cognito (por eso su token conserva `aws.cognito.signin.user.admin`, `auth-triggers/pre-token.ts`) y además pasa el código por SMS: se aplica lo más estricto, los dos factores. El TOTP lo valida Cognito antes de emitir el token; el SMS lo valida el BFF sobre la sesión de ese token. Los invitados no tienen TOTP: el SMS es su segundo factor.

### 3. La verificación vale por sesión

- `Runtime/PHONESESSION#<userId>#<sessionKey>` (`sessionKey` = los primeros 32 hex del SHA-256 del id de sesión del token: `origin_jti`, o `auth-<auth_time>` si falta) marca "esta sesión pasó el código", con TTL al fin de la vida de la sesión (12 h desde el ingreso interactivo, la del refresh token de `ConsoleWeb`). Otro ingreso (otra contraseña tipeada, otro dispositivo) es otra sesión y pide su código; renovar el token mantiene `origin_jti` y no pide nada; `phone.endSession`, que la web llama al cerrar sesión antes de `RevokeToken`, borra la marca.
- **La contraseña pedida otra vez dentro de una sesión que ya pasó** (el ingreso reciente de ADR-0011, `stepUp` de la consola, para la validación manual) da otra sesión de Cognito: la web llama `phone.carrySession` con el id token todavía válido de la sesión anterior y la sesión nueva del **mismo** usuario hereda el pase. Sin una sesión anterior con pase (u otro usuario), `SESSION_NOT_CARRIED` y la pantalla pide el código. No es un ingreso nuevo: quien lo hace ya pasó el código en ese navegador y además volvió a escribir la contraseña.
- **La puerta** (`routers/trpc.ts`, en `resolvePrincipal`): todo principal de Cognito cuya sesión no pasó el código recibe `403 PHONE_VERIFICATION_REQUIRED` en todo procedimiento salvo `PHONE_STEP_PROCEDURES`: `account.session` (quién es; sin reclamar la sesión del mundo, `WORLDSESSION#`) y `phone.status`, `phone.sendCode`, `phone.verifyCode`, `phone.carrySession`, `phone.endSession`. Un contenedor recuerda una sesión pasada un minuto; una no pasada se lee en cada pedido. Los principales del `QaDriver` no tienen sesión de Cognito y no pasan por la puerta.
- **Nada se gasta antes**: ni mundo, ni slot, ni sesión de mundo, ni modelo. La confirmación del email crea la cuenta en `PHONE_PENDING` (sin slot ni pedido a `GuestWorlds`) y el post authentication ya no pide mundos ni generaciones (salvo para cuentas de automatización): eso lo hace el BFF cuando una sesión pasa su código (`guest/sign-in.ts` `ensureWorld`: el slot de una cuenta `PHONE_PENDING`, la generación nueva de un mundo vencido, el mundo de un `guest-NN` que no lo tiene). Una cuenta `PHONE_PENDING` sin lugar pasa a `CAP_FULL` y la portada ofrece "Reintentar".

### 4. El código

- Seis dígitos de `crypto.randomInt`; en `Runtime/PHONECODE#<userId>#<sessionKey>` solo su huella (HMAC-SHA-256 con la subclave `phone-code` de `SessionTokenKey`, ligada a la cuenta y a la sesión), la huella del número, el número mientras se enrola, `attempts`, `sentAt` y `codeExpiresAt`; TTL y comparación de fecha a los 10 minutos.
- Cinco intentos por código, contados con un incremento condicional **antes** de comparar en tiempo constante; el quinto fallo borra el código (`CODE_EXHAUSTED`). Reenvío: un minuto de espera (`RESEND_TOO_SOON`), con una escritura condicional sobre el `sentAt` leído para que dos envíos simultáneos no salgan los dos.
- **Envío** (`phone/sms.ts`): Amazon SNS `Publish` directo al número, `AWS.SNS.SMS.SMSType = Transactional`, SDK v3, 5 s de timeout y **un solo intento** (`CLIENT_TIMEOUTS.sms`): un reintento podría entregar un segundo código. Texto de `copy/phone-code.ts` en el idioma de la pantalla: "Tu código de Cuadrilla es 123456. Vence en 10 minutos." / "Your Cuadrilla code is 123456. It expires in 10 minutes." Un destino que SNS no acepta (país que exige remitente registrado, número inválido o dado de baja) es `SMS_NOT_DELIVERABLE` y la pantalla ofrece el contacto de Craftech; el código de un envío fallido se borra. El puerto `SmsSender` tiene un doble en memoria (`memorySmsSender`) para los tests, los flujos locales y el servidor de UI: ninguna prueba manda SMS reales.

### 5. Cuentas de automatización

- `phoneCheck: "AUTOMATION"` en la fila del registro exime del código a una cuenta que ninguna persona usa y que no puede recibir un SMS (el corredor de escenarios y de pruebas). Solo la pone el operador, una cuenta por vez: `npm run console:phone -- --stage poc --username <usuario> --automation` (y `--human` la saca) y `qa:confirm-signup`, que marca la cuenta de una dirección del puente de QA después de confirmarla. Nunca por dominio de correo, grupo, rol ni nada que el visitante pueda influir: ningún procedimiento la escribe.
- El post authentication de una cuenta marcada hace lo de siempre (mundo, generación, slot), así los escenarios y las pruebas desplegadas siguen corriendo sin SMS.

### 6. Topes (`phone/limits.ts`, un único lugar)

| Contador (`Runtime`) | Tope | Motivo |
|---|---|---|
| `PHONESMS#ACCOUNT#<userId>#<realDay>` | 6 SMS por cuenta por día (enrolamiento e ingresos sumados) | `SMS_ACCOUNT_LIMIT`: la cuenta no ingresa hasta el día siguiente |
| `PHONESMS#NUMBER#<phoneHash>#<realDay>` | 3 por número por día | `SMS_NUMBER_LIMIT` |
| `PHONESMS#IP#<ipHash>#<realDay>` | 5 por IP del visor por día | `SMS_IP_LIMIT` |
| `PHONESMS#GLOBAL#<realDay>` | 40 por día en el stage (150 hasta el endurecimiento, §10) | `SMS_DAILY_LIMIT` |
| `PHONESMS#FOREIGN#<realDay>` | 5 por día en el stage, compartidos por todos los números fuera de la región de casa (§10) | `SMS_FOREIGN_LIMIT`: la pantalla ofrece el contacto de Craftech |

El mismo mecanismo que el alta (`signup/limits.ts` `counterIncrementOp`): los tres del llamador en una transacción con techo, después el del día (y, para un número de fuera de la región de casa, el cupo de fuera, en la misma transacción); 48 h de TTL pasado el período; ninguna clave con el número ni la IP en claro (`phoneHash` con la subclave `account-phone`, `ipHash` con `ip-hash`). Sin la IP del visor (fuera del borde) no se envía nada. La última red es el tope de gasto de SMS de la cuenta (US$50 por mes, configuración de la cuenta compartida).

### 7. Un número, una cuenta

`Runtime/PHONEOWNER#<phoneHash>` (`userId`, sin TTL) se crea al verificar con `ifNotExists`; un número que verificó otra cuenta se rechaza antes de enviar nada y, si dos cuentas compiten, al verificar (`PHONE_IN_USE`, "ese número ya está en uso"). El borrado de la cuenta (`GuestAccountDeletion`) y el `--reset-phone` del operador lo liberan, solo si es de esa cuenta.

### 8. El lead

- El lead de una cuenta de alta propia sigue pasando a `CONFIRMED` al confirmar el email (los usuarios hermanos salen de Cognito como antes), pero **el aviso a Craftech sale recién al verificar el celular**, una sola vez, en el enrolamiento: el BFF escribe `phone` y `phoneVerifiedAt` en el lead (un `UpdateItem` que nombra solo esos atributos, `updatedAt` y `version`, dentro de `BFF_LEAD_ATTRIBUTES`) y `LeadStream` recibe ese `MODIFY` por un filtro propio; el aviso incluye el teléfono verificado. Un lead confirmado sin teléfono verificado no genera aviso (`PHONE_NOT_VERIFIED`).
- Cuenta como lead (`isQualified`) y es contactable un lead con el teléfono verificado, o uno avisado antes de este cambio (`notifyOutcome SENT`): esos ya llegaron a Craftech con la regla anterior.
- El asunto sigue diciendo "NO CONTACTAR" cuando la persona no aceptó el consentimiento de contacto (`CONTACT`).

### 9. Infraestructura

- `sns:Publish` sobre `*` solo para el `Bff` (publicar a un número no tiene ARN), con una denegación de `sns:Publish` sobre `arn:aws:sns:*:*:*` en la misma política: solo sirve para SMS directos (`infra/iam-capabilities.ts` `SMS_CODE_GRANTS`).
- El techo de permisos (`infra/bootstrap/ci-role.yaml`, `DeployBoundary`) suma `sns:Publish` a su sentencia sin recurso (`NoResourceLevelRuntime`); se aplica a mano con el comando de `infra/bootstrap/README.md`. Sin ese cambio aplicado, el envío falla con `AccessDenied` (`SMS_UNAVAILABLE`) y nadie puede pasar el código.
- Configuración de la cuenta, fuera del repo (`docs/pending.md` P-09): la cuenta fuera del sandbox de SMS de SNS, el tope de gasto mensual de SMS en US$50 y, para países que lo exigen (Estados Unidos, India), un remitente registrado.

### 10. Endurecimiento (2026-11-27)

El mismo día en que se publicó el código, un atacante lo pasó en una demo hermana con un número virtual de Países Bajos (rango `+3197`, de máquinas), después de probar números de Estados Unidos y Finlandia, con casillas descartables que la lista no conocía. Cada SMS a Europa cuesta unos US$0,10 y el tope de gasto de SMS de la cuenta es de US$50 por mes, compartido por todas las demos: agotarlo deja a todas sin ingreso. Decisión del dueño:

- **Tope del día**: 40 SMS en el stage (antes 150).
- **Región de casa** (`phone/number.ts` `HOME_PREFIXES`, lista única): Argentina `+54`, Brasil `+55`, Chile `+56`, Colombia `+57`, México `+52`, Perú `+51`, Uruguay `+598`, Paraguay `+595`, Bolivia `+591`, Ecuador `+593`, Venezuela `+58`, Costa Rica `+506`, Panamá `+507`, Guatemala `+502`, El Salvador `+503`, Honduras `+504`, Nicaragua `+505`, República Dominicana `+1809`, `+1829`, `+1849` (España `+34` salió el mismo día, §12). Un número de cualquier otro país de América se sigue aceptando, pero comparte con todos los demás de fuera un cupo de 5 SMS por día en toda la demo (`PHONESMS#FOREIGN#<realDay>`), además de los otros topes; al agotarse, `SMS_FOREIGN_LIMIT`. Un número de casa nunca toca ese contador.
- **Rangos que no son celulares de personas** (`phone/number.ts` `NON_PERSONAL_PREFIXES`, lista única): `+3197` (máquinas, Países Bajos), `+4470` (numeración personal, Reino Unido), `+882`, `+883` (redes internacionales), `+870`, `+881` (satelitales), `+888` y `+979`. Se rechazan al cargar el número en el alta y al escribirlo o corregirlo en el enrolamiento: `PHONE_NOT_PERSONAL`, «Usa un celular personal». Un número ya verificado no se vuelve a evaluar (no lo cambia el usuario, §2).
- **Números de relleno**: los que terminan en siete o más dígitos iguales (`+5491100000000`) son `PHONE_INVALID`.
- **Correo del alta** (ADR-0025 §3): a la lista propia se suma la lista pública del paquete `disposable-email-domains` (1.0.62, solo datos, versión fijada, solo en `packages/bff`; la web no lo importa) y los dominios vistos ese día (`10mail.org`, `emltmp.com`, `emlpro.com`, `vomoto.com`, `blondmail.com`, `tempmail.lol`, `1secmail.com`; `euploading.com` y `guerrillamailblock.com` ya estaban). Los dominios reservados o de prueba, los que el DNS dice que no existen y los que no tienen dónde recibir correo dan la misma respuesta que una casilla descartable (`EMAIL_NOT_ACCEPTED`); el log los distingue. Un MX bajo un dominio descartable también rechaza. El plazo del DNS pasa a 2 s, con un intento por consulta; si el DNS no responde o falla por otra causa, el alta sigue. Las consultas de DNS no necesitan permisos de IAM; las pruebas usan un resolvedor inyectado.
- **Altas del día**: `SIGNUP#GLOBAL#<realDay>` baja de 300 a 40 inicios entre todos los visitantes (ADR-0025 §3): cada inicio, aunque nunca se confirme, crea un usuario de Cognito y manda un email que puede rebotar.

No cambian la infraestructura (`infra/`, bootstrap, permisos, WAF) ni los demás topes.

### 11. Cuenta bloqueada (2026-11-27)

En una demo hermana, una cuenta ya deshabilitada en Cognito siguió pidiendo SMS (once pedidos de código) y usando la demo con su pase vigente: el id token se verifica sin consultar a Cognito y deshabilitar al usuario no lo invalida. Este repo ya leía en cada pedido la fila del registro (`Isps/USER#`, `active`, a lo sumo una vez por minuto por contenedor), pero nada la cambiaba al deshabilitar a alguien en Cognito, y las sesiones que ya habían pasado el código seguían marcadas. Se agrega:

- **Marca de bloqueo** `blockedAt` en la misma fila que ya lee la puerta (`routers/trpc.ts`): una cuenta bloqueada recibe `403 ACCOUNT_BLOCKED` en **todo** procedimiento, incluidos `account.session` y `phone.*`, antes de la puerta del código. Los pasos del código (`phone/flow.ts`) leen además la fila en cada llamada, sin caché: con la marca puesta no sale ningún SMS ni se acepta un código, en el acto. El resto de los procedimientos la ven en el acto o, en un contenedor que leyó la fila en el último minuto, al vencer esa lectura (a lo sumo 60 s).
- **Índice de sesiones** `Runtime/PHONESESSIONS#<userId>` · `<sessionKey>` (TTL igual al de la sesión o del código): cada envío de código y cada pase lo escriben, y el cierre de sesión lo borra. Las marcas `PHONESESSION#<userId>#<sessionKey>` no se pueden listar por cuenta sin recorrer la tabla; el índice permite borrarlas.
- **Script del operador** `npm run console:block -- --stage poc (--username <usuario> | --by-email) (--block | --unblock)` (`scripts/console/block.ts`, `phone/block.ts`), con el profile del operador, nunca CI ni un pedido. `--block`, en este orden: pone `blockedAt`, deshabilita al usuario en Cognito (`AdminDisableUser`), cierra sus sesiones (`AdminUserGlobalSignOut`: ningún refresh) y borra sus marcas de pase y sus códigos pendientes. `--unblock` quita la marca y vuelve a habilitar al usuario (`AdminEnableUser`): la persona ingresa de nuevo y pasa un código nuevo. Con `--by-email` la dirección llega por la entrada estándar o `--email-file` (nunca como argumento) y se busca con `ListUsers`; la salida nombra al usuario de Cognito, nunca la dirección.
- **Web**: la pantalla del código, ante `ACCOUNT_BLOCKED`, muestra solo el aviso "Cuenta bloqueada" con el contacto de Craftech y "Cerrar sesión"; las vistas de la consola traducen el mismo motivo.
- Una sesión que pasó el código antes de que existiera el índice no se borra, pero la marca de bloqueo la corta igual y el cierre de sesiones de Cognito impide renovar su token (15 minutos como máximo). Ningún permiso nuevo: el BFF no lista nada y el script usa el profile del operador.

### 12. Solo países de América (2026-11-27, mediodía)

Decisión del dueño que reemplaza "cualquier país": el código por SMS va **solo a números de América**.

- **América** (`phone/number.ts` `AMERICAS_PREFIXES`, junto a la región de casa): `+1` (Estados Unidos, Canadá y el Caribe) y `+5` (México, Cuba, Centroamérica y Sudamérica).
- Cualquier otro número se rechaza al cargarlo en el alta y al cargarlo o corregirlo en el enrolamiento: `PHONE_COUNTRY_NOT_ALLOWED`, «Por ahora solo aceptamos celulares de países de América. Si necesitas acceso, escríbenos.», con el contacto de Craftech. Se evalúa después de los rangos no personales de §10, que no cambian.
- **Nunca sale un SMS a un número de fuera de América**, tampoco en el ingreso de una cuenta que lo tenía verificado de antes: `phone.sendCode` responde el mismo error antes de reservar topes o enviar; el número lo cambia el operador (`console:phone --reset-phone`).
- **España sale de la región de casa**: quedan los 20 prefijos de Latinoamérica. Los números de América que no son de casa (el resto de `+1`, `+53`, `+509`…) siguen compartiendo el cupo de fuera de 5 SMS por día.
- Los textos de la web (ayuda del celular en el alta y en la pantalla del código) dicen "un celular de un país de América". El consentimiento y el aviso de privacidad no nombraban países, así que no cambian ni cambian de versión.

## Alternativas descartadas

- **Verificar el teléfono una sola vez.** No frena a quien adivina una contraseña. Descartada por el dueño.
- **El MFA por SMS de Cognito.** Necesita un rol de SNS del pool, el atributo `phone_number` escribible y su propio flujo de desafío en la web, y no deja aplicar los topes por número, por IP y del día ni el índice de un número por cuenta. Descartada.
- **Bloquear con `active: false`.** Ese interruptor ya existía y responde `USER_INACTIVE`, que la web trata como un problema de la operadora; el bloqueo necesita su propio motivo para el aviso y una marca que solo pone el operador.
- **Rechazar los números de fuera de la región de casa.** Descartada por el dueño: se aceptan, con un cupo diario compartido chico.
- **Eximir por dominio de correo o por grupo** (por ejemplo, las direcciones `success+qa-…@simulator.amazonses.com`). Cualquiera puede escribir una dirección; la marca va por cuenta y solo del lado del servidor.

## Consecuencias

- Ingresar cuesta un SMS por sesión; los topes y el tope de gasto de la cuenta lo acotan.
- Los specs de interfaz de las vistas pasan la sesión por un puente de prueba del servidor local (`POST /api/__e2e/phone/pass`, solo en `tests/ui-server/app.ts`); la pantalla del código tiene su spec propio (`phone.spec.ts`).
- Un `--reset-phone` no cierra las sesiones ya pasadas de esa cuenta: siguen hasta su vencimiento (12 h como máximo).
- Las cuentas que el operador ya entregó (`guest-NN`) y el personal se enrolan en su próximo ingreso: quien reciba credenciales necesita un celular que reciba SMS.
