---
status: accepted
---

# Techo de costo global del stage y corte de emergencia en runtime, sin deploy

Cada mundo de jurado tiene topes propios (turnos, validaciones, minutos de transcripción, emails) y cada operadora su `TURNCAP#`, pero hay entre 10 y 16 cuentas de jurado con credenciales compartidas en un campo privado de Devpost: una filtración multiplica los topes por mundo. AWS Budgets solo avisa, y el `forbid` total de Cedar (`CED-KILL-SWITCH`) exige un deploy por CI y no detiene el gasto (el worker igual invoca el Harness, Transcribe y G1; Cedar solo corta las tools). Decidimos:

1. **Techo global por día real** en `Runtime`, para todos los mundos que no son QA ni evaluación: `TURNCAP#GLOBAL#<realDay>` (1.500 turnos), `VALCAP#GLOBAL#<realDay>` (400 validaciones), `TRANSCRIBE#GLOBAL#<realDay>` (5.400 s). Valores en `sst.Linkable("CostCaps")` (`infra/cost-caps.ts`). Se reservan con `UpdateItem ADD` condicional **antes** de gastar: el BFF antes de encolar un `simulator.*`, el worker antes de `InvokeHarness` y de `StartTranscriptionJob`, `ToolEvidence` antes de `Converse`. Las corridas de QA y evaluación tienen su presupuesto por corrida (`docs/test-plan.md` §4.4) y no consumen el techo global.
2. **Corte de emergencia** (`kill switch`) como dato: `Runtime/KILL#{ALL|SIMULATOR|AGENT}` (global) y `Runtime/KILL#AGENT#<clockId>` (por mundo, el único que el `QaDriver` puede escribir, solo en relojes `qa-*`). Lo leen el BFF, el worker, `InboundWhatsApp` y `createToolHandler` con caché ≤ 30 s. Con `AGENT` activo, el worker responde el aviso fijo `servicePaused` sin invocar el Harness, Transcribe ni el validador; con `SIMULATOR`, el simulador deja de aceptar mensajes; con `ALL`, las dos cosas y la consola queda de solo lectura. La **seguridad física nunca se corta**: el clasificador, la instrucción fija de §SEG-01 y las alertas siguen funcionando porque no usan modelo.
3. **Activación**: el operador con `npm run ops:kill -- --scope AGENT --on|--off` (SDK con su profile, auditado `KILL_SWITCH_SET`), y automáticamente por la Lambda `CostGuard`, suscrita a un topic SNS al que publican la notificación del presupuesto de AWS Budgets (100 % del mensual) y las alarmas `CostPerConversation` y `TurnCapHits{scope=GLOBAL}`. `CostGuard` solo puede encender el corte, nunca apagarlo.
4. `CED-KILL-SWITCH` queda como **segunda capa** (desactivado; se activa por IaC si el dato no alcanzara).
5. **Mensajes vivos de WhatsApp.** Solo el transporte `live` genera cargos de Meta (el simulado cuesta 0 y se valoriza "como vivo", rotulado). Meta cobra por mensaje: las plantillas desde el 2025-07-01 y, **desde el 2026-10-01, también los mensajes dentro de la ventana** (montos chicos). No hace falta un contador nuevo: todo saliente vivo nace de un turno, de un evento del mundo vivo o de un teléfono ligado por código (`PHONELEASE#`, con los topes del mundo del jurado), así que lo acotan `TURNCAP#` (operadora y global), `SIMCAP#` del mundo y `UNKNOWN#GLOBAL` (respuestas a números desconocidos); `CostPerConversation` suma el costo por mensaje de `RATECARD` (`whatsapp:MX:utility` y `whatsapp:MX:service`, este último distinto de 0 desde el 2026-10-01) y su alarma enciende el corte como cualquier otra.

## Considered options

- **Solo topes por mundo y presupuesto**: una credencial filtrada multiplica el gasto por la cantidad de mundos.
- **Acción de AWS Budgets directa**: las acciones de Budgets aplican políticas IAM o SCP, no escriben un dato de la aplicación; una política IAM de denegación sobre el rol del Harness sería más brusca (rompe también la seguridad física si comparte rol) y más lenta de revertir.
- **Techo global + corte como dato + Cedar de respaldo** (elegida).

## Estado

- **2026-09-26:** verificado que Meta cobra también los mensajes dentro de la ventana desde el 2026-10-01; se agrega el punto 5 (sin contador nuevo) y WP-49 carga `whatsapp:MX:service` con precio, fuente y fecha.

## Consequences

- `FL-083`, `FL-098` y `FL-100` cubren los topes globales y el corte; `worker/cost-caps.test.ts`, `ops/kill-switch.test.ts` y un paso `SR` que enciende el corte por mundo y verifica que no hubo `InvokeHarness`.
- Las contraseñas de jurado son aleatorias (≥ 24 caracteres) por cuenta y las cuentas solo están habilitadas en la ventana de evaluación (`docs/pending.md` P-03).
- El panel de métricas muestra el consumo del techo global del día y si el corte está activo.
