---
status: accepted
---

# La política de contacto vive en código, no en el prompt

Quién puede recibir qué, cuándo y por dónde (lista de permitidos, opt-in, baja, ventana de 24 h, plantilla aprobada, horario de silencio, roster de supervisores, puente abierto, cerco de destinatarios, evidencia completa para el acta, cita obligatoria) no puede depender de que el modelo lo recuerde. Decidimos un módulo puro `packages/bff/src/policy/` con los relojes inyectados (el del mundo para identidades sintéticas; el real y `lastInboundAtReal` para todo destinatario con transporte `live`, ADR-0002), reglas con id (`CP-*`) y un orden fijo; lo importan la tool de envío, los mensajes de sistema, la escalera, el puente, el acta y `PolicyAudit`.

## Considered options

- **Reglas en el system prompt**: no auditables, inyectables.
- **Reglas en Cedar**: Cedar no ve la sesión, la ventana, el roster ni el estado de las plantillas.

## Consequences

- Una denegación por horario difiere el mensaje con un temporizador; una por plantilla no aprobada activa el plan B en la escalera.
- Cada decisión queda con sus `ruleIds`; "violaciones de política" tiene una definición verificable (0).
