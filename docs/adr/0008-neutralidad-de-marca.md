---
status: superseded in part by ADR-0018
---

# Marca neutral: "Cuadrilla · Powered by Craftech", operadora ficticia verificada, ningún cliente nombrado

Cuadrilla es propiedad intelectual de Craftech y se construye fuera de cualquier contrato con clientes: repo nuevo, cuenta de Craftech, ningún documento, captura, foto, chat, ticket, pregunta de campo, arquitectura ni proveedor de ningún cliente o empresa real, ni reescrito. Decidimos: marca pública **Cuadrilla** + "Powered by Craftech"; narrativa "a field copilot on WhatsApp for fiber (FTTH) installers of a Latin American ISP"; operadora de la demo **Tulvara Fibra**, ficticia, con un nombre verificado por búsquedas registradas (`Reference/NAMECHECK`) y un modelo comercial inventado (factura mensual); equipos genéricos sin marca; ningún cliente de Craftech nombrado en ningún archivo, commit, texto, dato o PDF.

## Considered options

- **Co-branding con una operadora real escrito en el repo**: ata el árbol, los commits y el seed a una marca de terceros y obliga a sacarla de la lista de términos prohibidos; ADR-0018 lo resuelve como configuración de runtime.
- **Operadora con nombre real "parecido"**: riesgo de confusión con una empresa existente; por eso se descartaron candidatos con coincidencias.
- **Nombre propio y neutral con verificación registrada** (elegida).

## Consequences

- La lista de términos prohibidos (secreto `FORBIDDEN_TERMS`, mantenida por `security`) incluye nombres de clientes de Craftech, empresas del mercado y los productos anteriores; CI la corre sobre árbol, commits, PDFs, textos de fotos, manual, seed y build, y falla cerrado.
- El display name de WhatsApp es "Craftech" (decidido por el CTO el 2026-09-26, P-05).
- ADR-0018 agrega el modo `cobrand` como configuración y el CTO lo eligió para `poc` el 2026-09-26: la operadora de la demo es el socio de diseño, cargado en runtime. **Tulvara Fibra** queda solo como valor por defecto del modo `neutral`, resuelto en runtime por `copy/brand.ts`; ningún texto estático (manual, plantillas, seed, `copy/`) la nombra. Lo demás de esta decisión (equipos genéricos, lugares ficticios, verificación de nombres, nada nombrado en el repo) sigue vigente en los dos modos.
- Si el nombre cambia, cambian el subdominio, la identidad SES y `copy/`.
