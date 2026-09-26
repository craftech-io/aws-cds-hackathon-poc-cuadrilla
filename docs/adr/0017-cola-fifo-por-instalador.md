---
status: accepted
---

# Una cola FIFO por instalador serializa voz, turnos, casos y puente

Un instalador manda una nota de voz y enseguida una foto; un supervisor toca "Tomar caso" en el mismo segundo en que vence el escalón; el instalador escribe mientras el supervisor responde. Si esos eventos corren en paralelo, el orden se pierde (el texto se procesa antes que la voz que lo precede) y dos efectos compiten (un vencimiento reasigna un caso que ya se tomó). Decidimos que la unidad de trabajo sea el **instalador**: todo evento que le habla o cambia su trabajo va a `InstallerEvents.fifo` con `MessageGroupId = installerId`, incluidos los botones y textos de supervisores y los vencimientos de casos (se resuelve el caso y se encola en el grupo del instalador dueño). La transcripción corre dentro del mensaje de la cola, antes del turno.

## Considered options

- **FIFO por orden de trabajo**: los mensajes del instalador que no son de una orden (ALTA, órdenes del día) y el cambio de orden activa quedan en otro grupo y compiten con los de la orden.
- **Transcripción asíncrona por evento de Transcribe**: más rápida en paralelo, pero desordena la conversación.
- **FIFO por instalador** (elegida).

## Consequences

- Los turnos de un instalador son secuenciales; la concurrencia es entre instaladores: `ScalingConfig.MaximumConcurrency = 10` en el event source mapping (admitido en FIFO) en lugar de concurrencia reservada, para que una ráfaga no estrangule mensajes que vuelven a la cola y suman intentos; `maxReceiveCount 5` (la idempotencia `IDEMP#` cubre los reintentos).
- Las escrituras de la escalera siguen siendo condicionales (`rungVersion`), como segunda defensa.
- La quiescencia se mide por instalador (`installer.settle`) y por mundo.
