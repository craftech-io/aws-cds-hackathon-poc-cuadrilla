# Pendientes fuera de nuestras manos

Solo lo que depende de alguien fuera del equipo de agentes (el CTO, Meta, AWS Partner Central, Devpost). Todo lo demás está en `docs/build-plan.md`. Cada entrada se cierra con fecha y quién la cerró en la columna "Estado" (`Cerrado el AAAA-MM-DD por <quién>`): `npm run channels:check-modes` lee esa columna y no deja pasar `live` en los transportes de WhatsApp mientras P-01 no diga "Cerrado". Una decisión parcial dentro de un pendiente abierto se anota después de "Abierto ·".

| # | Pendiente | Dueño | Estado | Qué falta |
|---|---|---|---|---|
| P-01 | Conectar WhatsApp: WABA, número, display name, plantillas aprobadas y destino de eventos (fecha objetivo 2026-10-12) | CTO (Meta, número); `devops` ejecuta los scripts; `qa` prueba en vivo | Abierto · opción A (WABA propia) decidida y datos de la plataforma verificados el 2026-09-26 | §1 |
| P-02 | Oportunidad ACE de la submission | CTO | Cerrado el 2026-09-26 por el CTO (oportunidad `O28893592`) | — (§2 registra el resultado) |
| P-03 | Proyecto en Devpost, instrucciones de prueba y credenciales de jurado | CTO con el operador | Abierto · el orquestador crea el borrador con la cuenta del CTO (2026-09-26) | §3 |
| P-04 | Video de 3 minutos | CTO | Abierto | §4 |
| P-05 | Marca pública, display name de WhatsApp y nombre de la submission | CTO | Cerrado el 2026-09-26 por el CTO (modo `cobrand`; display name "Craftech"; submission "Cuadrilla") | — (§5 registra la decisión y la carga) |

## 1. Conectar WhatsApp (P-01)

Fecha objetivo: **WABA, número y plantillas aprobadas antes del 2026-10-12**, para grabar el video y correr `SC-17` con un teléfono real. La verificación del negocio (paso 3) arranca ya, en paralelo con el build: puede llevar hasta 2 semanas. Si no cierra a tiempo, el modo simulado es el respaldo documentado (ADR-0002) y todo material público lo dice. Hasta que se cierre, el stage solo tiene el transporte simulado y la demo usa el simulador de teléfono.

### 1.1 Hechos de la plataforma (verificados contra la documentación de AWS y de Meta el 2026-09-26)

| Tema | Hecho | Consecuencia para Cuadrilla |
|---|---|---|
| Alta | Registro embebido (embedded signup) de Meta dentro de la consola de AWS End User Messaging Social | Lo hace el CTO con su cuenta de Meta (paso 5); no hay API para el alta |
| Destino de eventos | Un topic SNS **estándar (no FIFO)** cuya política permite `sns:Publish` a `social-messaging.amazonaws.com`. **Un solo destino por WABA**, compartido por todos sus números; se puede cambiar después con `PutWhatsAppBusinessAccountEventDestinations` | Con la opción A el destino es nuestro topic `aws-cds-hackathon-poc-cuadrilla-wa-inbound` (estándar, creado por la IaC, WP-24). `waba-event-destination.ts` sigue abortando ante otro destino u otros números |
| Forma del evento | `context.MetaPhoneNumberIds[]` (`metaPhoneNumberId` + `arn`) y `whatsAppWebhookEntry`, un **string** JSON con `changes[].value.metadata.phone_number_id` | Coincide con `docs/architecture-integrations.md` §4.2; el filtro por número corre sobre esos campos antes de cualquier parseo de mensajes (§4.4) |
| Portfolio sin verificar | Máximo **2 números** y **250 usuarios únicos por 24 h** en conversaciones iniciadas por la empresa, compartidos por todo el portfolio de Meta Business. La verificación del negocio puede tardar hasta 2 semanas | Otras POC de Craftech compiten por esos 2 números (riesgo, abajo). La demo necesita 1 número y pocos usuarios iniciados por la empresa (teléfonos del equipo y altas por código de jurados) |
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
9. **Mundo vivo y teléfonos de demo**: en `SeedOverrides`, `liveWorldClockId = GLOBAL#isp-demo`, `personPhones` (p. ej. `inst-rogelio` y `sup-hector` → teléfonos del equipo) y `demoRecipients`; `npm run seed:load -- --force`. Los mundos de jurado siguen simulados. Dueño: `devops`.
10. **Transporte vivo**: PR que agrega `live` a `ChannelModes.whatsapp.transports` en `infra/channel-modes.ts` y marca P-01 cerrado; CI verifica `channels:check-modes` (P-01 cerrado, un solo mundo vivo). Dueño: `devops` con aprobación del CTO.
11. **Prueba viva**: `qa` corre `SC-17` (plantilla, botón, nota de voz real, foto real, acta como documento, estados y categoría, el recorrido del jurado sobre un mundo simulado con el transporte vivo y el alta por código de un teléfono del equipo) y los pasos vivos de FL-091, FL-092, FL-095 y FL-101. Si cierra a tiempo, el video se graba con un teléfono real.

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

## 3. Proyecto en Devpost y credenciales de jurado (P-03)

1. **En curso (2026-09-26):** el orquestador crea el borrador del proyecto en `aws-cds-partner.devpost.com` con la cuenta del CTO, como organización (Craftech) y con el título "Cuadrilla"; el CTO resuelve el CAPTCHA. La descripción en inglés la prepara `architect`: uso de WhatsApp para el premio de Meta, declaración del scaffolding interno y, por el co-branding (P-05), el nombre del socio con el aviso de demo sintética (el nombre se escribe en Devpost, nunca en el repo).
2. Esperar `SC-18` y `SC-19` en verde, WP-49 cerrado (tarifas verificadas) y el **ensayo del jurado** del operador (`scripts/judge/rehearsal.ts` en el navegador con `judge-test`: login real, recorrido exprés, capturas).
3. Contar los jurados de la lista pública (NN; 15 si no se publicó, nunca menos de 10). El operador crea `judge-01` a `judge-NN` con `npm run console:invite -- --stage poc --judge <nn>`: contraseña aleatoria de ≥ 24 caracteres **distinta por cuenta**, que el script entrega por un canal privado al CTO (nunca por un chat, el repo ni un log).
4. El CTO carga en el campo privado de instrucciones de prueba: el link `https://cuadrilla.demo.craftech.io/login`, las credenciales y la regla de asignación, en inglés: "Find your name in the Judges list on the hackathon page. Use account judge-NN, where NN is your position in that list sorted alphabetically by last name (01, 02, …). If your position is greater than the number of accounts, use NN = ((position − 1) mod number of accounts) + 1. If the console warns that another session used your world, switch to another judge account instead of resetting. The Express track takes about 5 minutes." Con P-01 cerrado, se agrega: "To try it on your own WhatsApp, open 'Try with my WhatsApp' in the console and send the one-time code it shows to our number; the judge kit there has the story photos and the voice note to forward."
5. **Ventana de las cuentas**: se habilitan al entregar las credenciales y se deshabilitan al cierre del período de evaluación publicado en Devpost (el CTO confirma la fecha; si no se publica, el 2026-11-30) con `aws --profile craftech-demos cognito-idp admin-disable-user`. Fuera de esa ventana, ninguna cuenta de jurado está habilitada.
6. Completar el formulario con el README, el diagrama, el video (P-04), la URL desplegada y el **id ACE `O28893592`** (P-02) antes del 2026-10-28 13:00 PT.

Dueño: CTO con el operador. Verificación: proyecto visible en Devpost; `aws --profile craftech-demos cognito-idp list-users-in-group --user-pool-id <id> --group-name JUDGE` (estado de cada cuenta).

## 4. Video de 3 minutos (P-04)

1. Esperar el cierre de WP-50 ("100 % probada").
2. `devops` reinicia el mundo `GLOBAL#isp-demo` justo antes de grabar (época nueva, memoria vacía, reloj en pausa a las 07:00).
3. Grabar en inglés con el guion de `docs/design-brief.md` §14, incluido el segmento "what is real / what is simulated" y el aviso de demo sintética del co-branding (P-05): la consola y la landing muestran "Cuadrilla for <socio> · Powered by Craftech"; el teléfono se muestra con el rótulo "simulador" mientras P-01 siga abierto (o el teléfono real si ya cerró). Toda cifra de impacto de negocio va rotulada "pilot hypothesis — not measured".
4. Publicar en YouTube o Vimeo (público o no listado) y pasar el link a `architect` (se embebe en la landing, arriba del pliegue).

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

Carga (operador con `devops`, sin pegar valores en ningún chat):

1. **Secreto.** `npx sst secret set BrandConfig '<json>' --stage poc` con `{mode: "cobrand", partnerDisplayName, partnerShortName, logoAssetKeys: {onLight: "brand/logo-on-light.svg", onDark: "brand/logo-on-dark.svg"}, disclaimer: {es, en}}` (el JSON se arma localmente desde el brief aprobado, fuera del repo). El texto del aviso es el de `copy/es-MX.ts` con el nombre del socio como parámetro. El próximo deploy de CI lo toma.
2. **Logos.** Los dos SVG públicos del socio (variante para fondo claro y variante para fondo oscuro, ~3,4 KB cada una, verde de marca) se descargaron con la aprobación del CTO a una carpeta local fuera del repo cuya ruta pasa el orquestador. En la carga del seed: `npm run seed:load -- --stage poc --brand-logo-on-light <ruta-local> --brand-logo-on-dark <ruta-local>`. El loader valida cada archivo (SVG bien formado, ≤ 50 KB, sin `<script>`, `<foreignObject>`, atributos `on*` ni referencias externas), lo sube a `Seed/brand/logo-on-light.svg` y `Seed/brand/logo-on-dark.svg` con `ContentType image/svg+xml`, verifica que las claves coinciden con `BrandConfig.logoAssetKeys` y reescribe `Isps/META.displayName` de los mundos existentes (demo y jurado) sin reiniciarlos. Sin esos flags, el loader nunca toca `Seed/brand/` (así la carga de CI no borra los logos). Los archivos nunca se copian al repo ni se nombran en él.
3. **Verificación.** `npx sst secret list --stage poc` (sin compartir valores) · `aws --profile craftech-demos s3api head-object --bucket <Seed> --key brand/logo-on-light.svg` (y `brand/logo-on-dark.svg`) · la landing y la consola muestran "Cuadrilla for <socio> · Powered by Craftech", el logo y el aviso (`SC-18/1`, `landing.spec.ts` en los dos modos). Sin logo, se ve la marca de texto.

Desbloquea WP-44 (landing) y la carga de `BrandConfig`; el resto del build se prueba en los dos modos (`neutral` es el valor inicial de `BrandConfig` y el de los tests locales).
