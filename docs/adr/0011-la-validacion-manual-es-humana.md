---
status: accepted
---

# La validación manual de evidencia es siempre humana y el agente nunca decide por un supervisor

La validación de fotos es asistencia: un modelo puede rechazar una foto buena o dudar. El acta es un documento que la operadora entrega a su cliente. Decidimos que **no exista ninguna tool del agente que valide manualmente evidencia, tome, rechace o cierre un caso**: la validación manual (`Override`) es un procedimiento de la consola que exige rol `SUPERVISOR` (o `GUEST` en su mundo), login de 15 minutos o menos y un motivo, y queda en el acta con el nombre de quien la hizo. Tomar, "No puedo" y cerrar un caso son botones de una persona (o acciones de consola). Cedar refuerza la cerca (`CED-NO-OVERRIDE`, `CED-NO-SUPERVISOR-DECISION`, `CED-NO-FORCE-CLOSE`, con los campos declarados como "never set" para que el statement sea válido) y zod `.strict()` los rechaza con cualquier valor; `update_checklist` exige una validación `PASS` (`LAM-EVIDENCE`).

## Considered options

- **Aceptar la foto si el modelo no está seguro**: traslada al modelo una responsabilidad de la operadora.
- **Tool de override protegida por Cedar**: una cerca más que alguien puede aflojar; si la acción no existe, ninguna inyección la alcanza.

## Consequences

- Una inyección (por texto, voz o imagen) que pida aprobar no tiene a qué llamar.
- `PolicyAudit` verifica que ninguna acta tenga un ítem `PASSED` sin validación `PASS` ni `OVERRIDDEN` sin usuario.
- La bandeja "Revisión de evidencia" recibe los `UNSURE`: el caso incierto va a una persona, no a una regla.
