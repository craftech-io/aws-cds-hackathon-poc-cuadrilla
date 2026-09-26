---
status: accepted
---

# Reloj de demo por mundo, en pausa por defecto, con épocas

Un invitado tiene que ver un día de trabajo completo (07:30 a 15:30) en minutos, sin que otro invitado ni el ejecutor le muevan el mundo, y encontrarlo en las 07:00 aunque entre semanas después. Decidimos que cada orden pertenezca a un **reloj** (`clockId`) con dos modos: `PAUSED` por defecto (la hora solo se mueve con los controles, que despachan los temporizadores vencidos en orden) y `RUNNING` (tiempo real con offset, schedules reales en un horizonte de 1 h, vuelta a pausa a los 30 min). Relojes: `GLOBAL#isp-demo` (demo del operador, el único que puede ser el mundo vivo de WhatsApp), `GUEST#isp-guest-<nn>` (uno por invitado, creado en su primer login), `qa-*` y `eval-*`. Cada reloj tiene una **época** que sube en cada reinicio y nunca vuelve atrás, y entra en los identificadores de sesión y actor de AgentCore Memory. Controles propios de esta POC: "Iniciar el día", "Forzar vencimiento del caso", estado simulado de plantillas (plan B) y comportamiento de una ONU.

## Considered options

- **Un reloj global**: una corrida de QA movería el día de un invitado.
- **Tiempo real con órdenes sembradas cerca de cada evento**: no permite ver el día completo ni la escalera sin esperar.
- **Reloj por mundo en pausa, con épocas** (elegida; el camino de schedules reales se prueba con un paso explícito y "Reloj en vivo" lo muestra a pedido, con el vencimiento de 60 s del modo demo).

## Consequences

- Toda regla de negocio recibe el reloj por inyección; ninguna llama `Date.now()`.
- La política evalúa horario de silencio, aviso del día y ventana (en simulado) en tiempo simulado; tokens, URL prefirmadas, login y topes de costo usan tiempo real.
- Después de un reinicio, el agente no recuerda a otro invitado: actor nuevo y purga de Memory en pasadas.
- Desde la consola, ningún movimiento ocurre con el mundo ocupado (`WORLD_BUSY`).
- El vencimiento corto del modo demo (`demoCaseTimeoutSec`) rige solo con el reloj `RUNNING`; en pausa rige `caseTimeoutSec`.
- Los límites anti-abuso de tiempo usan tiempo real (`RATE#…#<realHour>`), así que "+1 h" no los reinicia.
