# Mapa del renombre `JUDGE` → `GUEST`

Mapa exacto que aplican WP-51 (infra, CI, scripts de canales), WP-52 (`packages/**`), WP-53 (`scripts/seed/**`) y WP-54 (`tests/cases/**`) en la ola 2b.1 (`docs/build-plan.md`; decisión en ADR-0023). Salió de recorrer el árbol de las olas 0-1 y los archivos de la ola 2 en construcción el 2026-09-26; la columna "Dónde" es la foto de ese día y no reemplaza al grep final: después de aplicar el mapa, `grep -rIiE "judg|jurad" infra packages scripts tests .github package.json sst.config.ts` devuelve cero líneas y `npm run lint:neutral-surfaces` pasa sobre todo el árbol (este grep no ve las demás palabras de ADR-0022, como el nombre del app de la fila 50).

Reglas de aplicación:

1. Se aplica en este orden (de lo más específico a lo más general), sensible a mayúsculas, sobre código, tests, fixtures, JSON del seed, workflows y comentarios.
2. Los textos visibles no se renombran palabra por palabra: se reescriben con el vocabulario de producto (sección D).
3. Ningún comportamiento cambia: ni permisos, ni topes, ni rutas, ni escenas. Los tests existentes pasan con los nombres nuevos y ninguna aserción cambia de valor salvo el string renombrado.

## A. Identificadores y literales

| # | Antes | Después | Tipo | Dónde (olas 0-1 · ola 2 en curso) |
|---|---|---|---|---|
| 1 | `isJudge` (claim, campo del principal, props) | `isGuest` | Claim del token y campo | `infra/auth.ts`; `packages/bff/src/auth/{principal,jwt,qa-principal,testing}.ts`, `auth/*.test.ts`, `auth-triggers/pre-token{,.test}.ts`, `routers/{isolation,handler}.test.ts`; `packages/web/src/lib/auth-claims{,.test}.ts`, `lib/auth/deps.ts`, `lib/auth/testing/fake-cognito.ts` |
| 2 | `JUDGE_TEST_CLOCK_ID` | `GUEST_TEST_CLOCK_ID` | Constante | `packages/shared/src/{clock-ids,index,caller}.ts`, `ids.test.ts`; `packages/bff/src/connector/world.ts` |
| 3 | `JUDGE_TEST_ISP_ID` | `GUEST_TEST_ISP_ID` | Constante | `packages/shared/src/{clock-ids,index}.ts` |
| 4 | `judgeClockId` | `guestClockId` | Función | `packages/shared/src/{clock-ids,index}.ts` |
| 5 | `JUDGE_ISP` (regex) | `GUEST_ISP`, que además acepta `s\d{6}[a-z2-7]{5}` (origen `SIGNUP`, ADR-0024; la ampliación la hace WP-58, el renombre WP-52) | Constante | `packages/shared/src/clock-ids.ts` |
| 6 | `"JUDGE"` en `ConsoleRole`, `IspKind` y el grupo de Cognito | `"GUEST"` | Enum y grupo | `packages/shared/src/enums.ts`; `infra/auth-email.ts` (`CONSOLE_GROUPS`), `infra/auth.ts`, `infra/auth{,-email}.test.ts`; `packages/bff/src/routers/{trpc,index}.ts`, `auth/principal.ts`; `packages/web/src/copy/console.ts`, `e2e/support/accounts.ts`, `e2e/login.spec.ts`, `lib/routes.test.ts`, `lib/auth/flow.test.ts`; ola 2: `packages/bff/src/outbound/recipient-fence.ts`, `channels/whatsapp/lease.ts` |
| 7 | Recurso `UserPoolGroupJudge` | `UserPoolGroupGuest` | Nombre lógico SST (derivado del grupo) | `infra/auth.ts` |
| 8 | Descripción del grupo "Hackathon judge: supervisor permissions inside the judge's own demo world, no TOTP" | "Guest: supervisor permissions inside the guest's own demo world" | Texto de infra | `infra/auth-email.ts` |
| 9 | `JUDGE#` (prefijo de reloj) y `JUDGE#isp-judge-<nn\|test>` | `GUEST#` y `GUEST#isp-guest-<nn\|test>` | Id de reloj | `packages/shared/src/{clock-ids,caller}.ts`, `media/keys{,.test}.ts`; `packages/bff/src/auth/fence.ts`, `network/faults.ts`, `connector/**` tests, `ops/*.test.ts`, `lib/*.test.ts`; `packages/network-mock/src/{faults,network.test}.ts`; ola 2: `agent/system-prompt.test.ts`, `channels/**` tests, `outbound/recipient-fence.test.ts`, `policy/**` tests |
| 10 | `isp-judge-` (prefijo de operadora) | `isp-guest-` | Id de operadora | `packages/shared/src/clock-ids.ts`; `packages/bff/src/domain/isps.ts` y los tests listados en #9; `packages/dispatch-mock/src/*.test.ts`; `infra/iam-capabilities{,.test}.ts`, `infra/guardrail-policies.test.ts`; `packages/web/e2e/support/accounts.ts`; `scripts/channels/cli-args.test.ts`; ola 2: `infra/workers-spec.test.ts`, `channels/email/tags{,.test}.ts`, `channels/**` tests, `policy/records.test.ts` |
| 11 | `ONU#JUDGE#isp-judge-*`, `DWO#isp-judge-*`, `ONU#JUDGE#isp-judge-test#*`, `DWO#isp-judge-test#*` | `ONU#GUEST#isp-guest-*`, `DWO#isp-guest-*`, `ONU#GUEST#isp-guest-test#*`, `DWO#isp-guest-test#*` | `dynamodb:LeadingKeys` | `infra/iam-capabilities.ts` (`Bff`, `WorldJanitor`, `QaDriver`) |
| 12 | `usr-qa-judge` | `usr-qa-guest` | Principal del `QaDriver` | `packages/bff/src/auth/qa-principal.ts`, `shared/src/caller.test.ts`, tests de conector; ola 2: `agent-tools/common/handler.test.ts`, `channels/whatsapp/*.test.ts`, `channels/whatsapp/testing.ts`, `policy/as-of.test.ts` |
| 13 | `usr-judge-<nn>`, `usr-judge-test` | `usr-guest-<nn>`, `usr-guest-test` | Id de usuario de consola | Tests de `packages/bff` y `packages/shared` |
| 14 | `judge-<nn>`, `judge-test`, `judge-01..NN` (usuario de Cognito) | `guest-<nn>`, `guest-test`, `guest-01..NN` | Nombre de usuario | `infra/auth.ts` (comentario), `packages/web/e2e/support/accounts.ts`, `login.spec.ts` |
| 15 | `WorldTag` `"judge"` | `"guest"` | Etiqueta de mundo en items | `packages/bff/src/domain/common.ts`, `connector/world.ts` |
| 16 | Etiqueta de reloj `j<nn>`/`jtest` (`clockTagOf`) y ids `wo-24817-j03`, `wo-24817-jtest`, `cust-…-j03` | `g<nn>`/`gtest` (y `gs<…>` para `SIGNUP`), `wo-24817-g03`, `wo-24817-gtest` | Sufijo de ids clonados | `packages/shared/src/{clock-ids,ids}.ts`, `ids.test.ts`; ola 2: `channels/email/{tags,address}.test.ts` |
| 17 | `success+j<nn>-c…@simulator.amazonses.com` | `success+g<nn>-c…@simulator.amazonses.com` | Email sintético | Seed y tests |
| 18 | Prefijo de código de alta `J<nn>` / `JTST` (`joinCodePrefix`) y `"ALTA J07-4F2K"` | `G<nn>` / `GTST` (y `GS` para `SIGNUP`), `"ALTA G07-4F2K"` | Texto de palabra clave | `packages/bff/src/copy/keywords{,.test}.ts`, `domain/runtime-world.ts`, `lib/mask.test.ts`; ola 2: `channels/whatsapp/lease.ts` |
| 19 | Letra de mundo `j` en el nombre del schedule `tm-<w>-<timerId>` | `g` | Nombre de schedule | WP-36 (ola 3) lo escribe ya con `g` |
| 20 | Plantilla de mundo `judge` (`Seed/worlds/judge.json`, `scripts/seed/data/worlds/judge.json`, `{template: "judge"}`) | `guest` (`guest.json`, `{template: "guest"}`) | Archivo y parámetro | Ola 2 (WP-17): `scripts/seed/generate/**`, `scripts/seed/data/worlds/`, `scripts/seed/validate/**` |
| 21 | `JUDGE_SETTINGS`, `JUDGE_BLOCK`, `JUDGE_TEST`, `JUDGE_ROW`, `SUB_JUDGE`, `judge07`, `tokens.judge07`, `SUB.judge07`, `sub-judge07-0001` | `GUEST_SETTINGS`, `GUEST_BLOCK`, `GUEST_TEST`, `GUEST_ROW`, `SUB_GUEST`, `guest07`, `tokens.guest07`, `SUB.guest07`, `sub-guest07-0001` | Fixtures de tests | Tests de `packages/bff`, `packages/web`; ola 2: `channels/rate-limit.test.ts`, `channels/registry.test.ts`, `outbound/recipient-fence.test.ts` |
| 22 | `IDLE_JUDGE_RESET` | `IDLE_GUEST_RESET` | Evento del cron de `WorldJanitor` | Ola 2: `infra/scheduler.ts`, `infra/workers-spec.test.ts` |
| 23 | `scripts/judge/rehearsal.ts` | `scripts/guest/rehearsal.ts` | Archivo (futuro, WP-50) | `docs/build-plan.md` |
| 24 | `scripts/scenarios/sc-19-judge-world.ts` | `scripts/scenarios/sc-19-guest-world.ts` | Archivo (futuro, WP-45) | `docs/build-plan.md` |
| 25 | `console:invite --judge <nn>` | `console:invite --guest <nn>` | Flag de script (futuro, WP-39) | `docs/pending.md` P-03 |
| 26 | `simulator.kit` "kit del jurado" | "kit del invitado" (`simulator.kit`, sin cambio de nombre) | Texto | WP-43 (ola 5) |
| 27 | Paso de CI "Judge tour matches the README (tour:check)" | "Guided tour matches the README (tour:check)" | Nombre de paso | `.github/workflows/ci.yml` |
| 28 | `packages/bff/src/copy/en-gloss.ts`, `copy/types.ts`, comentarios "a judge who does not read Spanish", "judges (ADR-0013)", "judge's world" | "a guest who does not read Spanish", "readers of the glossary", "guest's world" | Comentario | `packages/bff/src/copy/{en-gloss,types,keywords}.ts`, `domain/{isps,runtime-world}.ts`, `dispatch-mock/src/items.ts`, `network/faults.ts`, `web/src/components/layout/TourDock.tsx`, `web/src/lib/auth/flow.ts`, `web/src/views/login/SecurityPrompts.tsx`, `web/src/views/landing/LandingView.tsx`; ola 2: `channels/**`, `policy/**`, `infra/{mocks,scheduler}.ts` |
| 29 | Verbo "judge"/"judged" en comentarios sin relación con el rol ("automated reasoning judges the engine", "how it is judged", "masked, not judged") | "checks", "is checked", "is masked, not censored" | Comentario | `infra/policy-rules.ts`, `packages/bff/src/domain/reference.ts`; ola 2: `policy/rules-content.ts`, `policy/content.test.ts` |
| 30 | `description` de `package.json` "(… Hackathon submission by Craftech)" | "Cuadrilla: a field copilot on WhatsApp for fiber (FTTH) installers of a Latin American ISP, by Craftech" | Metadato | `package.json` |
| 31 | Constante de prueba `JUDGE` (`"JUDGE#isp-judge-07"`) y su uso (`routeFor(JUDGE, …)`) | `GUEST` (`"GUEST#isp-guest-07"`) | Fixture | `packages/network-mock/src/network.test.ts`, `packages/bff/src/network/client.test.ts`, `connector/memory/runtime.test.ts`, `ops/cost-caps.test.ts`; ola 2: `channels/whatsapp/testing.ts`, `channels/whatsapp/simulated.test.ts`, `channels/email/outbound.test.ts`, `outbound/recipient-fence.test.ts` |
| 32 | `judgePhone`, `JUDGE_PHONE` | `guestPhone`, `GUEST_PHONE` | Variable de test | Ola 2: `channels/whatsapp/{inbound,keywords,simulated,lease}.test.ts` |
| 33 | Variable local `judge` (`const judge = …`, `judge.status`, `judge.orders.get`, `judge.clock.reset`, `judge.response…`) y parámetro `judge` de `guestClockId` | `guest` | Variable de test y parámetro | `packages/web/e2e/login.spec.ts`, `packages/bff/src/routers/{handler,isolation}.test.ts`, `auth/principal.test.ts`, `auth-triggers/pre-token.test.ts`, `lib/clock.test.ts`, `packages/shared/src/clock-ids.ts`; ola 2: `channels/registry.test.ts` |
| 34 | Fixtures de personas y mundos con la etiqueta `J`: `rogelioJ07`, `ROGELIO_J07`, `hectorJ07`, `unknownJ07`, `J07`, `J03`, `CASE_J03`, `PEOPLE.rogelioJ07` | `rogelioG07`, `ROGELIO_G07`, `hectorG07`, `unknownG07`, `G07`, `G03`, `CASE_G03`, `PEOPLE.rogelioG07` | Fixture | Tests de `packages/bff` y `packages/shared`; ola 2: `channels/whatsapp/testing.ts` y tests de `channels/**`, `policy/**` |
| 35 | Ids clonados con la etiqueta `j`: `inst-rogelio-j03`, `sup-hector-j07`, `cust-10421-j03`, `wo-24818-j03`, `wo-24819-j07`, `wo-24899-j07`, `complaint+j07-c…`, `success+j07-zc-…`, `Success+J07-C10421` (caso de mayúsculas del cerco) | `inst-rogelio-g03`, `sup-hector-g07`, `cust-10421-g03`, `wo-24818-g03`, `wo-24819-g07`, `wo-24899-g07`, `complaint+g07-c…`, `success+g07-zc-…`, `Success+G07-C10421` | Id y email sintético | Tests de `packages/bff`; ola 2: `outbound/recipient-fence.test.ts`, `channels/email/**` tests, `policy/**` tests |
| 36 | Códigos de alta de los tests `J07-4F2K`, `J074F2K`, `J07-9ZZZ`, `J07-9ZZY`, `J07-9XYZ`, `J07-7QRT`, `J07-2ABC`, `J03-7QPM` | `G07-4F2K`, `G074F2K`, `G07-9ZZZ`, `G07-9ZZY`, `G07-9XYZ`, `G07-7QRT`, `G07-2ABC`, `G03-7QPM` | Texto de palabra clave de test | `copy/keywords.test.ts`, `lib/mask.test.ts`; ola 2: `channels/whatsapp/{lease,keywords}.test.ts` |
| 37 | Claves derivadas del reloj y de la operadora en tests: `SIMCAP#JUDGE#isp-judge-07#…`, `TURNCAP#isp-judge-07#…`, `JUMP#JUDGE#isp-judge-07#…`, `KILL#AGENT#JUDGE#isp-judge-07`, `ISP#isp-judge-07#OPEN`, `ONU#JUDGE#isp-judge-test#…`, `DWO#isp-judge-03#24817` | Las mismas con `GUEST#isp-guest-…` e `isp-guest-…` | Clave de item | `packages/bff/src/ops/*.test.ts`, `connector/**` tests, `lib/*.test.ts`, `packages/dispatch-mock/src/*.test.ts`, `packages/network-mock/src/network.test.ts` |
| 38 | Valores de rechazo de los tests de ids (`"GLOBAL#isp-judge-07"`, `"JUDGE#isp-demo"`, `"JUDGE#isp-judge-abc"`, `"JUDGE#someone-else"`, `"JUDGE#otro"`, `isp-judge-99`, `usr-judge-99`) | `"GLOBAL#isp-guest-07"`, `"GUEST#isp-demo"`, `"GUEST#isp-guest-abc"`, `"GUEST#someone-else"`, `"GUEST#otro"`, `isp-guest-99`, `usr-guest-99` (siguen siendo inválidos: el test prueba lo mismo) | Fixture negativo | `packages/shared/src/ids.test.ts`, `packages/bff/src/auth/*.test.ts` |
| 39 | Valor normalizado de `EmailTags` `JUDGE-isp-judge-07` | `GUEST-isp-guest-07` | Resultado esperado de test | Ola 2: `channels/email/tags.test.ts` |
| 40 | Nombre de archivo de fixture `judge.json` en `checkWorldTemplates` y su mensaje | `guest.json` | Fixture | `scripts/channels/check-modes.test.ts` |
| 41 | Títulos de tests y comentarios con "judge"/"judges"/"judge world" ("marks judges from the stamped role or the isJudge claim", "a judge acts only in a judge world, and a judge world has only judges", "two judges and one QA scenario") | "guest"/"guests"/"guest world" ("marks guests from the stamped role or the isGuest claim", "a guest acts only in a guest world, and a guest world has only guests") | Título de test y comentario | `packages/web/src/lib/auth-claims.test.ts`, `packages/shared/src/caller{,.test}.ts`, `packages/bff/src/auth/principal{,.test}.ts`, `routers/isolation.test.ts`, `infra/auth{,-email}.ts` |
| 42 | `judgeBlock()` y la clave de bloque `judgeWorlds` (`{ label: "+52 55 02nn 0xxx", … }`) | `guestBlock()` y `guestWorlds` | Función y clave de datos | Ola 2 (WP-53): `scripts/seed/lib/synthetic.ts`, `scripts/seed/generate/{templates,world}.ts`, `scripts/seed/validate/identity.ts` (`judge: ["judgeWorlds"]` → `guest: ["guestWorlds"]`) |
| 43 | `TEMPLATE_JUDGE`, `JUDGE_STAFF`, `JUDGE_ORDERS`, `judgeWorld()` | `TEMPLATE_GUEST`, `GUEST_STAFF`, `GUEST_ORDERS`, `guestWorld()` | Constantes y función | Ola 2 (WP-53): `scripts/seed/generate/{world,templates,build}.ts` |
| 44 | `WorldSpec.name` y `bundle.name` `"demo" \| "judge"`, `WorldKind` `"DEMO" \| "JUDGE"`, `template: z.enum(["demo", "judge"])`, `TEMPLATE_NAMES` con `"judge"` | `"demo" \| "guest"`, `"DEMO" \| "GUEST"`, `z.enum(["demo", "guest"])`, `"guest"` | Tipos y enums del seed | Ola 2 (WP-53): `scripts/seed/generate/world.ts`, `scripts/seed/validate/bundle.ts`, `scripts/seed/lib/worlds.ts` |
| 45 | Nombre visible del usuario de consola sembrado `name: "Jurado"` (`consoleUsers`) | `"Invitado"` | Texto visible del seed | Ola 2 (WP-53): `scripts/seed/generate/world.ts` |
| 46 | Nombres de tests "Jurado 07", "Jurado 03", "Jurado fuera de lugar" | "Invitado 07", "Invitado 03", "Invitado fuera de lugar" | Fixture de test | WP-52: `packages/bff/src/auth-triggers/pre-token.test.ts`, `routers/isolation.test.ts`, `connector/memory/catalogs.test.ts` |
| 47 | Comentarios con "judge"/"jurado" en fuentes de canales y política | Vocabulario de invitado ("guest", "guest world") | Comentario | WP-52: `packages/bff/src/policy/{windows,rules-time,types,rules-content}.ts`, `channels/whatsapp/{events,gate,identity,keywords,lease}.ts` (ola 2) |
| 48 | Comentarios con "judge" en scripts de canales | Vocabulario de invitado | Comentario | WP-51: `scripts/channels/check-modes.ts` |
| 49 | Comentarios con "judge" en el generador del catálogo del seed | Vocabulario de invitado | Comentario | WP-53: `scripts/seed/generate/catalog.ts` |
| 50 | Campo `app` del manifiesto del seed con el nombre del app SST (`"app": "aws-cds-hackathon-poc-cuadrilla"`), la constante `APP` que lo escribe y el `z.literal` que lo exige | Campo `product: "cuadrilla"` (constante `PRODUCT` en `generate/context.ts`, `product: z.literal("cuadrilla")` en el zod); se regenera `manifest.json` con `seed:generate` y `seed:validate` en verde. El nombre del app contiene una palabra de ADR-0022 y `scripts/seed/data/**` es fuente visible: el guard lo reportaría. WP-53 verifica antes que nada fuera del generador y del zod lee el campo (`grep -rnE "\.app\b\|APP\b" scripts/seed`); si nada lo lee, puede borrarse en lugar de renombrarse | Campo y constante del seed | Ola 2 (WP-53): `scripts/seed/generate/context.ts` (`APP`), `scripts/seed/generate/manifest.ts`, `scripts/seed/lib/manifest.ts` (zod), `scripts/seed/data/manifest.json` |

## B. Bloques de datos sintéticos

| Antes | Después |
|---|---|
| Teléfonos de mundos de jurado `+52 55 02nn 0xxx` | Mundos `INVITED`/`TEST`: el mismo bloque `+52 55 02nn 0xxx` (`nn` del mundo; `test` usa `99`). Mundos `SIGNUP`: el bloque compartido `+52 55 0300 0xxx` (la identidad es única por mundo, `ADDR#<clockId>#…`) |
| Emails de clientes `success+j<nn>-c<5>@…` | `success+<etiqueta de reloj>-c<5>@simulator.amazonses.com` (`g07`, `gtest`, `gs<…>`) |

## C. Escenarios, flujos y documentos

| Antes | Después |
|---|---|
| `SC-18` "recorrido del jurado" | `SC-18` "recorrido del invitado" (mismos pasos y partes) |
| `SC-19` "mundo y sesiones del jurado" | `SC-19` "mundo y sesiones del invitado" |
| FL-083 "Topes del simulador para jurados" | FL-083 "Topes del simulador para invitados" |
| FL-101 "Alta por código de un teléfono real en un mundo de jurado" | FL-101 "Alta por código de un teléfono real en un mundo de invitado" |
| "Ensayo del jurado" | "Ensayo del invitado" (`scripts/guest/rehearsal.ts`) |
| "Recorrido del jurado" | "Recorrido guiado" (término de `CONTEXT.md`) |

## D. Textos visibles que se reescriben (no se renombran)

| Fuente | Antes | Después |
|---|---|---|
| `packages/web/src/copy/console.ts` `roles` | `JUDGE: "Jurado"` | `GUEST: "Invitado"` (en: "Guest") |
| `packages/web/src/views/landing/copy.ts` | "Jurado: iniciar sesión" / "Judges: sign in"; "cada mundo de jurado" / "every judge world" | La reescribe WP-55 según `docs/landing-spec.md`; en la ola 2b.1, WP-52 deja "Ingresar" / "Sign in" y "cada mundo de prueba" / "every test world" para que el guard pase |
| `packages/web/public/legal/terms.html` | "Las cuentas de jurado sirven solo para evaluar la demo" | WP-52 deja "Las cuentas de invitado sirven solo para probar la demo" (ola 2b.1); WP-59 reescribe los legales completos (ola 2b.2) |
| Pestañas de métricas (WP-42, ola 5) | "Evaluación del manual", "Evaluación de fotos" | "Medición del manual", "Medición de fotos" ("Manual measurement", "Photo measurement") |
| Seed (manual, mensajes históricos) | Cualquier "evaluación" en un texto visible (p. ej. "evaluación del riesgo") | "valoración del riesgo" u otra forma sin la palabra (WP-53) |
