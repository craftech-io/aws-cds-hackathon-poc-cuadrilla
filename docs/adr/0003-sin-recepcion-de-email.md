---
status: accepted
---

# Cuadrilla no recibe email: SES solo de salida, destinatarios del simulador de buzones

La cuenta admite un solo receipt rule set activo por región, y el activo es de la otra POC. Activar uno propio desactivaría el suyo; agregar reglas al suyo sería tocar un recurso ajeno. Decidimos que **Cuadrilla no use recepción de email**: sin MX de recepción, sin rule sets, y un rol de CI sin ninguna acción de receipt rules. Los destinatarios de los emails (clientes sintéticos, buzón de operaciones, jefes de zona) usan el **simulador de buzones de SES** (`success+<etiqueta>@simulator.amazonses.com`, y `bounce+`/`complaint+` para probar rebotes y quejas), que entrega sin un buzón que tengamos que leer y sin afectar la reputación; la entrega se verifica por los eventos de SES y la consola muestra cada email tal como salió en el **buzón de salida**. Para la demo en vivo se registran buzones del equipo en `SeedOverrides`.

## Considered options

- **Rule set propio**: desactiva el de la otra POC.
- **Regla en el rule set de la otra POC**: toca un recurso ajeno y ata los dos deploys.
- **Buzones de nuestro dominio sin MX**: rebote seguro y reputación dañada.
- **Solo salida + simulador de buzones + eventos** (elegida). Ningún flujo necesita email entrante: los supervisores responden por WhatsApp y el jefe de zona entra a la consola.

## Consequences

- El cerco de destinatarios deniega nuestro propio dominio; `iam-capabilities.test.ts` y `ci-role.test.ts` fallan si aparece una acción de receipt rules.
- La prueba de "email entregado" es el evento `DELIVERY` de SES, no la lectura de un buzón.
- Si más adelante hiciera falta email entrante, se usaría otra región o una cuenta propia, con un ADR nuevo.
