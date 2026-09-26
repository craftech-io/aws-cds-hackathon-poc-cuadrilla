---
status: accepted
---

# Co-branding con el socio de diseño como configuración fuera del repo; marca neutral como respaldo

El brief aprobado permite presentar la demo en co-branding con el cliente de diseño que dio su conformidad ("Cuadrilla for <socio>" / "<socio> × Cuadrilla · Powered by Craftech"), con su logo público y un aviso visible de que el manual, las políticas y los datos son una demo sintética. Al mismo tiempo, las reglas del repo prohíben escribir el nombre de cualquier cliente en el árbol, los commits, el seed o los tests, y la lista de términos prohibidos (`FORBIDDEN_TERMS`) falla cerrado en CI. Decidimos que **la marca de la operadora de la demo sea configuración de runtime** y no contenido del repo:

- Secreto `BrandConfig` (JSON, `infra/secrets.ts`): `{mode: "neutral" | "cobrand", signupMode?: "neutral" | "cobrand", partnerDisplayName, partnerShortName, logoAssetKeys: {onLight, onDark}, disclaimer: {es, en}}`; `signupMode` (por defecto `neutral`) es la marca de los mundos de alta propia (ADR-0024 §2). Valor inicial `{"mode": "neutral"}`. `logoAssetKeys` son claves genéricas de `Seed/brand/` (`brand/logo-on-light.svg`, `brand/logo-on-dark.svg`), nunca el nombre del socio.
- Una sola función resuelve la marca: `resolveBrand(BrandConfig)` en `packages/bff/src/copy/brand.ts`. En `neutral` devuelve la operadora ficticia por defecto **Tulvara Fibra** (verificada en `Reference/NAMECHECK`); esa constante es la **única** aparición del nombre ficticio en el código, el seed y los textos (los documentos de diseño lo citan como valor por defecto). En `cobrand` devuelve `partnerDisplayName`.
- **Nada estático nombra a la operadora.** El manual (repo y Knowledge Base), los textos de `copy/`, las plantillas de WhatsApp registradas en Meta, el system prompt, los ids y textos del seed, los textos que dibujan las fotos y la muestra `acta-muestra.pdf` dicen "la operadora" o "la empresa". El nombre visible se pone en runtime: la fábrica de mundos y el loader escriben `Isps/META.displayName` con `resolveBrand` en todo mundo (demo, invitado, QA, evaluación); el loader lo reescribe en los mundos existentes cuando cambia `BrandConfig`; las actas históricas del 12/10 se renderizan al cargar, con el nombre resuelto (`docs/seed-spec.md` §7).
- En `cobrand`, cada superficie muestra "Cuadrilla for <socio> · Powered by Craftech" y el **aviso fijo** "Demo sintética: el manual, las políticas y los datos son inventados y no son las políticas reales de <socio>" (es/en, `copy/es-MX.ts` con el nombre como parámetro):

  | Superficie | Marca | Logo |
  |---|---|---|
  | Landing (`brand.get` público), shell de la consola, simulador | `BrandMark`: "Cuadrilla" + "for <socio>" + "Powered by Craftech" y el aviso | SVG del socio por GET prefirmado de `Seed/brand/` (variante `onLight` u `onDark` según el fondo), mostrado solo con `<img>`; sin logo, marca de texto |
  | Visor del manual | Encabezado con la marca y el aviso antes de las secciones | Igual que la consola |
  | Acta (PDF) | Encabezado "<socio> · Cuadrilla" y pie "Cuadrilla for <socio> · Powered by Craftech" con el aviso | Ninguno (el escritor de PDF solo embebe JPEG): marca de texto |
  | Emails (acta, alertas) | Primera y última línea del cuerpo con la marca y el aviso; asunto con "(demo sintética)" | Ninguno (texto plano) |

  El remitente visible de los emails es genérico en los dos modos (`"Cuadrilla · Actas"`, `"Cuadrilla · Alertas"`): el nombre de la operadora va en el asunto y el cuerpo, nunca en el encabezado `From`.
- En `neutral`, la marca es "Cuadrilla · Powered by Craftech" y la operadora ficticia se rotula "ficticia" en la landing, el acta y los emails.
- **Alcance de la autorización del socio.** La autorización escrita cubre el formulario de la submission, la landing y el video. No cubre con claridad los emails a direcciones que nadie verificó ni la consola de cualquier visitante que se registra solo. Por eso, en todo modo, los **emails de autenticación** (código de alta, reenvío, recuperación, invitación) llevan la marca neutral "Cuadrilla · Powered by Craftech", y los **mundos de alta propia** usan `signupMode`, que por defecto es `neutral` (la operadora ficticia rotulada). Los mundos de las cuentas invitadas y el de demo siguen el `mode`. El CTO pasa `signupMode` a `cobrand` solo si confirma con el socio que la autorización cubre esa superficie.
- Nada cambia de lo sintético: el manual, las políticas comerciales (incluido el modelo de "cargo en la siguiente factura", rotulado inventado), los precios, las órdenes, las personas y las fotos siguen siendo nuestros e inventados; ningún material del socio entra al repo, salvo su logo público, que vive solo en `Seed/brand/`.
- `FORBIDDEN_TERMS` **conserva** el nombre del socio: como la marca se lee en runtime, el árbol, el build estático (`dist`), el seed y los PDFs versionados nunca lo contienen. Todos los demás clientes de Craftech y los productos de las referencias internas siguen en la lista.

## Considered options

- **Marca neutral siempre** (ADR-0008 original): deja sin usar una autorización que el brief ya dio y resta credibilidad de "caso real" ante los jueces.
- **Nombre del socio escrito en `copy/`, seed y README**: contradice la regla del repo y obliga a sacar el nombre de `FORBIDDEN_TERMS`, que entonces dejaría de proteger contra fugas de material del socio.
- **Marca como configuración de runtime, con respaldo neutral** (elegida): el repo queda neutral y verificable por CI, la demo desplegada va en co-branding con una carga de secreto y de logos, y la decisión se revierte sin commits.

## Estado

- **2026-09-26 · decidido por el CTO (`docs/pending.md` P-05, cerrado):** modo **`cobrand`** en `poc`. El CTO tiene la autorización escrita del socio para nombrarlo en Devpost, la landing y el video. Decisión del equipo (no del CTO, más estricta que el brief, que permitía nombrarlo también en el README): el repo, el README y el código siguen genéricos ("design partner") y no hay excepción de `FORBIDDEN_TERMS` para el README; si el CTO pide nombrarlo en el README, se revisa esta línea. Display name de WhatsApp: "Craftech". Nombre de la submission: "Cuadrilla".
- Los dos SVG públicos del socio (fondo claro y fondo oscuro) se descargaron con la aprobación del CTO fuera del repo; el operador los sube a `Seed/brand/` con `seed:load --brand-logo-on-light/--brand-logo-on-dark`, que los valida (`docs/pending.md` §5). La marca de texto sigue como respaldo.

## Consequences

- Supersede a ADR-0008 en lo que dice de co-branding; sus reglas de neutralidad (equipos genéricos, ciudad y domicilios ficticios, verificación de nombres) siguen vigentes, y la operadora ficticia queda como valor por defecto de runtime del modo `neutral`.
- `BrandMark` es genérico (nombre y logos por props, marca de texto de respaldo) y su test cubre los dos modos; `landing.spec.ts` y `SC-18/1` verifican la marca y el aviso según `brand.get`; `copy.test.ts` y `manual:check` fallan si un texto estático contiene el nombre por defecto de `copy/brand.ts`; los oráculos de los escenarios leen el nombre de `Isps/META` del mundo, nunca un literal.
- Un SVG en `Seed/brand/` solo se muestra con `<img>` (sin ejecución de scripts) y el loader rechaza un archivo con contenido activo; la CSP de la web incluye el bucket `Seed` en `img-src`.
- El texto de la oportunidad ACE y de Devpost (fuera del repo) nombra al socio.
