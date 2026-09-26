# CLAUDE.md — Cuadrilla (repositorio `aws-cds-hackathon-poc-cuadrilla`)

Instrucciones estrictas para Claude Code en este repositorio. No es documentación para humanos.

Lo que se publica es **un producto para un cliente futuro**: Cuadrilla, de Craftech. Quien lo abra (un prospecto, un partner, cualquier evaluador) tiene que entender en segundos qué problema resuelve, cómo lo hace y por qué le serviría, y poder probarlo solo desde la landing y el alta propia. Escribe cada superficie visible para esa persona.

**Contexto interno (nunca en una superficie visible).** El repositorio es además la submission de Craftech a la AWS CDS Agentic AI Partner Hackathon (cierre 2026-10-28 13:00 PT; objetivo: ranking general y Best of WhatsApp). Ese contexto vive solo en `docs/`, en este archivo, en `CONTEXT.md`, en `.claude/`, en la sección `## Submission notes` del final del README y en los materiales de la submission (formulario, video, instrucciones privadas de prueba). Las reglas del concurso, verificadas el 2026-09-26, no exigen nombrarlo en el producto publicado (ADR-0023).

**Estándar de superficies públicas**: la skill `poc-landing` del workspace (`../.claude/skills/poc-landing/SKILL.md`) es vinculante para la landing, el alta, el login, los legales y todo texto visible; cárgala antes de diseñar, construir, revisar o probar cualquiera de ellos. La especificación de este repo está en `docs/landing-spec.md` y en ADR-0023 a ADR-0026.

## Qué es

**Cuadrilla**: copiloto de campo en **WhatsApp** para instaladores de fibra (FTTH) de una operadora de internet latinoamericana. El instalador escribe o manda una nota de voz (Amazon Transcribe `es-MX`); el agente (Bedrock AgentCore) lee su orden y el estado de la ONU de un orquestador de red simulado, lo guía con el **manual de procedimientos** de la operadora en una Bedrock Knowledge Base (siempre con la sección citada; lo que no está, no se inventa y se escala), valida cada foto de evidencia en una llamada multimodal aislada con chequeos deterministas, escala por una **escalera** de supervisores (plantillas `UTILITY`, vencimientos, email al jefe de zona por SES), da la **instrucción de seguridad** fija del manual ante un riesgo y emite el **acta de instalación** en PDF (SES al cliente y a operaciones, WhatsApp al instalador). WhatsApp por AWS End User Messaging Social: el simulador de teléfono funciona en todo mundo simulado (invitados, QA, evaluación) y el transporte vivo se habilita en el stage cuando el CTO conecta la WABA (P-01), solo para el mundo vivo y los teléfonos reales ligados por código (ADR-0002). Operadora de la demo: configuración de marca de runtime (ADR-0018). En `poc` va en **co-branding** con el socio de diseño (decidido por el CTO el 2026-09-26, P-05), con el aviso de demo sintética, cargado desde el secreto `BrandConfig` y `Seed/brand/` y nunca escrito en el repo; el modo `neutral` (operadora ficticia por defecto) es el respaldo.

Vocabulario en `CONTEXT.md`; diseño en `docs/design-brief.md`; landing, alta y login en `docs/landing-spec.md`; topología en `docs/architecture.md` y `docs/architecture-integrations.md`; decisiones en `docs/adr/`; flujos en `docs/flows-catalog.md`; tools en `docs/tool-catalog.md`; seed en `docs/seed-spec.md`; pruebas en `docs/test-plan.md`; plan por paquetes en `docs/build-plan.md`; reuso en `docs/reuse-map.md`; pendientes externos en `docs/pending.md`.

---

## REGLAS NO NEGOCIABLES

### Del stack

- **Serverless only.** Nada con servidores administrados.
- **SST v4 para toda la infra** (`sst.aws.*`, `$app`, `$dev`); **nunca `new pulumi.xxx`**. `aws.*` / `awsnative.*` solo donde no hay componente SST (AgentCore, Guardrails, Knowledge Base, S3 Vectors, vocabulario de Transcribe, Scheduler); si hay que linkearlos, `sst.Linkable`.
- **Todo por IaC.** Ningún recurso AWS a mano. Lecturas (`describe-*`, `list-*`, `get-*`) sí. Lo que ningún provider modela va a "configuración manual declarada" (`docs/architecture.md` §17) con su comando de verificación.
- **Un solo stage, `poc`, y `sst deploy` solo desde CI** (push a `main`). **Nunca `sst dev`** ni deploy local. **Nunca `sst remove`** sin confirmación explícita del operador en el momento.
- **Cuenta compartida con otra POC.** Nunca leer, modificar ni suscribirse a recursos de otro app. **Nunca usar recepción de email de SES** (receipt rules, rule sets, MX de recepción): el único rule set activo de la cuenta es de la otra POC (ADR-0003). WhatsApp va por una **WABA propia** con su topic estándar como único destino de eventos (P-01, opción A); igual, todo evento de otro número se descarta antes de leerlo, comparando con el id de Meta del número (`WhatsAppMetaPhoneNumberId`), nunca con el id de AWS (`WhatsAppPhoneNumberId`, que solo sirve para enviar, bajar media e IAM) (ADR-0002).
- **Providers pinneados**: `aws` 7.32.0, `aws-native` 1.74.1. Se cambian solo con ADR.
- **`Resource` de SST, nunca `process.env`** en Lambdas (salvo `STAGE` y `NODE_ENV`); `/// <reference path=".../sst-env.d.ts" />` en cada archivo que use `Resource`; recursos con `readLinked(nombre, zod)` y secretos con `secretValue(nombre)`.
- **Secretos con `sst.Secret`**, declarados una sola vez en `infra/secrets.ts`. Nada en el repo, en `.env`, en `environment` ni en el chat.
- **Removal `remove`** en todos los stages. Única excepción declarada: la tabla `Leads` con protección contra borrado (ADR-0026).
- **Máximo 400 líneas** por archivo TS/TSX. **Feature-based**. **Sin librerías de estado** (Context + useState). **Tailwind v4** con `@theme`, sin hex en JSX.
- **zod en todos los bordes** (tools, eventos SNS/EventBridge, salida estructurada del validador, orquestador, despacho, tRPC).
- **Toda llamada externa con timeout y reintento con backoff.** Logs JSON con correlation id, **sin PII** (`packages/bff/src/lib/log.ts`, patrones de `lib/mask.ts`).
- **Reloj inyectado**: ninguna lógica de negocio llama `Date.now()`; usa el reloj del mundo (ADR-0010), salvo la política de WhatsApp para destinatarios con transporte `live`, que usa el reloj real y `lastInboundAtReal` (ADR-0002). Todo lo que pasa a una hora simulada es un `TIMER#` que el reloj sabe avanzar.
- **Sin dependencias a ciegas**: versión estable, mantenida, compatible con Node 22 y ESM, declarada en la ola 0.
- **Documentación solo en los lugares definidos**: `architect` escribe `CLAUDE.md`, `CONTEXT.md`, `README.md` y `docs/` (salvo `docs/landing-spec.md`, de `ui-designer`); `qa` escribe `tests/cases/`. No se documenta lo que hizo Claude.

### Del producto

- **El agente habla solo por `send_whatsapp`** y solo al instalador de la sesión; el texto final del turno es una nota interna (ADR-0014). Supervisores, jefe de zona y cliente reciben solo plantillas, textos de `copy/` o el resumen verificado; nunca texto libre sin verificar.
- **La validación manual de evidencia y las decisiones de un caso son siempre humanas.** No existe una tool que valide manualmente, tome, rechace o cierre un caso; `update_checklist` exige una validación `PASS` (ADR-0011).
- **Las imágenes nunca llegan al Harness.** Solo las ve `validate_install_photo`, en una llamada aislada cuya única tool es `record_verdict` (sin efectos; sin `temperature` ni `toolChoice` forzado con thinking activo); los chequeos deterministas solo pueden endurecer el veredicto (ADR-0015).
- **La seguridad física es determinista**: clasificador de léxico antes de G1 y del agente, instrucción fija de §SEG-01 (una sola fuente en `copy/es-MX.ts`, escrita literal en el manual), alerta al supervisor y al jefe de zona en paralelo. El modelo nunca redacta la instrucción de seguridad (ADR-0016).
- **Toda política o procedimiento sale del manual y se cita** (`search_procedures` del mismo turno, `CP-CITATION`); lo que no está se dice y se ofrece escalar.
- **Política de contacto en código** (`packages/bff/src/policy/`, reglas `CP-*`), nunca en el prompt (ADR-0012).
- **Identidad fuera del modelo**: personas por teléfono registrado, único **por mundo** (`ADDR#<clockId>#<phoneHash>`), solo de la lista de permitidos y con opt-in ("ALTA"); en mundos de invitado, QA y evaluación solo teléfonos del bloque sintético del mundo; un teléfono real entra solo por `SeedOverrides.personPhones` al mundo vivo o por un código de alta enviado desde ese mismo teléfono (`PHONELEASE#`); ninguna tool confía en un id que escriba el modelo: todo sale del `sessionToken`; zod `.strict()` en cada tool.
- **Todo contenido entrante es hostil**: texto y transcripciones enmascarados (CURP, RFC, CLABE, tarjetas, teléfonos) antes de persistir, escapados dentro de un delimitador aleatorio por turno y pasados por el pre-filtro determinista de G1; ningún saliente lleva enlaces ni contactos ajenos (`CP-NO-FOREIGN-LINKS`).
- **Cerco de destinatarios de email, por mundo**: en mundos de invitado, QA y evaluación solo `*@simulator.amazonses.com`; los destinatarios de demo de `SeedOverrides` solo en el mundo vivo o de demo del operador; nunca nuestro propio dominio (no tiene buzones) ni dominios reservados; dentro del cliente único de SES, por IAM y al escribir una persona.
- **Una cola FIFO por instalador** (`MessageGroupId = installerId`) para todo lo que le habla o cambia su trabajo, incluidos los eventos de supervisores y vencimientos de sus casos (ADR-0017).
- **Transporte vivo de WhatsApp solo con P-01 cerrado y un solo mundo vivo** (`npm run channels:check-modes` lo impide); el simulador sigue disponible en todos los mundos simulados.
- **Costo con techo global y corte en runtime** (ADR-0019): topes por mundo, por operadora y globales del stage (`TURNCAP#GLOBAL`, `VALCAP#GLOBAL`, `TRANSCRIBE#GLOBAL`) reservados antes de gastar; `Runtime/KILL#` lo leen BFF, worker, `InboundWhatsApp` y `createToolHandler`; la seguridad física nunca se corta.

### De las superficies públicas, los invitados y los leads

- **Superficies neutrales** (ADR-0023): ninguna superficie visible (landing, alta, login, recuperación, consola, simulador, legales, emails de producto y de autenticación, PDFs, plantillas de WhatsApp/RCS/SMS, textos del seed que ve o escucha un usuario, renders y capturas, README antes de `## Submission notes`, build `dist`) nombra el concurso ni a sus evaluadores: ni hackathon/hackatón, Devpost, concurso, certamen, premio(s), jurado(s), juez/jueces, judge(s), evaluación/evaluador(es), ni "AWS CDS" como certamen. Lo que el producto mide se llama "medición" (los ids internos `EV-01`/`EV-02` nunca se muestran). `npm run lint:neutral-surfaces` (fuentes visibles, emails renderizados, PDFs y `-- --dist`) corre en `ci.yml` y `deploy.yml` junto a `lint:forbidden`; córrelo antes de cada PR que toque una fuente visible. Una superficie nueva entra en la tabla de ADR-0023 y en el guard en el mismo PR.
- **Rol `GUEST`** (ADR-0024): quien prueba la demo es **invitado / guest** (`GUEST`, `isGuest`, `isp-guest-*`, `GUEST#…`, usuarios `guest-NN`), en código, infra, seed, tests y docs; nunca judge/jurado. Tres orígenes (`INVITED`, `TEST`, `SIGNUP`), un solo comportamiento: el de `SUPERVISOR` dentro de su propio mundo.
- **Alta propia** (ADR-0025): email verificado por código de Cognito, ticket de alta ligado al email y al usuario `gst-*`, un usuario `GUEST` con un **mundo aislado y sembrado** (TTL de 7 días reales; la cuenta y el lead sobreviven y el mundo se recrea al volver), login, recuperación y logout. Los roles internos (`SUPERVISOR`, `OPS`) siguen **solo por invitación**. Anti abuso en capas: el `Bff` solo atiende pedidos que pasaron por CloudFront (encabezado de origen, `403` antes de parsear) y el alta solo como una llamada única `POST /api/signup.start`, sin lotes (`400` a cualquier otra forma que nombre `signup.`; el alcance del WAF del alta coincide por contenido después de decodificar), una cuenta por email y dos por persona, tope de mundos activos, topes por mundo y por cuenta con el reloj real y sub-techo dentro del techo global (ADR-0019), límites de frecuencia (más estrictos para IP anónimas), AWS WAF en el Router y en el user pool sin CAPTCHA, y el corte del alta `KILL#SIGNUP` ante rebotes, quejas o ráfagas (la reputación de SES es de toda la cuenta compartida). Los triggers de confirmación e ingreso solo actúan para invitados de alta propia; el borrado solo alcanza a invitados de alta propia. Los invitados operan solo sobre datos sintéticos; sus emails de producto van al simulador de SES. Emails de autenticación con la marca neutral en todo modo, es y en, desde la identidad SES del app, por su configuration set y sin interpolar datos del visitante.
- **Leads** (ADR-0026): cada alta confirmada es un lead en la tabla propia `Leads`, **fuera de los datos de la demo**, con dos consentimientos separados, sin tildar y versionados (términos y privacidad obligatorio; contacto de Craftech opcional). Aviso por SES a la casilla `@craftech.io` de la configuración `LeadConfig` (nunca escrita en el código; su cerco solo admite `@craftech.io`; el cerco de la demo no cambia). `npm run leads:export` (por defecto solo contactables), `leads:unsubscribe` y `leads:delete` los corre el operador con su profile (el email por entrada estándar, nunca como argumento), nunca CI ni un invitado. Los emails de los leads son PII: nunca en logs, `AuditLog`, métricas, trazas ni exportaciones de la demo. El aviso de privacidad tiene los nueve puntos de ADR-0026 (responsable y domicilio, datos tratados incluido el contenido del invitado, encargados, transferencia internacional, finalidades, retención, derechos con plazos, autoridad de control y canal; Ley 25.326) y `P-06` se cierra antes de cualquier promoción pública.
- **Landing comercial** (`docs/landing-spec.md`): muestra el producto con renders hechos con los componentes y textos reales mientras la consola no existe, cada uno en el manifiesto con la captura real que lo reemplaza; nunca un mockup de una función inexistente; responsive de 360 a 1440+, `prefers-reduced-motion`, accesible y rápida.

### De la marca y del concurso (contexto interno)

- **Marca pública**: en `poc`, "Cuadrilla for <socio> · Powered by Craftech" (co-branding, P-05 cerrado; ADR-0018); "Cuadrilla · Powered by Craftech" en el modo `neutral` de respaldo. Display name de WhatsApp: "Craftech". El nombre y los logos del socio de diseño son **configuración de runtime** (secreto `BrandConfig`, logos en `Seed/brand/` subidos por el operador con `seed:load --brand-logo-*`, nunca en git; el repo, el README y el código dicen "design partner"): **ningún archivo, commit, texto, dato, imagen, audio ni PDF versionado nombra a un cliente de Craftech (tampoco al socio), a una empresa real del mercado, a una marca o modelo real de equipos de red, ni a los productos de las referencias internas.** Con co-branding, el aviso "demo sintética: manual, políticas y datos inventados, no son las políticas reales de <socio>" es obligatorio en landing, consola, manual, acta y emails. **Nada estático nombra a la operadora** (manual, KB, plantillas de WhatsApp, `copy/`, system prompt, seed, textos de fotos): dicen "la operadora"; el nombre visible lo pone `resolveBrand` (`copy/brand.ts`) en runtime. Narrativa del repo: "a field copilot on WhatsApp for fiber (FTTH) installers of a Latin American ISP". La operadora ficticia por defecto del modo `neutral` (**Tulvara Fibra**, solo como constante de `copy/brand.ts`), las personas, clientes, domicilios y equipos son inventados, verificados (`Reference/NAMECHECK`) y rotulados "ficticio"; con co-branding, las personas, clientes, políticas y datos siguen siendo inventados.
- **Cero datos y cero dependencia de clientes**: ningún documento, captura, foto, chat, ticket, pregunta de campo, arquitectura ni proveedor de ningún cliente, ni reescrito. El manual, las 50 preguntas, las 60 fotos y las 12 notas de voz se escriben o generan de cero y cada archivo tiene su origen en una hoja de datos.
- **Términos prohibidos**: `npm run lint:forbidden` corre la lista externa (`FORBIDDEN_TERMS`, secreto de GitHub, la mantiene `security`) sobre árbol, commits, PDFs, textos fuente de las fotos, manual, seed y build de la web; **en CI falla cerrado** (sin la lista, el job falla). Nunca imprime el término encontrado. Nunca escribas en el repo el nombre de un cliente ni de una referencia interna, ni siquiera para "excluirlo".
- **Scaffolding declarado**: lo copiado de las bases internas de Craftech (creadas durante el período del concurso) se declara en la sección `## Submission notes` del README; nunca se nombran los productos de los que salió ni sus rutas (`docs/reuse-map.md`).
- **Qué es real y qué es simulado** se dice en la landing, el README y el video. WhatsApp se presenta como adaptador implementado, con el simulador en todo mundo de invitado y en vivo solo después de P-01. **SNS no es un servicio CDS** y nunca se presenta como tal; el servicio CDS usado en runtime es SES (y EUM Social cuando esté vivo).
- **Credenciales de invitado** (`guest-NN`) solo en las instrucciones privadas de prueba del formulario de Devpost (P-03); nunca en la landing, el README, el repo, un log ni un chat. La descripción pública del formulario y el video pueden nombrar el concurso; la app y el README de producto no.
- **README**: empieza como README de producto (en inglés) y termina con `## Submission notes`, la única sección que nombra el concurso, la oportunidad ACE y el scaffolding declarado.
- **Materiales de submission en inglés.** La propiedad intelectual es de Craftech. Sin créditos de AWS mencionados.

---

## IDIOMAS

| Qué | Idioma |
|---|---|
| Código, identificadores, comentarios, commits, README, materiales e instrucciones de prueba de la submission | Inglés |
| `CLAUDE.md`, `CONTEXT.md`, `docs/`, ADRs, `tests/cases/`, agentes de `.claude/`, conversación con el operador | Español neutro |
| Textos al personal, plantillas (`es_MX`), acta, emails, consola, manual, set de evaluación | Español de México (tuteo), en `packages/bff/src/copy/es-MX.ts`; glosa en inglés en `copy/en-gloss.ts` |
| Landing, alta, login, legales y recorrido guiado | es-MX (tuteo) y en, con conmutador |

---

## STACK

| Capa | Elección |
|---|---|
| Monorepo | npm workspaces: `packages/{shared,bff,web,network-contract,network-mock,dispatch-mock}`, `infra/`, `scripts/`, `tests/` |
| Agente | Bedrock AgentCore Harness (`global.anthropic.claude-opus-5`, endpoint `live`), Gateway MCP `AWS_IAM` con 5 targets Lambda y 12 tools, Memory (consejos por instalador), Policy Cedar, Guardrails G1/G2/G3 |
| Conocimiento | Bedrock Knowledge Base sobre S3 Vectors (vector bucket `kb-…`), Titan Text Embeddings v2 |
| Voz y visión | Amazon Transcribe `es-MX` con vocabulario FTTH; Bedrock `Converse` multimodal aislado para validar fotos |
| Orquestación | SQS FIFO `InstallerEvents.fifo` por instalador; temporizadores `TIMER#` con EventBridge Scheduler; relojes de mundo en pausa; bus `Feeds` |
| Canales | End User Messaging Social con transportes del stage (`ChannelModes.whatsapp.transports`) y modo por mundo (`Isps/SETTINGS.whatsappMode`); SES v2 solo salida (DMARC `p=reject`, adjuntos, eventos) |
| Datos | DynamoDB (una tabla por agregado), S3 |
| Consola y superficies públicas | React 19 + Vite + Tailwind v4, tRPC v11; Cognito con alta propia por email verificado, login SRP, recuperación y tokens de 15 min; AWS WAF en el Router y en el user pool; tabla `Leads` con aviso por SES |
| Cuenta | `craftech-demos` 776805327629, `us-east-1`; profile `craftech-demos` en local; OIDC en CI |
| Stages | Solo `poc` (CI). Dominio `cuadrilla.demo.craftech.io` (zona `Z043097217S4W7QWXU5O0`) |
| Tests | vitest (`U`, `LF`), Playwright (`UI`), ejecutor de escenarios en `poc` (`SR`), evaluación del agente (`EV-01`, `EV-02`) |

## CONVENCIONES

- Nombres lógicos SST en PascalCase e inglés; tags `Project=aws-cds-hackathon-poc-cuadrilla`, `Stage`, `ManagedBy=sst`, `Owner=craftech`.
- Ramas cortas contra `main`; `main` deploya `poc`. Commits en inglés, imperativo.
- `GatewayTarget` en cadena de `dependsOn` con `ignoreChanges`; políticas Cedar: permits antes que forbids, `has` en todo campo.
- CLI con el profile primero: `aws --profile craftech-demos <servicio> describe-...`.
- Un flujo nuevo o cambiado actualiza `docs/flows-catalog.md` y la matriz de `docs/test-plan.md` en el mismo PR (`npm run flows:check -- --write`).
- Un cambio del manual es una versión nueva (`v002`) con re-ingesta; un cambio de la rúbrica es una versión nueva; el set de evaluación no se cambia para pasar un umbral.

## REUTILIZACIÓN

"Reusar antes que crear", en concreto. Lo revisan `security` o `qa` en cada PR.

**Consola (`packages/web`)**
- Antes de escribir UI se revisa `packages/web/src/components/`. Si un patrón aparece en una segunda vista, se extrae a `components/` en ese PR; nunca se copia a una tercera.
- En `views/` no se arma a mano lo que ya tiene componente:

  | Patrón | Componente |
  |---|---|
  | Tabla | `Table`; con selección o fila que abre detalle, `DataTable` |
  | Select con label | `SelectField` |
  | Filtro tipo píldora | `FilterPills` |
  | Equipo de campo y día | `ScopeBar` |
  | Panel lateral | `Drawer` |
  | Botón | `Button` |
  | Estado vacío, error de API, dato remoto | `EmptyState`, `ApiErrorNotice`, `RemoteBlock` |
  | Título, sección, métrica, etiqueta, aviso | `PageHeader`, `Section`, `StatTile`, `Badge`, `Callout` |
  | Hora simulada, reglas de una decisión | `ClockBanner`, `RuleChip(s)` |

- Un componente compartido es genérico (textos por props, variantes por prop). Objetivo 250 líneas; máximo 400.

**Backend (`packages/bff`)**
- Un cliente por servicio externo (Harness, Bedrock Converse, Knowledge Base, Transcribe, SES, EUM Social, orquestador, despacho, Scheduler) con timeouts, reintentos y mapeo de errores en un solo módulo.
- Toda tool pasa por `createToolHandler`; todo procedimiento tRPC por `ispProcedure` (y `supervisorProcedure` / `recentLoginProcedure` donde corresponde). Todo envío sale por el pipeline de `outbound/`.

**Textos y seed**
- Un texto tiene una sola fuente en `copy/`; el seed, el manual (§SEG-01), la rúbrica y los tests importan de ahí.

**Higiene**
- Sin código muerto. Antes del PR: `npm run lint` y `npm run lint:duplicates`.

## PRIORIDADES DE CALIDAD

1. Un prospecto (o cualquier evaluador) entiende el producto con la landing y el README y lo prueba solo con el alta, sin nosotros
2. Ninguna persona recibe una instrucción de seguridad equivocada ni un mensaje fuera de política
3. Todo flujo probado según `docs/test-plan.md`
4. Consistencia antes que novedad; reusar antes que crear
5. Archivos chicos, una responsabilidad
6. Todo cambio de infra reproducible desde cero

---

## AGENTES

| Agente | Responsabilidad |
|---|---|
| `pm` | Planifica, delega por WP y reporta estado |
| `architect` | Documentación: `CONTEXT.md`, ADRs, arquitectura, catálogos, seed-spec, plan, pendientes, README (de producto + `## Submission notes`) |
| `devops` | SST, bootstrap, CI/OIDC, IAM, AgentCore, Knowledge Base y canales como recursos, secretos, costo |
| `typescript-dev` | Tools, turnos, canales, pipeline, política, escalera, validador, acta, mocks, BFF, consola, loader |
| `seed-generator` | Seed sintético, manual, set de evaluación, fotos, voces y verdad de base |
| `qa` | Casos, `QaDriver`, ejecutor de escenarios, evaluación, flujos locales, verificación "100 % probada" |
| `security` | IAM, secretos, PII, identidad, contenido hostil, cercos, cuenta compartida, marca, superficies neutrales, alta, leads y consentimientos |
| `ui-designer` | `docs/landing-spec.md` (landing, alta, login y su copy) y la revisión de diseño de las capturas con la mirada comercial de un cliente potencial |

**Regla de flujo.** Cada agente aplica la skill `poc-landing` en lo que toca de su rol (`.claude/agents/*.md`). `architect` documenta antes de implementar; `security` revisa la rama antes de mergear lo que toque IAM, secretos, canales, datos o superficies públicas; `qa` verifica antes de dar algo por hecho; `ui-designer` lee las capturas de toda ola que toque superficies públicas. Se revisa la rama, no el PR. La sesión del operador orquesta: no implementa, no opera, no deploya.

## FORMATO DE SALIDA

Directo, resultado primero, tablas antes que párrafos, sin repetir el pedido ni narrar el proceso. Diagramas ASCII en el chat; Mermaid solo en `docs/`.

## CÓMO LEER LOS DOCS

`python3 -m http.server 8099 --bind 127.0.0.1` y `http://localhost:8099/docs/viewer.html` (o la configuración `docs` de `.claude/launch.json`). El `--bind` importa: sin él la carpeta queda visible en la red local.
