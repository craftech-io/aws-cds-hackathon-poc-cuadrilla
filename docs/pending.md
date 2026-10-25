# Pendientes fuera de nuestras manos

Solo lo que depende de alguien fuera del equipo de agentes (el CTO, Meta, AWS Partner Central, Devpost). Todo lo demás está en `docs/build-plan.md`. Cada entrada se cierra con fecha y quién la cerró en la columna "Estado" (`Cerrado el AAAA-MM-DD por <quién>`): `npm run channels:check-modes` lee esa columna y deja pasar `live` en los transportes de WhatsApp solo si la fila de P-01 dice "Cerrado" (P-01 es un paso operativo: su estado empieza con "Paso operativo ·" y pasa a "Cerrado…" cuando se ejecuta). Una decisión parcial dentro de un pendiente abierto se anota después de "Abierto ·".

| # | Pendiente | Dueño | Estado | Qué falta |
|---|---|---|---|---|
| P-01 | Habilitar el transporte vivo de WhatsApp en el stage: número y WABA propios de Cuadrilla, display name, plantillas aprobadas y destino de eventos | CTO (cuenta de Meta y número); `devops` ejecuta los scripts; `qa` prueba en vivo | Paso operativo · el canal está implementado sobre AWS End User Messaging Social y se prueba de punta a punta en el simulador de teléfono de la consola; opción A (WABA propia) decidida y datos de la plataforma verificados el 2026-09-26; número y WABA nuevos decididos por el CTO el 2026-10-06 (ADR-0028); no bloquea ningún otro trabajo | §1 |
| P-02 | Oportunidad ACE de la submission | CTO | Cerrado el 2026-09-26 por el CTO (oportunidad `O28893592`) | — (§2 registra el resultado) |
| P-03 | Proyecto en Devpost, instrucciones de prueba privadas y credenciales de las cuentas invitadas `guest-NN` | CTO con el operador | Abierto · el orquestador crea el borrador con la cuenta del CTO (2026-09-26) | §3 |
| P-04 | Video de 3 minutos | CTO | Abierto | §4 |
| P-05 | Marca pública, display name de WhatsApp y nombre de la submission | CTO | Cerrado el 2026-09-26 por el CTO (modo `cobrand`; display name "Craftech"; submission "Cuadrilla") | — (§5 registra la decisión y la carga) |
| P-06 | Datos del responsable, vía de contacto de privacidad, destinatario del aviso de lead, validación legal del aviso de privacidad y los términos (con la eventual inscripción de la base ante la autoridad de control, Ley 25.326) y procedimiento de borrado fuera de la tabla | CTO (legal de Craftech) | Abierto · ítems 1, 2 y 4 cerrados el 2026-10-06 por el CTO (ADR-0027: Craftech, Ciudad Autónoma de Buenos Aires, sales@craftech.io; aviso a la casilla del CTO en `LeadConfig`); ítems 3 y 5 abiertos, sin bloquear | §6 |
| P-07 | Umbral de costo por conversación (`IspSettings.costBudgetUsdPerConversation`) y confirmación de la alarma `AgentSpendHourly` (USD 20 por hora) y del presupuesto del proyecto (USD 300 por mes) | CTO | Cerrado el 2026-10-14 por el CTO: sin umbral (sin umbral de costo por conversación, sin alarma de gasto del agente y sin presupuesto del proyecto) | — (§7 registra la decisión y lo que cambió) |
| P-08 | Reaplicar el bootstrap de CI (`qa-runner` con sesiones de hasta 7200 s), fijar la variable `QA_RUNNER_SESSION_SECONDS=7200` y cargar el secreto `BFF_FUNCTION_URL` | Operador con su profile | Cerrado el 2026-10-10 por el operador (bootstrap reaplicado, `qa-runner` con `MaxSessionDuration` 7200 verificado con `get-role`; variable en 7200; secreto `BFF_FUNCTION_URL` cargado desde el estado de SST del app) | — (§8 registra los pasos) |

## 1. Transporte vivo de WhatsApp (P-01, paso operativo)

El canal de WhatsApp está **implementado sobre AWS End User Messaging Social**: adaptador, transporte vivo, plantillas como código, notas de voz y fotos entrantes, eventos por SNS y los scripts de los pasos 6 a 8. Se prueba de punta a punta en el **simulador de teléfono** de la consola, que entra por el mismo sobre de eventos, la misma política, el mismo agente y el mismo pipeline de salida (ADR-0002). Habilitar el transporte vivo en el stage es un **paso operativo** con un **número y una WABA nuevos, solo de Cuadrilla** (decisión del CTO del 2026-10-06, ADR-0028), que el CTO ejecuta con su cuenta de Meta cuando lo decide; no frena ningún otro trabajo.

**Cómo se describe en público** (README, landing, materiales de la submission, decisión del CTO del 2026-10-25): WhatsApp está implementado sobre AWS End User Messaging Social y se prueba en el simulador de teléfono de la consola. Ningún material afirma un número vivo ni presenta el transporte vivo como algo en espera.

### 1.1 Hechos de la plataforma (verificados contra la documentación de AWS y de Meta el 2026-09-26)

| Tema | Hecho | Consecuencia para Cuadrilla |
|---|---|---|
| Alta | Registro embebido (embedded signup) de Meta dentro de la consola de AWS End User Messaging Social | Lo hace el CTO con su cuenta de Meta (paso 5); no hay API para el alta |
| Destino de eventos | Un topic SNS **estándar (no FIFO)** cuya política permite `sns:Publish` a `social-messaging.amazonaws.com`. **Un solo destino por WABA**, compartido por todos sus números; se puede cambiar después con `PutWhatsAppBusinessAccountEventDestinations` | Con la opción A el destino es nuestro topic `aws-cds-hackathon-poc-cuadrilla-wa-inbound` (estándar, creado por la IaC, WP-24). `waba-event-destination.ts` sigue abortando ante otro destino u otros números |
| Forma del evento | `context.MetaPhoneNumberIds[]` (`metaPhoneNumberId` + `arn`) y `whatsAppWebhookEntry`, un **string** JSON con `changes[].value.metadata.phone_number_id` | Coincide con `docs/architecture-integrations.md` §4.2; el filtro por número corre sobre esos campos antes de cualquier parseo de mensajes (§4.4) |
| Portfolio sin verificar | Máximo **2 números** y **250 usuarios únicos por 24 h** en conversaciones iniciadas por la empresa, compartidos por todo el portfolio de Meta Business. La verificación del negocio puede tardar hasta 2 semanas | Otras POC de Craftech compiten por esos 2 números (riesgo, abajo). La demo necesita 1 número y pocos usuarios iniciados por la empresa (teléfonos del equipo y altas por código de invitados) |
| Número | Viables: (1) número DID de EE. UU. de **Amazon Connect**, reclamado al instante y verificado con el código por **llamada de voz** (todo en AWS); (2) **SIM prepago**. No viables a tiempo: números de SMS de End User Messaging (sin números largos de México ni de Argentina; un toll-free de EE. UU. exige un registro de hasta 15 días hábiles) y números de proveedores de WhatsApp ajenos a AWS (no se pueden vincular a EUM Social) | El número de Amazon Connect sería un recurso `aws.connect.*` de la configuración del CTO, **fuera de este app y de su IaC** (`docs/architecture.md` §17, ítem 10); Cuadrilla solo recibe sus dos ids como secretos |
| Plantillas | Se crean en la consola de EUM Social o con `CreateWhatsAppMessageTemplate`; la revisión de Meta lleva de minutos a 24 h | Camino declarado: `scripts/channels/whatsapp-templates.ts` (paso 8), que además guarda id, estado y categoría |
| Precio | Meta cobra por mensaje desde el 2025-07-01 (plantillas fuera de la ventana). **Desde el 2026-10-01 cobra también los mensajes dentro de la ventana** (montos chicos) | `RATECARD` `whatsapp:MX:service` deja de valer 0 (WP-49, `docs/seed-spec.md` §12); ADR-0019 lo incorpora al costo por conversación |

### 1.2 Pasos

1. **WABA: opción A, decidida el 2026-09-26.** Una WhatsApp Business Account propia para Cuadrilla, con su destino de eventos en el topic estándar `aws-cds-hackathon-poc-cuadrilla-wa-inbound`. La opción B (la misma WABA que otra POC, con otro número) queda descartada: exigía un topic neutral compartido y un ADR nuevo. Cuadrilla igual descarta los eventos de otros números (defensa, ADR-0002) y nunca reemplaza el destino de una WABA que tenga otro.
2. **Display name "Craftech"** (P-05, cerrado). Coincide con el nombre del portfolio, que es el camino de aprobación más simple. Se carga en el alta (paso 5).
3. **Portfolio de Meta Business** de Craftech con verificación del negocio y en dos pasos. **Arranca ya** (hasta 2 semanas). Sin verificación, el portfolio admite 2 números y 250 usuarios únicos por 24 h iniciados por la empresa, compartidos con las otras POC de Craftech: el CTO reserva uno de esos 2 números para Cuadrilla o completa la verificación antes del paso 4. Dueño: CTO.
4. **Número de teléfono** que no esté registrado en la app de WhatsApp (si lo estuvo, borrar la cuenta y esperar). Opción recomendada: un DID de EE. UU. de Amazon Connect en `craftech-demos`, reclamado desde la consola de Amazon Connect por el CTO y verificado con el código por llamada de voz (el número y su instancia de Connect son de la configuración del CTO, no de este app: no entran en `infra/` ni en el rol de CI). Alternativa: SIM prepago que reciba el código por SMS o llamada. No usar números de SMS de End User Messaging ni de proveedores de WhatsApp ajenos a AWS (§1.1). Dueño: CTO.
5. **Alta por registro embebido** en la consola de AWS End User Messaging Social en `craftech-demos` (`us-east-1`): vincular el portfolio, crear la WABA de Cuadrilla, registrar el número, cargar el display name "Craftech", aceptar los términos de Meta. Si la consola pide el destino de eventos, elegir el topic `aws-cds-hackathon-poc-cuadrilla-wa-inbound` (existe desde el deploy de WP-24); si no, queda para el paso 7. Dueño: CTO con `devops` presente. Verificación: `aws --profile craftech-demos socialmessaging list-linked-whatsapp-business-accounts`.
6. **Ids del número y secretos**: `aws --profile craftech-demos socialmessaging get-linked-whatsapp-business-account --id <WabaId>` devuelve, por número, `phoneNumbers[].phoneNumberId` (**id de AWS**, `phone-number-id-<32 hex>`), `phoneNumbers[].metaPhoneNumberId` (**id de Meta**, numérico) y `phoneNumbers[].arn`. Con el operador presente y sin pegar valores en ningún chat: `npx sst secret set WabaId <id> --stage poc`, `npx sst secret set WhatsAppPhoneNumberId <phoneNumberId> --stage poc` (envíos, media e IAM) y `npx sst secret set WhatsAppMetaPhoneNumberId <metaPhoneNumberId> --stage poc` (filtro de entrada). `npm run channels:waba-check -- --stage poc` verifica que el ARN que arma `whatsappPhoneArn()` es igual a `phoneNumbers[].arn` y que los dos secretos tienen la forma correcta. El operador actualiza el parámetro `WhatsAppPhoneNumberArn` del bootstrap de CI (`aws cloudformation deploy … --parameter-overrides WhatsAppPhoneNumberArn=<arn>`). Dueño: `devops`.
7. **Destino de eventos**: `npm run channels:waba-event-destination -- --stage poc` sin `--apply` primero: lee `get-linked-whatsapp-business-account` y aborta si `eventDestinations` tiene un ARN distinto de nuestro topic o si la WABA tiene números que no son el nuestro; si está limpio (o ya apunta a nuestro topic desde el paso 5), `--apply` (idempotente, con el profile del operador; ningún rol de CI ni del app tiene esa acción). Verificación: `aws --profile craftech-demos socialmessaging get-linked-whatsapp-business-account --id <WabaId>` (`eventDestinations` = el ARN de nuestro topic, único destino de la WABA). Dueño: `devops`.
8. **Plantillas**: `npm run channels:whatsapp-templates -- --stage poc --apply` sube la muestra sintética del encabezado de documento (`CreateWhatsAppMessageTemplateMedia`) y crea las 6 plantillas `UTILITY` `es_MX` de `docs/architecture-integrations.md` §4.5 (`ordenes_del_dia`, `caso_escalado`, `caso_reasignado`, `alerta_seguridad`, `respuesta_supervisor`, `acta_instalacion`; ninguna nombra a la operadora) con sus ejemplos de parámetros, y guarda id, estado y categoría. **Primero una sola** (`--only ordenes_del_dia`) para medir el tiempo de revisión de Meta (minutos a 24 h). La consola de EUM Social también crea plantillas, pero el script es el camino declarado porque registra id, estado y categoría en `Reference/TEMPLATE#WHATSAPP`. Verificación: `aws --profile craftech-demos socialmessaging list-whatsapp-message-templates --id <WabaId>` → todas `APPROVED` y `UTILITY`. Si Meta rechaza o recategoriza una, `architect` ajusta el texto en `packages/bff/src/copy/templates.ts` y se repite; mientras tanto el **plan B** ("TURNO" de los supervisores, "ÓRDENES" de los instaladores) cubre la demo en vivo.
9. **Mundo vivo y teléfonos de demo**: en `SeedOverrides`, `liveWorldClockId = GLOBAL#isp-demo`, `personPhones` (p. ej. `inst-rogelio` y `sup-hector` → teléfonos del equipo) y `demoRecipients`; `npm run seed:load -- --force`. Los mundos de invitado siguen simulados. Dueño: `devops`.
10. **Transporte vivo**: PR que agrega `live` a `ChannelModes.whatsapp.transports` en `infra/channel-modes.ts` y registra P-01 como hecho; CI verifica `channels:check-modes` (P-01 registrado, un solo mundo vivo). Dueño: `devops` con aprobación del CTO.
11. **Prueba viva**: `qa` corre `SC-17` (plantilla, botón, nota de voz real, foto real, acta como documento, estados y categoría, el recorrido del invitado sobre un mundo simulado con el transporte vivo y el alta por código de un teléfono del equipo) y los pasos vivos de FL-091, FL-092, FL-095 y FL-101. Si cierra a tiempo, el video se graba con un teléfono real.

Riesgos que el CTO acepta: rechazo del display name; recategorización de una plantilla a `MARKETING` (el adaptador la detecta y alarma); **los 2 números del portfolio sin verificar ocupados por otras POC de Craftech** si la verificación del negocio no llega a tiempo (respaldo: modo simulado); el límite de 250 usuarios únicos por 24 h iniciados por la empresa, compartido con las otras POC (la demo usa pocos: teléfonos del equipo y altas por código); número deshabilitado sin aviso.

## 2. Oportunidad ACE (P-02) · cerrado

Cerrado el 2026-09-26 por el CTO en AWS Partner Central (cuenta `craftech-root`):

| Campo | Valor |
|---|---|
| Id | **`O28893592`** |
| Tipo | Net-new, creada el 2026-09-26 (dentro del período de la hackathon) |
| Estado | Created / Pending Submission (las preguntas frecuentes de la hackathon exigen solo "Created") |
| Campaña de marketing | "AWS CDS Agentic AI Hackathon -Sept. 2026" |
| Productos | Incluye AWS End User Messaging Social y Amazon SES |
| Cliente | El socio de diseño (nombrado solo en Partner Central, fuera del repo) |

Dónde se usa el id: el formulario de Devpost (§3, paso 6) y el README de la submission que escribe `architect` en la ola 6 (`docs/build-plan.md` §2, cierre). Ningún otro cliente de Craftech se nombra. SNS nunca figura como servicio CDS.

## 3. Proyecto en Devpost y credenciales de invitado (P-03)

1. **En curso (2026-09-26):** el orquestador crea el borrador del proyecto en `aws-cds-partner.devpost.com` con la cuenta del CTO, como organización (Craftech) y con el título "Cuadrilla"; el CTO resuelve el CAPTCHA. La descripción en inglés la prepara `architect`: uso de WhatsApp para el premio de Meta, declaración del scaffolding interno y, por el co-branding (P-05), el nombre del socio con el aviso de demo sintética (el nombre se escribe en Devpost, nunca en el repo).
2. Esperar `SC-18`, `SC-19` y `SC-20` en verde, WP-49 cerrado (tarifas verificadas) y el **ensayo del invitado** del operador (`scripts/guest/rehearsal.ts` en el navegador con `guest-test`: login real, recorrido exprés, capturas).
3. Contar los evaluadores que publique el concurso (NN; 15 si no se publicó, nunca menos de 10). El operador crea `guest-01` a `guest-NN` con `npm run console:invite -- --stage poc --guest <nn>`: contraseña aleatoria de ≥ 24 caracteres **distinta por cuenta**, que el script entrega por un canal privado al CTO (nunca por un chat, el repo ni un log).
4. El CTO carga en el campo privado de instrucciones de prueba: el link `https://cuadrilla.demo.craftech.io/login`, las credenciales y la regla de asignación, en inglés: "Find your name in the Judges list on the hackathon page. Use account guest-NN, where NN is your position in that list sorted alphabetically by last name (01, 02, …). If your position is greater than the number of accounts, use NN = ((position − 1) mod number of accounts) + 1. If the console warns that another session used your world, switch to another guest account instead of resetting. You can also create your own account at https://cuadrilla.demo.craftech.io/signup. The Express track takes about 5 minutes." Con el transporte vivo habilitado (P-01), se agrega: "To try it on your own WhatsApp, open 'Try with my WhatsApp' in the console and send the one-time code it shows to our number; the guest kit there has the story photos and the voice note to forward."
5. **Ventana de las cuentas**: se habilitan al entregar las credenciales y se deshabilitan al cierre del período de evaluación publicado en Devpost (el CTO confirma la fecha; si no se publica, el 2026-11-30) con `aws --profile craftech-demos cognito-idp admin-disable-user`. Fuera de esa ventana, ninguna cuenta de invitado está habilitada.
6. Completar el formulario con el README, el diagrama, el video (P-04), la URL desplegada y el **id ACE `O28893592`** (P-02) antes del 2026-10-28 13:00 PT.

Dueño: CTO con el operador. Verificación: proyecto visible en Devpost; `aws --profile craftech-demos cognito-idp list-users-in-group --user-pool-id <id> --group-name GUEST` (estado de cada cuenta).

**Qué va dónde (ADR-0023).** Las credenciales de las cuentas `guest-NN` van **solo** en el campo privado de instrucciones de prueba del formulario; nunca en la landing, el README, el repo, un log ni un chat. La descripción pública del proyecto en el formulario y el video pueden nombrar el concurso; la app publicada y el README de producto no (la sección `## Submission notes` del final del README sí).

## 4. Video de 3 minutos (P-04)

1. Esperar el cierre de WP-50 ("100 % probada").
2. `devops` reinicia el mundo `GLOBAL#isp-demo` justo antes de grabar (época nueva, memoria vacía, reloj en pausa a las 07:00).
3. Grabar en inglés con el guion de `docs/design-brief.md` §14, incluido el segmento "what is real / what is simulated" y el aviso de demo sintética del co-branding (P-05): la consola y la landing muestran "Cuadrilla for <socio> · Powered by Craftech"; el teléfono es el simulador de la consola, con su rótulo "simulador" (o un teléfono real si P-01 ya se ejecutó). Toda cifra de impacto de negocio va rotulada como meta o supuesto ("goal", "assumption"), nunca como medición; el video puede nombrar el concurso, la app que muestra no.
4. Publicar en YouTube o Vimeo (público o no listado) para el formulario de la submission, y entregar el MP4 y un póster a `typescript-dev`: la landing lo sirve desde el propio sitio (`public/landing/video/`) en su sección de video, antes de la de arquitectura, con `preload="none"`, póster y sin autoplay (ADR-0028, WP-44).

Dueño: CTO.

## 5. Marca pública (P-05) · cerrado

Cerrado el 2026-09-26 por el CTO, que tiene la autorización escrita del socio de diseño para nombrarlo en Devpost, la landing y el video. La decisión queda en ADR-0018 ("Estado").

| Decisión | Valor |
|---|---|
| Modo | **`cobrand`**: "Cuadrilla for <socio> · Powered by Craftech", con el aviso visible de demo sintética |
| Dónde vive el nombre del socio | Solo en el secreto `BrandConfig` y en `Seed/brand/` (runtime). El repo, el README, el código, el seed y el build estático siguen genéricos ("design partner" / "socio de diseño"); `FORBIDDEN_TERMS` conserva el nombre y no hay excepción para el README |
| Display name de WhatsApp | "Craftech" |
| Nombre de la submission | "Cuadrilla" (subdominio, identidad SES y `copy/` sin cambios) |
| Respaldo | `BrandConfig = {"mode":"neutral"}` vuelve a la operadora ficticia por defecto sin commits |
| Alcance (revisión de seguridad del 2026-09-26) | La autorización cubre Devpost, la landing y el video. Los emails de autenticación usan siempre la marca neutral y los mundos de alta propia usan `signupMode` (por defecto `neutral`, ADR-0018); el CTO lo pasa a `cobrand` solo si confirma con el socio que la autorización cubre la consola de cualquier visitante registrado |

Carga (operador con `devops`, sin pegar valores en ningún chat):

1. **Secreto.** `npx sst secret set BrandConfig '<json>' --stage poc` con `{mode: "cobrand", partnerDisplayName, partnerShortName, logoAssetKeys: {onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg"}, disclaimer: {es, en}}` (el JSON se arma localmente desde el brief aprobado, fuera del repo). El texto del aviso es el de `copy/es-MX.ts` con el nombre del socio como parámetro. El próximo deploy de CI lo toma.
2. **Logos.** Los dos SVG públicos del socio (variante para fondo claro y variante para fondo oscuro, ~3,4 KB cada una, verde de marca) se descargaron con la aprobación del CTO a una carpeta local fuera del repo cuya ruta pasa el orquestador. En la carga del seed: `npm run seed:load -- --stage poc --brand-logo-on-light <ruta-local> --brand-logo-on-dark <ruta-local>`. El loader valida cada archivo (SVG bien formado, ≤ 50 KB, sin `<script>`, `<foreignObject>`, atributos `on*` ni referencias externas), lo sube a `Seed/brand/logo-on-light.svg` y `Seed/brand/logo-on-dark.svg` con `ContentType image/svg+xml`, verifica que las claves coinciden con `BrandConfig.logoAssetKeys` y reescribe `Isps/META.displayName` de los mundos existentes (demo y invitado) sin reiniciarlos. Sin esos flags, el loader nunca toca `Seed/brand/` (así la carga de CI no borra los logos). Los archivos nunca se copian al repo ni se nombran en él.
3. **Verificación.** `npx sst secret list --stage poc` (sin compartir valores) · `aws --profile craftech-demos s3api head-object --bucket <Seed> --key brand/logo-on-light.svg` (y `brand/logo-on-dark.svg`) · la landing y la consola muestran "Cuadrilla for <socio> · Powered by Craftech", el logo y el aviso (`SC-18/1`, `landing.spec.ts` en los dos modos). Sin logo, se ve la marca de texto.

Desbloquea la marca de la landing (WP-55, WP-44) y la carga de `BrandConfig`; el resto del build se prueba en los dos modos (`neutral` es el valor inicial de `BrandConfig` y el de los tests locales).

## 6. Privacidad de los leads (P-06)

El alta registra leads reales (ADR-0026). Ítems 1, 2 y 4 cerrados el 2026-10-06 por el CTO (ADR-0027); 3 y 5 siguen con el CTO y no bloquean el build ni la publicación de la demo.

1. **Responsable y domicilio** · Cerrado el 2026-10-06 por el CTO: Craftech, Ciudad Autónoma de Buenos Aires, Argentina (ADR-0027). Sin CUIT ni calle: el CTO no los dio y no se completan.
2. **Vía de contacto de privacidad** · Cerrado el 2026-10-06 por el CTO: sales@craftech.io, con `https://craftech.io/contact/` como vía alternativa, y el borrado autoservicio de la consola. Está en `LeadConfig.privacyContact` y en el texto de la página (versión nueva de `TERMS_PRIVACY`, ADR-0027 "Consequences").
3. **Validación legal** del aviso de privacidad y de los términos con los nueve puntos de ADR-0026 (responsable y domicilio; datos tratados, incluidos la IP en hash, la cookie de WAF y el contenido que el invitado crea en la demo; encargados y la inferencia global del modelo; transferencia internacional (art. 12) a Estados Unidos (región `us-east-1`) y, para la inferencia del modelo, a otras regiones de AWS donde Amazon Bedrock procesa la inferencia global, con el consentimiento expreso de la casilla `TERMS_PRIVACY`, cuyo texto la nombra; finalidades; retención; derechos con sus plazos —acceso en 10 días corridos, rectificación y supresión en 5 días hábiles—, retiro del consentimiento de contacto y la leyenda de la Agencia de Acceso a la Información Pública; canal de contacto) y decisión sobre la **inscripción de la base** en el registro de la autoridad de control si corresponde. · Abierto, sin bloquear.
4. **Destinatario del aviso de lead** · Cerrado el 2026-10-06 por el CTO: su casilla personal `@craftech.io`, ya cargada en `LeadConfig.notifyRecipients` (nunca escrita en el repo). Verificación: `npm run leads:notify-test -- --stage poc` y confirmar que llegó.
5. **Procedimiento de borrado fuera de la tabla**: quién borra, en la casilla que recibe los avisos, el aviso de un lead borrado o vencido (por su `leadId`) y cómo se destruyen los CSV exportados (a más tardar a los 30 días; ADR-0026). · Abierto, sin bloquear; mientras tanto rige lo que fija ADR-0026.

Dueño: CTO. Verificación: `npx sst secret list --stage poc` (sin compartir valores); el aviso de prueba recibido; las páginas legales con la versión de ADR-0027.

## 7. Umbral de costo por conversación (P-07) · cerrado

Cerrado el 2026-10-14 por el CTO: **sin umbral**. No hay umbral de costo por conversación, ni alarma de gasto del agente, ni presupuesto del proyecto. Lo que cambió:

- `IspSettings.costBudgetUsdPerConversation` queda opcional y ningún mundo lo siembra; sin él, Métricas muestra el costo por conversación sin meta y el KPI "Conversaciones sobre el umbral de costo" no existe (`metrics/kpis.ts`). El check de costo de `docs/test-plan.md` §7 informa el costo y nunca da `warn` por falta de umbral.
- Se quitan de la IaC la alarma `AgentSpendHourly` y su métrica `AgentSpendUsd`, el presupuesto `aws-cds-hackathon-poc-cuadrilla-poc-monthly` y, por la regla de solo logs (ADR-0028: una alarma cuesta todos los meses aunque nunca se dispare), las otras cinco alarmas (`TurnCapHitsGlobal` y las cuatro del alta), el destino de CloudWatch del configuration set, el topic `CostAlerts` y la Lambda `CostGuard`, que se quedaban sin uso. El gasto lo siguen acotando los topes de ADR-0019, reservados antes de gastar; los cortes `KILL#*` los enciende y los apaga solo el operador (`npm run ops:kill`).
- El próximo deploy de `main` borra esos recursos; el rol de deploy conserva el permiso sobre `budget/<app>-*` del bootstrap para poder borrar el presupuesto. `SeedOverrides.operatorEmail` ya no se usa; el esquema lo sigue aceptando para que el secreto cargado no falle.

Las tarifas verificadas por WP-49 el 2026-10-10 siguen en `scripts/seed/generate/ratecard.ts` (camino feliz de una orden USD 1,15-1,87), solo como información.

## 8. Operación de CI (P-08) · cerrado

Cerrado el 2026-10-10 por el operador con los tres pasos de abajo. `scenarios.yml` falla al empezar si la variable supera el `MaxSessionDuration` de `qa-runner` del template; el secreto se vuelve a cargar con el paso 3 si `deploy.yml` avisa que quedó viejo.

1. **Bootstrap.** `infra/bootstrap/ci-role.yaml` sube `MaxSessionDuration` de `qa-runner` a 7200 s: una medición de `scenarios.yml` que pasa la hora ya no pierde las credenciales. El operador lo reaplica (`infra/bootstrap/README.md`) y verifica con `aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-cuadrilla-qa-runner`.
2. **Variable.** Después del paso 1: `gh variable set QA_RUNNER_SESSION_SECONDS --body 7200`.
3. **Secreto `BFF_FUNCTION_URL`** (lo usa `SMK/10`; `deploy.yml` avisa si falta o quedó viejo), después del próximo deploy y sin imprimirlo: `AWS_PROFILE=craftech-demos npx tsx --eval 'import("./scripts/qa/inventory.ts").then(async (m) => process.stdout.write((await m.loadInventory()).bffUrl))' | gh secret set BFF_FUNCTION_URL`.
