# Mapa de reuso del scaffolding interno

Dos referencias internas de Craftech, creadas durante el período de la hackathon, de solo lectura; el operador pasa sus rutas locales a cada agente y ningún archivo del repo las nombra (ADR-0001):

- **Referencia A**: repositorio de scaffolding interno, commit `82d20b2`. Aporta el código base: SST, bootstrap, AgentCore, Knowledge Base, SES, Transcribe, Cognito, consola, landing, seed, lint.
- **Referencia B**: diseño y scaffolding de otra POC de la misma hackathon, commit `090e725`. Aporta los patrones más nuevos y su código de CI: bootstrap con `qa-runner` y `job_workflow_ref`, modos de canal, `QaDriver`, reloj de mundo, `lint:forbidden`, `flows:check`, `lint:wp-ownership`, `channels:check-modes`, smoke interino.

Decisiones:

- **Copiar**: el archivo entra igual, salvo el scope de paquete (→ `@cuadrilla/*`), el nombre del app y los comentarios que nombren el producto anterior.
- **Adaptar**: entra con los cambios de la columna; el WP dueño en `docs/build-plan.md`.
- **Descartar**: no entra. Todo lo específico de los productos anteriores (dominio, textos, marca, datos, investigación, canales que este producto no usa, flujos, casos de QA) se descarta y ningún archivo nuevo lo nombra; las filas lo describen de forma genérica cuando el nombre del archivo delataría el producto.

Regla de verificación: después de cada WP que copie o adapte, `npm run lint:forbidden` (lista externa del operador, que incluye los nombres, dominios, scopes de paquete y clientes de las dos referencias) tiene que dar cero coincidencias en árbol, commits, PDFs, textos de fotos, manual, seed y build. En CI falla cerrado.

## Raíz y configuración

| Ruta en la referencia | Ref. | Decisión | Qué cambia / destino | WP |
|---|---|---|---|---|
| `package.json` | A, B | Adaptar | `name` `aws-cds-hackathon-poc-cuadrilla`; scripts `seed:{photos,voices,generate,validate,load}`, `scenarios`, `flows:check`, `network:contract`, `manual:check`, `tools:build-schemas`, `channels:{check-modes,whatsapp-templates,waba-event-destination,waba-check}`, `ops:kill`, `lint:{forbidden,wp-ownership,duplicates}`, `tour:check`, `console:invite`, `smoke:interim`, `test:ui`; dependencias de la nota 4 de `docs/build-plan.md` §1 | WP-01 |
| `package-lock.json`, `sst-env.d.ts` (×3) | A | Descartar | Se regeneran | WP-01 |
| `tsconfig.json`, `tsconfig.infra.json`, `.gitignore`, `.editorconfig`, `.nvmrc` | A | Copiar | Alias `@cuadrilla/*`; `include` suma `tests/` | WP-01 |
| `vitest.config.ts` | B | Adaptar | Suma `tests/flows/**` y los paquetes nuevos | WP-01 |
| `sst.config.ts` | B | Adaptar | App y lista de módulos de `infra/` de este repo; solo stage `poc` | WP-01 |
| `CLAUDE.md`, `CONTEXT.md`, `README.md` | A, B | Descartar | Escritos por `architect` para este repo | hecho / ola 6 |

## `.claude/` y visor de docs

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `.claude/agents/{architect,devops,pm,qa,security,seed-generator,typescript-dev}.md` | B | Adaptar | Dominio (instalaciones FTTH, WhatsApp, evidencia, casos), rutas de `docs/`, reglas de reuso; `qa` con escenarios y evaluación; `seed-generator` con manual, fotos y voces | WP-01 |
| `.claude/agents/market-researcher.md` | A | Descartar | Sin fase de investigación | — |
| `.claude/skills/**`, `.claude/commands/docs.md`, `.claude/launch.json` | B | Copiar | Skills de proceso declaradas en el README con su origen | WP-01 |
| `.claude/settings.json` | B | Adaptar | Lecturas permitidas: se suman `transcribe get-*`, `bedrock-agent get-knowledge-base`, `s3vectors get-*`, `polly describe-voices`; se quitan las de recepción de SES | WP-01 |
| `docs/viewer.html` | B | Adaptar | Lista de `docs/` de este repo | WP-01 |

## `infra/`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `tags.ts`, `late-links.ts` | A | Copiar / adaptar | `Project` | WP-02 |
| `ci.ts`, `ci-spec.ts` (+ test) | B | Adaptar | `CI_REPO`; mismas cercas de CloudFront y CSP | WP-02 |
| `secrets.ts` (+ test) | B | Adaptar | `SessionTokenKey`, `WabaId`, `WhatsAppPhoneNumberId` (id de AWS, zod `phone-number-id-<32 hex>`), `WhatsAppMetaPhoneNumberId` (id de Meta, numérico; nuevo: la referencia usaba un solo secreto para las dos cosas), `SeedOverrides`, `BrandConfig` | WP-02 |
| `channel-modes.ts` | B | Adaptar | `{ email: "live", whatsapp: { transports: ["simulated"] } }`; el modo por mundo vive en `Isps/SETTINGS` (ADR-0002) | WP-02 |
| — (nuevo) | — | — | `cost-caps.ts` (techo global, ADR-0019) | WP-02 |
| `iam-capabilities.ts` (+ test) | B | Adaptar | Capacidades de `docs/architecture.md` §14 (`TRANSCRIBE` en dos statements con el `*` justificado de `StartTranscriptionJob`, como el sid `NoResourceLevelRuntime` de la referencia A; `SEND_WHATSAPP` con `PostWhatsAppMessageMedia` y `GetWhatsAppMessageMedia` sobre `whatsappPhoneArn()`; `agentModelArns()` para `ToolEvidence` y la ejecución de Memory); falla ante acciones de receipt rules, `PutWhatsAppBusinessAccountEventDestinations` y `phone-number-id/*` | WP-02 |
| `dns.ts`, `web.ts`, `web-spec.ts` (+ test) | A | Adaptar | Dominio `cuadrilla`; solo `/api/*`; CSP con `img-src` y `media-src` de `Media` y `Evidence` | WP-04 |
| `storage.ts`, `storage-tables.ts`, `storage-buckets.ts`, `storage-keys.ts` (+ test) | A | Adaptar | Tablas y buckets de `docs/architecture.md` §5-§6; helpers de bucket (nombre ≤ 16, lifecycle, TLS) | WP-06 |
| `storage-kb.ts` | A | Adaptar | Vector bucket `kb-<app>-<stage>-manual`, índice `manual`, fuente `Manual/manual/`, fragmentos por sección, metadatos `sectionId`/`manualVersion`/`category`; conserva el `dependsOn` de la política del rol | WP-21 |
| `guardrail.ts`, `guardrail-policies.ts` (+ test) | A | Adaptar | G1 con tres temas denegados de este producto; G2; G3 nuevo (solo PII); regex de `lib/mask.ts` | WP-08 |
| `policy.ts` | A | Copiar | Permits → forbids | WP-08 |
| `policy-rules.ts` (+ test) | B | Adaptar | Statements `CED-*` de este repo, 5 targets | WP-08 |
| `auth.ts`, `auth-email.ts` (+ test) | A | Adaptar | Grupos `SUPERVISOR`/`OPS`/`JUDGE`, `custom:ispId` informativo, `writeAttributes = ["name"]` (como la referencia A), marca | WP-10 |
| `messaging-email.ts`, `messaging-email-spec.ts` (+ test) | A | Adaptar | **Solo envío**: identidad, DKIM, MAIL FROM, DMARC y configuration set; **se elimina todo lo de recepción** (MX, rule set, reglas, bucket de correo entrante) | WP-20 |
| `messaging-whatsapp.ts` | A | Adaptar | Topic `aws-cds-hackathon-poc-cuadrilla-wa-inbound` con `Deny` de publicadores ajenos, `InboundWhatsApp` sin destino de falla, `sns:Publish` del `QaDriver`; sin feature flag; el ARN del número lo arma `whatsappPhoneArn()` desde el id de AWS **sin** el prefijo `phone-number-id-` (la referencia interpolaba el valor completo), verificado contra `phoneNumbers[].arn` en P-01 | WP-24 |
| Módulo de infra del canal que este producto no usa | A | Descartar | — | — |
| `agent-tool-schemas.ts` | A | Copiar | — | WP-25 |
| `agent-tools.ts`, `agentcore.ts`, `agentcore-spec.ts` (+ test), `agentcore-iam.ts` | A | Adaptar | 5 targets; tres estrategias de Memory de este producto con su rol de ejecución (sid `ExtractionModel`, `agentModelArns()`); `HARNESS_MODEL_ID` y `PHOTO_MODEL_ID`; `maxTokens 4096` como en la referencia; log group `live` antes del endpoint | WP-26 |
| `agent-prompts.ts` | A | Descartar | El prompt vive en `packages/bff/src/agent/system-prompt.ts` | — |
| `scheduler.ts` | A | Adaptar | Grupo `…-poc-schedules`, destino `ScheduleDispatch` | WP-27 |
| `workflows.ts`, `workflows-spec.ts` (+ test) | A | Descartar | Sin Step Functions (ADR-0004); la lección `Timeout` → `TimeoutSeconds` queda documentada en `docs/architecture.md` §16 y el `transform` se copia si algún día se agrega una máquina | — |
| Módulo de cola y worker de la referencia B | B | Adaptar → `workers.ts` | FIFO por instalador (ADR-0017) | WP-27 |
| Módulo de mocks de la referencia B | B | Adaptar → `mocks.ts` | `NetworkMock` y `DispatchMock` con tablas propias y pares de permisos | WP-24 |
| `bff.ts` | A | Adaptar | Sin proxy del Harness; suma `QaDriver`, `PolicyAudit` | WP-38 |
| — (nuevo) | — | — | `cost-guard.ts` (`CostGuard`, topic `CostAlerts`, ADR-0019) | WP-38 |
| `observability.ts`, `observability-spec.ts` (+ test) | A | Adaptar | Métricas `CuadrillaAgent/*` y alarmas de `docs/architecture.md` §12; filtros sobre `fn.nodes.logGroup` | WP-38 |
| `bootstrap/ci-role.yaml`, `ci-role.test.ts`, `README.md` | B (base A) | Adaptar | Defaults: `AppName`, `BucketPrefix` (recalculado por el test), `AppDomain` `cuadrilla.demo.craftech.io`, `GitHubRepo`. Literales a reemplazar: topic de WhatsApp, configuration set, grupo de schedules, vector bucket `kb-aws-cds-hackathon-poc-cuadrilla-*`, prefijos de Transcribe `cuadrilla-poc-*` (con `CreateVocabulary`/`TagResource` en `Resource *` con `aws:RequestTag/Project`, `UntagResource` con `aws:TagKeys` y `ListTagsForResource` también en `Resource *`, sid `NoResourceLevelDeploy`, en el rol y en la boundary; `Get/Update/DeleteVocabulary` por ARN; y `s3:GetObject` de `Seed/transcribe/*`), KB para `StartIngestionJob`, parámetro nuevo `WhatsAppPhoneNumberArn` en lugar de `phone-number-id/*`; se elimina toda `PutWhatsAppBusinessAccountEventDestinations`. **Se eliminan** todos los statements de receipt rules de SES y del bucket de correo entrante, y los de canales descartados. Se conservan `qa-runner`, `job_workflow_ref`, SQS FIFO, bus, Function URLs `AWS_IAM`, presupuesto. Presupuesto de tamaño controlado por el test (< 51.200 bytes, < 6.144 por política); comentarios en el README | WP-03 |

## `.github/workflows/`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `ci.yml` | B | Adaptar | Checks de `docs/architecture.md` §18 (suma `network:contract`, `manual:check`) | WP-03 |
| `deploy.yml` | B | Adaptar | Sin prechequeo de rule set (no se usa recepción); `seed:load` con ingesta de la KB; `SC-00` | WP-03, WP-48 |
| `scenarios.yml` | B | Adaptar | Suites `full` y `eval` | WP-03, WP-48 |

## `packages/shared`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `dates.ts`, `hash.ts`, `errors.ts` (+ tests) | A | Copiar | Códigos de error de `docs/tool-catalog.md` | WP-05 |
| `caller.ts`, `ids.ts`, `flows.ts` (+ tests) | B | Adaptar | Prefijos de `docs/seed-spec.md` §2 | WP-05 |
| Enums y reglas del producto anterior | A, B | Descartar | Enums nuevos | WP-05 |

## `packages/bff/src`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `lib/{clients,crypto,retry,resource,deadline}.ts` (+ tests) | A | Copiar | — | WP-07, WP-12 |
| `lib/log.ts`, `lib/mask.ts` | A, B | Adaptar | Patrones de México (CURP, RFC, CLABE) y seriales | WP-12 |
| `lib/clock.ts`, `lib/secrets.ts` | B | Adaptar | Relojes por mundo; nombres de secretos | WP-12 |
| `services/session.ts`, `services/ratecard.ts` (+ tests) | A | Adaptar | Sesión por instalador y orden | WP-12 |
| `services/business-days.ts` | A | Adaptar → `services/business-hours/` | Horario de silencio por zona IANA | WP-12 |
| `services/transcribe.ts`, `inbound/transcribe-client.ts` | A | Adaptar → `media/` | `es-MX`, vocabulario, `ogg`/`webm`/`mp4`, prefijo `cuadrilla-poc-`, nombre idempotente por mensaje y mundo (no por archivo), salida por mensaje y borrada al leerla | WP-31 |
| `services/pdf.ts` | A | Adaptar → `certificates/pdf.ts` | Suma imágenes JPEG (`DCTDecode`) y tabla del checklist; sigue sin dependencias ni fecha | WP-35 |
| `auth/**`, `auth-triggers/**` | A | Copiar / adaptar | Principal `{sub, userId, ispId, role, isJudge, authTime}` | WP-13 |
| `routers/{trpc,handler,deps,index}.ts` | A | Adaptar | `ispProcedure`, `supervisorProcedure`, `recentLoginProcedure` | WP-13 |
| `agent/harness-client.ts` (+ test) | A | Adaptar | Endpoint `live`, sesión por orden, actor por instalador con época | WP-32 |
| `agent-proxy/**` | A | Descartar | La consola no invoca el Harness | — |
| `channels/{adapter,normalizer,registry}.ts` (+ tests) | A | Adaptar | Sobre de `docs/design-brief.md` §5.2; registro por modo | WP-22 |
| `channels/email/{mime,validate,events,outbound,config,content}.ts` (+ tests) | A | Adaptar | Solo salida, adjuntos, cerco de este repo | WP-22 |
| `channels/email/{inbound,receipt,thread,storage}.ts` y fixtures de recepción | A | Descartar | Sin recepción (ADR-0003) | — |
| `channels/whatsapp/**` (+ fixtures) | A | Adaptar | Transporte simulado, filtro por número, audio e imagen, `PostWhatsAppMessageMedia`, plantillas `es_MX` | WP-23 |
| Adaptador del canal descartado | A | Descartar | — | — |
| `inbound/{envelope,identity,gate,limits,keywords,routing,record,media,metrics}.ts` | A | Adaptar | Pasan a `channels/whatsapp/` y `handlers/` | WP-23, WP-33 |
| `inbound/{turn,harness,harness-stream,process}.ts` | A | Adaptar | Base de `turns/` y `worker/` | WP-32 |
| `inbound/{approval-workflow,direct-reply,postbacks,channel-effects}.ts` | A | Descartar | Sin workflows de aprobación; el agente habla por tools (ADR-0014) | — |
| `outbound/{pipeline,checks,grounding,facts,text,persist,port,deps,types,metrics}.ts` (+ tests) | A | Adaptar | Reglas `CP-*`, `CP-CITATION`, G3 en parámetros | WP-28 |
| `outbound/recipient.ts` | A | Adaptar → `recipient-fence.ts` | Solo simulador de SES y demo registrados; dominio propio denegado | WP-22 |
| `outbound/render/{ses,whatsapp}.ts` (+ tests) | A | Adaptar | Plantillas y adjuntos de este repo | WP-28 |
| `policy/{engine,result,types,context,counters,windows,check,kinds,reasons,params}.ts` (+ tests) | A | Adaptar | Reglas y orden de `docs/design-brief.md` §5.7 | WP-19 |
| `connector/{ports,index,keys,table-client}.ts`, `connector/dynamo/{client,expressions,repo}.ts`, `connector/memory/**` | A | Adaptar | Puertos de este dominio | WP-07 |
| `agent-tools/common/{build-schemas,scope}.ts` y el wrapper (+ tests) | A | Adaptar | Sesión de instalador y orden | WP-25 |
| `agent-tools/**` (targets), `workflows/**`, `domain/**` del producto anterior | A | Descartar | Nuevos | — |
| Módulos de mundos, reloj y quiescencia de la referencia B (`worlds/`, `clock/`, `timers/`, `worker/settle`) | B | Adaptar | Mundos con roster y ONU; `forceCaseTimeout`; temporizadores en `WorkOrders` y `Cases`; `installer.settle` | WP-36, WP-39 |
| `QaDriver` y su guarda de la referencia B | B | Adaptar | Acciones de este repo, `wa.publishForeign`, `tool.invoke`, `eval.*` | WP-45 |
| `copy/{helpers,types,forbidden,buttons}.ts` | A | Adaptar | Textos de este repo | WP-09 |
| `public-web/**` | A | Descartar | Sin superficie pública de carga | — |

## `packages/web`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `src/components/{Table,DataTable,table-parts,SelectField,FilterPills,Drawer,Button,Badge,Callout,EmptyState,ApiErrorNotice,RemoteBlock,PageHeader,Section,StatTile,Chart,chart-geometry,FullScreenMessage,form-classes}.*` (+ tests) | A | Copiar | — | WP-11 |
| `src/components/{ScopeBar,ClockBanner,RuleChip,RuleChips}.tsx`, `layout/AppShell.tsx` | A | Adaptar | Equipo + día; reloj del mundo; reglas `CP-*`; navegación de §6 del brief | WP-11 |
| `src/components/brand/**` | A | Adaptar | `BrandMark` genérico: "Cuadrilla · Powered by Craftech" o co-branding por props (logo o marca de texto, aviso de demo sintética; ADR-0018) | WP-11 |
| `src/components/MoneyText.tsx` | A | Descartar | — | — |
| `src/lib/**` y `lib/auth/**` (+ tests) | A | Copiar / adaptar | `auth-claims` con `ispId` y rol | WP-11 |
| `src/context/SessionContext.tsx` | A | Copiar | — | WP-11 |
| `src/context/<contexto de alcance del producto anterior>` | A | Adaptar → `IspContext.tsx` | — | WP-11 |
| `src/views/login/**` | A | Adaptar | Textos | WP-11 |
| `src/views/landing/{Lightbox,gallery,MediaFigure}.tsx` | A | Copiar | — | WP-44 |
| `src/views/landing/{LandingView,copy,media}.*` | A | Adaptar | Historia de este producto | WP-44 |
| Componente de teléfono del prototipo de la referencia B | B | Adaptar → `views/simulator/` | Identidades, voz, fotos, listas | WP-43 |
| `src/views/**` (resto) | A | Descartar | Vistas nuevas | — |
| `public/brand/logo-craftech-*` | A | Copiar | — | WP-11 |
| `public/legal/*.html` | A | Adaptar | Legales de esta demo | WP-44 |
| `e2e/support/**`, `e2e/playwright.config.ts`, `e2e/tsconfig.json` | A | Copiar / adaptar | Clave efímera, sesiones por rol | WP-11 |
| `index.html`, `vite.config.ts` | A | Adaptar | Título y marca | WP-11 |

## `scripts/` y `tests/`

| Ruta | Ref. | Decisión | Qué cambia | WP |
|---|---|---|---|---|
| `scripts/lint/{max-lines,duplicates,typecheck-infra}.ts` | A | Copiar | `ALLOWED` vacío | WP-01 |
| `scripts/lint/no-intl.ts` (+ test) | B | Copiar | — | WP-01 |
| `scripts/lint/{forbidden-terms,wp-ownership}.ts` (+ tests) | B | Copiar / adaptar | `forbidden-terms` suma los textos fuente de las fotos y el manual | WP-03 |
| `scripts/flows/check.ts` (+ test) | B | Copiar | Mapa de prefijos de rutas de este repo; `scripts/evaluation/` | WP-03 |
| `scripts/channels/{check-modes,cli-args}.ts` (+ tests) | B | Copiar | — | WP-03 |
| `scripts/smoke/interim.ts` (+ test) | B | Adaptar | Recursos de este repo | WP-03 |
| `scripts/channels/ingress-route.ts` y los scripts y assets del canal descartado | A | Descartar | Sin stage `local` ni ese canal | — |
| `scripts/seed/generate/{rng,hashing,writer,time,context}.ts` | A | Adaptar | Semilla `20260926` | WP-17 |
| `scripts/seed/validate/**`, `scripts/seed/lib/{tables,conformance,text}.ts` | A | Adaptar | Invariantes de `docs/seed-spec.md` §14 | WP-17 |
| `scripts/seed/load/**`, `scripts/seed/load.ts` | A | Adaptar | Subida de fotos, voces y manual; ingesta de la KB con huella (la referencia A ya ingería su KB desde el loader) | WP-39 |
| `scripts/seed/**` (resto: generadores, datos, documentos, media del producto anterior) | A | Descartar | — | — |
| `scripts/landing/{capture-console,console-server,console-world,render-visuals}.ts`, `captures.json` | A | Adaptar | Capturas de este producto; `console-server` es la base de `tests/ui-server/` | WP-40, WP-44 |
| `scripts/smoke/lib/{http,report,stage,cli,guards,probes}.ts` (+ tests) | A | Adaptar → `scripts/scenarios/lib/` | Base del ejecutor | WP-45 |
| Ejecutor de escenarios y `steps.test.ts` de la referencia B | B | Adaptar | Escenarios de este repo | WP-45 |
| `tests/cases/**` | A, B | Descartar | Casos nuevos | WP-16 |
