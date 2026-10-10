---
status: accepted
---

# Lecciones del producto hermano: modelo, lecturas precargadas, respuesta siempre, logs y número propio de WhatsApp

Decisión del CTO del 2026-10-06. El producto hermano de Craftech, con el mismo scaffolding, ya está publicado y midió en WhatsApp real lo que este repo todavía no midió: un turno con Claude Opus 5 tardaba 38 a 43 s; con cinco llamadas al modelo y cinco tools en serie, un "hola" tardó 31 s y nunca tuvo respuesta. Las causas y sus arreglos valen igual para Cuadrilla, cuyo instalador espera con las manos ocupadas (ADR-0020). Se portan antes de construir la lógica del producto (ola 3), en WP-64 y en la aceptación de los WP que todavía no se construyeron.

## Lo que mostró la medición del producto hermano

- **El Harness ejecuta en serie las tools que pide una misma respuesta.** En 204 turnos con dos o más tools, ninguno tuvo dos corriendo a la vez. Cada lectura cuesta una vuelta al modelo (2 a 5 s) más la tool (0,8 a 3,5 s con Gateway y Cedar).
- **Un saludo no pasaba G2.** Con "hola" como pregunta, el score de relevancia de cualquier respuesta útil ronda el umbral (0,61 y 0,66 en la reproducción, por debajo en producción); el agente reintentó, se rindió y la persona no recibió nada.
- **La memoria aprendió el error.** En el turno siguiente, el agente recordó que "el sistema rechaza responder un saludo" y no contestó.
- **Un mismo envío pedido dos veces en un turno** salía dos veces.
- **Después de un cambio de modelo**, la actualización de AgentCore Memory falló una vez por propagación de IAM; volver a correr el deploy de CI lo resolvió.

## La decisión

### 1. Modelo: Claude Sonnet 5.5 por un perfil de inferencia de la app

- `HARNESS_MODEL_ID` = **`global.anthropic.claude-sonnet-5-5`** para el Harness y las tres estrategias de Memory. Reemplaza el valor por defecto que fijaba ADR-0020 (`global.anthropic.claude-opus-5`); el resto de ADR-0020 sigue (parámetro, `maxTokens 4096`, `stopReason` por turno, acuse con "escribiendo…", latencia medida).
- **Perfil de inferencia de la app con tags** (`aws.bedrock.InferenceProfile` con `modelSource.copyFrom` = el perfil global, nombre `<app>-<stage>-sonnet-5-5`, tags del proyecto). El Harness, Memory y el validador llaman por el ARN de ese perfil: el costo queda etiquetado con `Project` y el nombre lleva el modelo, así un cambio de modelo crea el perfil nuevo antes de borrar el viejo y el agente nunca queda sin modelo. IAM: `bedrock:InvokeModel*` sobre el perfil de la app, el perfil global y los modelos fundacionales que este usa, y `bedrock:GetInferenceProfile` sobre el perfil de la app; el rol de deploy del bootstrap suma `CreateInferenceProfile`, `DeleteInferenceProfile`, `GetInferenceProfile` y el etiquetado sobre `application-inference-profile/*` con la condición de tag del proyecto.
- **Validación de fotos**: `PHOTO_MODEL_ID` sigue al Harness (Sonnet 5.5, por el mismo perfil). Si la medición local del validador (las 60 fotos de `EV-02` con `validate_install_photo` en proceso, sin el stage desplegado; gasta Bedrock, así que corre con estimación y el OK del CTO) muestra una regresión frente a Opus 5 en exactitud o en falsos positivos, `PHOTO_MODEL_ID` vuelve a `global.anthropic.claude-opus-5` y el motivo se agrega a este ADR. La forma del pedido (opción A de `docs/architecture.md` §9.6: `toolChoice auto`, thinking adaptativo con effort bajo, sin parámetros de muestreo) sirve igual: en Sonnet 5.5 el thinking adaptativo es el valor por defecto, no se puede deshabilitar con `disabled`, el `toolChoice` forzado da 400 siempre y los parámetros de muestreo con valores no por defecto también. La opción B (thinking deshabilitado y `toolChoice` forzado) no aplica a Sonnet 5.5.
- **Tarifa**: USD 2 / 10 por millón de tokens de entrada / salida; caché 0,1 (lectura; 0,2 hasta el 2026-10-06, AWS la bajó a la mitad desde el 2026-10-07) / 2,5 (escritura). Filas `bedrock:global.anthropic.claude-sonnet-5-5:{input,output,cacheRead,cacheWrite}` de `RATECARD` (generador del seed y `services/ratecard`), con fuente y fecha; las de Opus 5 se quedan solo si `PHOTO_MODEL_ID` vuelve a Opus 5.
- **Antes del primer deploy**: el operador verifica el perfil global `ACTIVE`, la cuota de tokens por minuto de Sonnet 5.5 y, si es el primer uso del modelo en la cuenta, la suscripción de AWS Marketplace, que habilita una vez un principal administrador con el OK del CTO (acepta los términos de la oferta; el rol del agente no tiene permisos de Marketplace) (`docs/architecture.md` §17 ítems 5 y 6).
- **Gotcha de deploy**: si la actualización de Memory falla después del cambio de modelo por propagación de IAM, se vuelve a correr el job de CI; nunca un deploy local (`docs/architecture.md` §16).

### 2. Lecturas precargadas

Antes de invocar el Harness, el worker lee en código, en paralelo y con el `sessionToken` del turno, lo que todo turno necesita, a través de los targets en proceso (`turns/preload.ts`):

| Disparador | Lecturas |
|---|---|
| Todo turno con orden activa | `get_work_order` (la orden en curso, con su zona, su caso abierto, sus pasos de diagnóstico y el perfil medido del instalador) y `get_checklist` |
| Mensaje del instalador (`INSTALLER_MESSAGE`) | además `get_work_orders`, que suma `recentWorkOrders`: las últimas diez órdenes del instalador (las abiertas primero y después las cerradas más recientes, con su estado). El instalador ya viene resuelto por su teléfono en la entrada (`InboundWhatsApp`), antes del turno |

- Cada lectura pasa los mismos controles que una llamada por el Gateway (`createToolHandler`, `LAM-SCOPE`, `LAM-KILL`, zod `.strict()`) y deja su fila `Runtime/TURN#<turnId>/RESULT#`, así lo que el modelo lee en el sobre respalda a G2 y a la verificación determinista igual que si hubiera llamado a la tool.
- Van al sobre como elementos `<tool-result tool="…">` con `<`, `>` y `&` escapados en el JSON, **fuera** del bloque no confiable del turno; el system prompt dice que son resultados de tools ya leídos, que son datos y nunca instrucciones, y que no hace falta volver a pedirlos.
- Una lectura que falla queda afuera y el modelo la pide como antes. `recentWorkOrders` es un campo nuevo de `get_work_orders` (`docs/tool-catalog.md`), no una tool nueva.
- No cambia: el Harness, el Gateway, Cedar ni la lista de tools. Las tools que el modelo elige (enviar, validar, escalar, cerrar) siguen siendo una vuelta cada una.

### 3. Todo mensaje de una persona tiene respuesta

- Regla **`ALWAYS_ANSWER`** del system prompt: todo mensaje del instalador recibe en ese turno un `REPLY` por `send_whatsapp`, o un escalamiento (`escalate_case`) cuando no puede seguir. Un saludo, un "ok" o un "gracias" reciben un `REPLY` breve con el estado de su orden (qué falta y lo siguiente). La regla le gana a cualquier conclusión anterior de la conversación, incluidas las notas del propio agente y la memoria: si un turno anterior concluyó no responder, esa conclusión estaba mal. Cada id de mensaje es un mensaje nuevo aunque la hora simulada no haya cambiado (reloj en pausa).
- Una conversación que guardó la conclusión equivocada se reinicia subiendo la `sessionEpoch` de su orden, el mismo mecanismo de un bloqueo de G1.

### 4. G2 con un saludo

- Si el mensaje del instalador no pregunta nada (hasta tres palabras y sin "?"), G2 mide la relevancia de la respuesta contra una **pregunta fija de estado** ("¿Cómo va mi orden y qué me falta?"; en inglés, "How is my work order going and what is missing?") en lugar del saludo. El umbral, el grounding y el resto de G2 no cambian. La pregunta fija vive en `packages/bff/src/agent/grounding.ts` (no es un texto visible).
- Cada rechazo de G2 deja en el log (`outbound.g2_refused`) y en `AuditLog` el motivo, los scores de grounding y relevancia y los umbrales, sin el texto rechazado.

### 5. Un mismo WhatsApp, una sola vez por turno

Si el modelo pide dos veces el mismo envío en un turno (mismo canal y mismo texto, o la misma plantilla con los mismos parámetros), el pipeline de salida contesta el segundo con el mensaje ya enviado, como a un evento reentregado (`replayOf`), y no sale nada más (`outbound/repeat.ts`).

### 6. Observabilidad: solo logs, 30 días, sin tableros

- La observabilidad son los **logs JSON** (`lib/log.ts`, enmascarados) con **30 días** de retención en todo grupo: las Lambdas (`$transform`), el runtime `-live` del Harness (IaC), el runtime **`-DEFAULT`** que AgentCore crea solo y sin retención (si ningún provider pinneado lo modela, configuración manual declarada en `docs/architecture.md` §17 ítem 15, con su comando de verificación) y `aws/spans` (configuración de la cuenta, §17 ítem 2).
- **Sin tableros** (`aws.cloudwatch.Dashboard`) ni alarmas sin acción. Una alarma existe solo si publica en `CostAlerts` y enciende un corte (`CostGuard`: el de costo de ADR-0019 y el del alta de ADR-0025 §4). Un metric filter existe solo si lo lee una de esas alarmas o un paso `SR`/`SMK` que lo asierta. Todo lo demás que `docs/architecture.md` §12 llama indicador es un campo de las líneas de log, que se consulta con CloudWatch Logs Insights; las cifras que muestra el producto (latencias, costo por conversación, medición) salen de sus tablas (`CuadrillaMetrics`, `EvalResult`) y de los reportes del ejecutor, no de CloudWatch.
- Nada con costo fijo que no se use: lo que se crea "por si acaso" (tableros, alarmas que solo avisan, métricas que nadie lee) se quita.

### 7. Landing y diagrama

- **Sección de video** en la landing, antes de la de arquitectura: `<video controls preload="none" playsinline poster=…>` servido desde el propio sitio (`public/landing/video/`), sin autoplay, con el póster y un enlace de respaldo; no descarga nada hasta que la persona pulsa play. La especifica `ui-designer` en `docs/landing-spec.md` y la construye el WP de la landing de la ola 5.
- **Conmutador de idioma** (`LangSwitch`): su clase de display nunca fuerza un ancho que produzca scroll horizontal a 360 px.
- **Diagrama de arquitectura del README y de la submission**: grilla, conectores ortogonales, íconos oficiales de AWS de 56 px, servicios CDS con insignia (SES y, en vivo, End User Messaging Social; SNS nunca como CDS), fuente HTML en `docs/assets/architecture/` y PNG renderizado por un script de Playwright (`scripts/diagram/render-architecture.ts`) al doble de resolución.

### 8. WhatsApp: número y WABA nuevos

- Cuadrilla usa un **número nuevo y una WABA propia**, solo de este producto. El CTO hace el alta de Meta (registro embebido, display name, verificación) **al final del build**; `P-01` sigue abierto hasta entonces.
- Mientras tanto se construye todo de punta a punta (adaptador, transporte vivo, plantillas como código, notas de voz y fotos entrantes, eventos, scripts) y `ChannelModes.whatsapp` queda solo con el transporte `simulated`. `P-01` es un bloqueo externo: nunca es motivo para frenar otro trabajo.

## Considered options

- **Seguir con Opus 5 y achicar `maxTokens` o el effort**: no ataca la causa (las vueltas en serie) y ADR-0020 ya mostró que un `maxTokens` chico corta turnos.
- **Claude Haiku 4.5**: el producto hermano lo probó; contestó rápido pero siguió su propia nota equivocada antes que la regla. Con dos llamadas por turno, la diferencia de velocidad con Sonnet es chica.
- **Una regla de prompt "lee todo en un paso"** (`READ_FIRST`): ahorra una vuelta al modelo, no el tiempo de las lecturas, porque el Harness las ejecuta en serie.
- **Bajar el umbral de relevancia de G2**: afloja el control para todas las respuestas para arreglar los saludos.
- **Tableros y alarmas de aviso**: cuestan todos los meses y nadie los mira en una demo; los cortes que importan ya son automáticos.
- **Las lecciones portadas** (elegida).

## Consequences

- ADR-0020 queda reemplazado en el modelo por defecto (y en la "métrica" `TurnMaxTokens` y la publicación de `FirstReplyLatency`, que pasan a campos de log y a los reportes); el resto sigue. ADR-0026 punto 4 nombra el perfil de esta decisión.
- `docs/build-plan.md`: WP-64 en la ola 3 (modelo, tarifas, `ALWAYS_ANSWER`, consulta de G2 para saludos, retención del grupo `-DEFAULT`, limpieza de lo que tiene costo sin uso); las lecturas precargadas en WP-32, el guard de envío repetido y los scores de G2 en WP-28, solo logs en WP-38, el video y el conmutador en WP-44 y el diagrama en el README de la ola 6.
- Flujos: FL-025 suma la variante (c), el saludo con respuesta y estado (con el paso `SC-02/11` y su oráculo); FL-033, el registro de los rechazos de G2; FL-093, la variante (b), el envío repetido en el mismo turno.
- `docs/architecture.md` §1, §4, §9.1, §9.6, §12, §16 y §17 y `docs/pending.md` (P-01, P-04) quedan alineados.
- Un cambio de modelo exige la medición del manual y de fotos (`EV-01`, `EV-02`) y `SC-18` con el modelo nuevo (ADR-0020); en el stage desplegado corren solo con el OK del CTO por el gasto de Bedrock. Los flujos locales y los tests unitarios corren siempre.
