---
status: accepted
---

# Datos del responsable de los leads

Decisión del CTO del 2026-10-06. ADR-0026 dejó abiertos en `P-06` los datos con los que el aviso de privacidad nombra al responsable, la vía para ejercer los derechos y la casilla que recibe el aviso de cada lead, con `https://craftech.io/contact/` como vía interina. El CTO los cerró con los mismos datos que usa el producto hermano de Craftech ya publicado, así una persona que se registra en los dos ve el mismo responsable y el mismo canal.

## La decisión

**Responsable del tratamiento** (punto 1 de la política de ADR-0026):

| Dato | Valor |
|---|---|
| Responsable | **Craftech** |
| Domicilio | **Ciudad Autónoma de Buenos Aires, Argentina** |
| Casilla de privacidad y de derechos | **sales@craftech.io** |
| Vía alternativa | El formulario de `https://craftech.io/contact/` |

- **Sin datos inventados.** El aviso no lleva CUIT, razón social distinta de "Craftech" ni calle y número: el CTO no los dio y no se completan por inferencia. Si el CTO los agrega después, entran como versión nueva de `TERMS_PRIVACY`.
- **Sin marcas de interino.** Ningún texto visible dice "a confirmar", "provisorio", "interino" ni equivalentes; los nueve puntos de ADR-0026 quedan escritos con valores finales.

**Lo que dice el aviso con estos datos** (los demás puntos de ADR-0026 no cambian):

- **Retención**: lead confirmado y su cuenta, 24 meses desde el último ingreso o hasta que la persona borre la cuenta o pida la supresión, lo que ocurra primero; el resto de los plazos, los de ADR-0026 ("Borrado a pedido y retención").
- **Base legal**: el consentimiento de la persona (casilla `TERMS_PRIVACY` para el tratamiento y la transferencia; casilla `CONTACT`, opcional, para que Craftech la contacte).
- **Transferencia internacional** (art. 12 de la Ley 25.326): a Amazon Web Services en Estados Unidos (región `us-east-1`) y, para la inferencia del modelo, a otras regiones de AWS donde Amazon Bedrock procesa la inferencia global (ADR-0028), con el consentimiento expreso de `TERMS_PRIVACY`.
- **Derechos**: acceso gratuito (respuesta en 10 días corridos, a intervalos de 6 meses salvo interés legítimo), rectificación, actualización y supresión (5 días hábiles) y retiro del consentimiento de contacto, escribiendo a sales@craftech.io o por `https://craftech.io/contact/`, o borrando la cuenta desde la consola.
- **Leyenda del órgano de control** de la Ley 25.326, literal: "La Agencia de Acceso a la Información Pública, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales." (en inglés, su traducción en la misma página).

**Aviso de lead.** El destinatario del aviso de cada lead es la casilla personal del CTO en `@craftech.io`, cargada en el secreto `LeadConfig.notifyRecipients` (ya cargado el 2026-10-06). Como toda casilla de avisos, nunca se escribe en el código, los tests ni este repositorio (ADR-0026); el cerco `@craftech.io` no cambia. `LeadConfig.privacyContact` = `sales@craftech.io`, el canal público de privacidad que muestra la página.

**Lo que sigue abierto en `P-06`** (no bloquea el build ni la publicación de la demo):

- La validación legal formal del aviso y los términos (ítem 3).
- El procedimiento de borrado fuera de la tabla: quién borra el aviso de un lead borrado o vencido en la casilla que lo recibió y cómo se destruyen los CSV exportados (ítem 5). Mientras tanto rige lo que fija ADR-0026.

## Considered options

- **Mantener la vía interina `https://craftech.io/contact/` como único canal**: un formulario comercial no deja constancia de la fecha del pedido de un derecho; una casilla sí. Queda como vía alternativa.
- **Completar CUIT y domicilio con datos públicos de Craftech**: datos que el CTO no dio no se publican en un aviso legal; un dato equivocado es peor que uno ausente.
- **Una casilla de privacidad nueva (p. ej. `privacy@`)**: el CTO prefirió la casilla comercial que ya atiende y que usa el producto hermano.
- **Los datos del producto hermano** (elegida).

## Consequences

- `/legal/privacy.html` y `/legal/terms.html` pasan a una versión nueva de `TERMS_PRIVACY` (`packages/shared/src/legal/consents.ts`) con el responsable, el domicilio, la casilla y la leyenda; lo hace el dueño de `packages/web/public/legal/**` en su próxima ola (WP-59 en correcciones de la ola 2b.3, o el WP que herede el archivo) y `leads/consent.test.ts` verifica que la página nombra la casilla, la vía alternativa y la leyenda, y que ningún texto visible contiene una marca de interino.
- ADR-0026 puntos 1, 4 y 8 remiten a este ADR; `P-06` cierra los ítems 1, 2 y 4 (`docs/pending.md` §6).
- El operador corre `npm run leads:notify-test -- --stage poc` con la configuración cargada y confirma que el aviso llegó (`docs/architecture.md` §17 ítem 13).
