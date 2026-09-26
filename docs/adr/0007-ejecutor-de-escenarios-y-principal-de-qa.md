---
status: accepted
---

# Los flujos se prueban en el stage desplegado con un ejecutor de escenarios y un principal de QA propio, solo con IAM

"100 % probada" exige ver cada flujo con los servicios reales: el Harness decidiendo, Transcribe transcribiendo, la Knowledge Base recuperando, el validador multimodal mirando la foto, SES entregando, el Scheduler venciendo. Decidimos, igual que en la otra POC de la hackathon, correr un **ejecutor de escenarios** (`scripts/scenarios/`) contra `poc` que maneja cada flujo por una Lambda **`QaDriver`** sin URL, invocable solo por el rol **`aws-cds-hackathon-poc-cuadrilla-qa-runner`** del bootstrap. Cada escenario trabaja en su propio mundo (operadora propia `isp-qa-<runId>-<escenario>` de tipo `QA`, reloj `qa-*`, órdenes clonadas) y asierta sobre estado y bitácora. Las corridas de evaluación (`EV-01`, `EV-02`) usan el mismo principal en mundos `eval-*`.

La compuerta es **solo IAM**: ningún escenario usa una contraseña ni un navegador contra el stage. El recorrido del invitado (`SC-18`) y sus sesiones (`SC-19`) corren por el `QaDriver` con un principal `GUEST` armado en el servidor (`usr-qa-guest`, ligado a `isp-guest-test`), que ejecuta los mismos procedimientos tRPC que la consola (`console.tour.run`, `console.clock.*`, `console.simulator.*`, `account.session`). El login SRP real en el navegador y el recorrido dibujado quedan probados por `UI` locales y por un **ensayo del invitado** que corre el operador antes de entregar credenciales (`scripts/guest/rehearsal.ts`, fuera de la compuerta).

## Considered options

- **Solo pruebas locales**: no prueban permisos, propagación de IAM, entregas de SES, Cedar ni la calidad real del modelo.
- **Playwright con usuarios reales en CI**: exige credenciales humanas en CI.
- **Invocar las Lambdas de producto desde el runner**: permisos amplios y medio sistema reimplementado.
- **Un driver único con acciones acotadas y principales armados en el servidor** (elegida).

## Consequences

- Toda acción que muta exige una operadora de tipo `QA` o `EVAL` y un reloj `qa-*`/`eval-*`, o las listas cerradas de `GUEST#isp-guest-test` (`world.create` con la plantilla `guest`, `console.*` con el principal `GUEST`); borrados con condición `world IN (qa, eval)`.
- Los pasos que dependen del modelo se marcan `agent` y se aceptan con oráculo en ≥ 2 de 3 corridas; los deterministas (`det`) pasan 3 de 3. Las precondiciones que antes exigían turnos del modelo se siembran con presets de `world.create` o con `case.open` (camino real de `open_case`).
- El driver publica en el topic propio eventos con otro número (con el atributo `qa-foreign=1`) para probar el descarte sin WABA.
- La suite completa cuesta turnos de Bedrock: se corre a pedido y antes de cada entrega, con topes de turnos y validaciones; en cada deploy solo corre el smoke.
