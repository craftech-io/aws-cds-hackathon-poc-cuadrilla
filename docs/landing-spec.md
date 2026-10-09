# Landing spec · superficies públicas de Cuadrilla

Especificación de diseño de la landing comercial (`/`), el signup/login propios y las páginas legales,
según el estándar de la skill `poc-landing` y la decisión del CTO del 2026-09-26 (marca neutra al
concurso, rol `GUEST`, signup con captación de leads). Documento de equipo, en español neutro; los
textos de producto que contiene van en es-MX y en, listos para copiar a `packages/web/src/views/*/copy.ts`
y `packages/bff/src/copy/`.

No implementa nada: es el insumo para `typescript-dev` (WP-55, WP-57, WP-58, WP-59, WP-60, ola 2b.2) y
para `qa` (WP-62, verificación de la ola 2b.3). No toca `docs/design-brief.md`, `CONTEXT.md` ni ningún
otro doc — los edita `architect` en paralelo. Vocabulario: `CONTEXT.md`. Producto y flujos:
`docs/design-brief.md`, `docs/flows-catalog.md`. Código ya construido citado como referencia:
`packages/web/src/views/landing/`, `packages/web/src/views/login/`, `packages/web/src/index.css`,
`packages/bff/src/copy/`.

**Regla de idioma, sobre todo texto es-MX de este documento**: es-MX = tuteo ("crea", "prueba", "tienes"),
nunca voseo ("creá", "probá", "tenés"). Todo string es-MX de este documento ya está en tuteo; ninguna
implementación necesita convertirlo.

**Regla dura, sobre todo lo que sigue**: ningún texto visible (esta landing, el signup/login, la consola,
los legales, el seed) nombra el concurso, ni "jurado"/"judge"/"evaluación". El rol es **invitado**
(código `GUEST`, usuarios `guest-NN`). Ningún texto nombra al socio de diseño, a un cliente de Craftech,
a una marca de terceros ni a un producto de referencia interno: esos nombres son configuración de
runtime (`BrandConfig`) o no existen en el repo. Verificar con
`FORBIDDEN_TERMS="$(cat <ruta-de-la-lista>)" npm run lint:forbidden` (si `node_modules` resuelve) o con
`grep` de la lista sin imprimir sus términos.

---

## 0. Qué cambia respecto de lo ya construido

La landing y el login de las olas 0-1 (`packages/web/src/views/landing/`, `.../login/`) ya existen y
funcionan; esta spec no los descarta, los **extiende**:

| Ya construido | Qué hace hoy | Qué cambia esta spec |
|---|---|---|
| `LandingView.tsx`, `copy.ts` | Header con `BrandMark` + selector es/en, hero, bloque "qué es real y qué es simulado", footer con legales | El hero se reescribe (sin "hackathon", CTAs nuevos), se agregan las secciones 2-9 de este documento (problema, recorrido, actores, confianza, impacto, integración, simulado, CTA final), y el CTA pasa de "Jurado: iniciar sesión" a **"Probar la demo"** / **"Ingresar"** / **"Hablemos"** |
| `gallery.tsx`, `Lightbox.tsx`, `MediaFigure.tsx` | Contexto de galería con zoom ya genérico, se reutiliza tal cual (`docs/reuse-map.md` línea 132: "Copiar") | Se le agregan las imágenes del manifiesto de §6 |
| `media.ts`, `public/landing/manifest.json` | Manifiesto versionado ya definido (`version`, `video`, `media: {file, width, height, alt, status}`) | Se agrega `status: "render"` (nuevo) junto a los ya tipados `"placeholder"` y `"capture"`, y se listan los ids reales del manifiesto de §6.3 |
| `index.css` `@theme` | Paleta navy/cyan + semánticos ya en producción en consola y login | §2 **re-tunea los valores hex de los mismos nombres de token** (identidad propia de Cuadrilla, §2.1) y agrega los tres tokens nuevos ya justificados; ningún nombre de token cambia, ningún componente de la consola o del login cambia de clase — cambian solo los `--color-*` de `index.css`, en el mismo PR de WP-55 |
| `LoginView.tsx`, `AuthFlowPanel.tsx`, `steps.tsx`, `use-auth-flow.ts` | Máquina de pasos del login (`credentials → newPassword → totp → mfaSetup → forgotRequest → forgotConfirm → done`), panel de marca a la izquierda, tarjeta blanca a la derecha | El signup (§7) es una máquina de pasos **nueva y paralela** (`signUp → confirmCode → done`, sin paso intermedio: §7.1) con el mismo lenguaje visual; el login no cambia de flujo, solo de copy (ya no dice "tu usuario se crea por invitación" como única vía, §7.7) |
| `infra/auth.ts` | `AllowAdminCreateUserOnly: true`; grupos `SUPERVISOR`/`JUDGE`/`OPS`; sin self-service | Decidido por **ADR-0025** (alta propia, mundo de invitado, anti abuso) y construido por WP-56/WP-57/WP-58 (`docs/build-plan.md`, ola 2b.2); esta spec no decide el mecanismo, especifica la UX y los textos sobre lo que ADR-0025 ya fija (Cognito `SignUp`/`ConfirmSignUp`, login SRP automático tras confirmar, §7.1) |
| `public/legal/privacy.html`, `terms.html` | Ya existen, en es, mencionan "jurado" y la hackathon | Los reescribe `typescript-dev` en WP-59 según **ADR-0026** (responsable, finalidades, retención, derechos, Ley 25.326) y los textos de consentimiento de `packages/shared/src/legal/consents.ts`; no los especifica este documento |

---

## 1. Narrativa y contenido

### 1.1 Estructura de la página

| # | Sección | Ancla |
|---|---|---|
| 1 | Header fijo: marca + selector es/en + accesos | `#top` |
| 2 | Hero | `#hero` |
| 3 | El problema | `#problema` |
| 4 | Recorrido del producto (el corazón) | `#recorrido` |
| 5 | Qué hace, por actor | `#actores` |
| 6 | Confianza: reglas garantizadas en código | `#confianza` |
| 7 | Impacto (metas) | `#impacto` |
| 8 | Cómo se integra | `#integracion` |
| 9 | Qué es real y qué es simulado | `#real` |
| 10 | Galería con zoom | `#galeria` |
| 11 | CTA final | `#empezar` |
| 12 | Footer | `#footer` |

### 1.2 Header

**Desktop / tablet (≥640px)**: izquierda, `BrandMark` (componente ya existente, sin cambios) — "Cuadrilla
· Powered by Craftech" en modo neutral, o "Cuadrilla for &lt;socio&gt; · Powered by Craftech" + aviso en
modo `cobrand`, ambos resueltos en runtime. Derecha: selector es/en (ya existente, `useLandingLang`,
extendido según §1.2.1) + dos accesos de texto: **Ingresar** (link a `/login`) y **Probar la demo** (botón
sólido, link a `/signup`). En scroll, el header se comprime (`py-3` → `py-2`, sombra sutil) pero nunca
desaparece: ambos accesos están siempre a un tap.

**Mobile (&lt;640px)**: a ese ancho no entran juntos el `BrandMark` co-branded completo, el toggle es/en y
dos botones de ≥44px sin arriesgar scroll horizontal (regla dura del proyecto). El header compacto de
mobile es:

- Izquierda: wordmark de Cuadrilla + logo del socio si hay co-branding (sin "Powered by Craftech": ese
  texto se mueve al footer en mobile, §1.12).
- Derecha: el toggle es/en como un botón único de ≥44px que alterna la etiqueta ("EN" ↔ "ES", nunca los
  dos textos a la vez) y **un solo** acceso visible, **Probar la demo** (botón sólido, ≥44px).
- **Ingresar** no vive en el header compacto: está en los tres CTAs del hero (§1.3), a un scroll de
  distancia, así el header nunca compite por espacio con el toggle.
- El aviso de co-branding de ADR-0018 ("Demo sintética: el manual, las políticas y los datos son
  inventados y no son las políticas reales de &lt;socio&gt;") es obligatorio en la landing (ADR-0018): en
  mobile vive en la nota bajo los CTA del hero (§1.3), arriba del pliegue, no en el header. En modo
  `neutral`, esa nota rotula la operadora "ficticia".

### 1.3 Hero (`#hero`)

**Objetivo**: en una línea, decir qué es, para quién, y que funciona — sin pedir que el visitante intuya
que hay un producto real detrás.

Layout desktop (≥1024px): dos columnas, 55/45. Izquierda: eyebrow + título + bajada + los tres CTAs +
nota de confianza. Derecha: el **loop del producto** (`hero-loop`) — una animación de 14-18 s en loop (no
video con controles) que muestra, comprimido, el corazón del recorrido de §1.6: nota de voz → respuesta
citada → foto rechazada → ✅ → PDF, dentro de un marco de teléfono. La nota de voz se ve como en WhatsApp
(forma de onda, duración y ✓✓ leído), **nunca con su transcripción**: quien envía una nota de voz no ve su
texto, y las transcripciones solo existen en la línea de tiempo de la orden de la consola (M0, ADR-0023 §6). Es la versión corta del recorrido
completo; un visitante que nunca baja de la primera pantalla ya vio el producto funcionando. El loop tiene
motion propio con control de pausa y freno de repetición — fila **M0** de la tabla de motion (§3); no es
una animación "libre" sin especificar, es el elemento más visible de toda la landing.

**Mobile (<1024px), orden vertical** (regla dura, N3): el `hero-loop` **no** va primero. El orden es
eyebrow → H1 → bajada → CTA primario (**Probar la demo**) → CTA secundario e Ingresar/Hablemos → nota de
confianza → el loop del producto (o su póster con `prefers-reduced-motion`) debajo, a una altura legible
de **al menos 320px** (nunca 200-240px: un chat dentro de un marco más chico que eso es ilegible y no debe
competir con el H1 por espacio vertical). El CTA primario queda **arriba del pliegue en 360×640** en todo
caso — es el objetivo de conversión del hero y no puede depender de que el visitante baje.

Copy:

| Campo | es-MX | en |
|---|---|---|
| Eyebrow | Copiloto de campo en WhatsApp | A field copilot on WhatsApp |
| Título (H1) | Cada instalación, cerrada con evidencia a la primera | Every installation, closed with evidence on the first visit |
| Bajada | El instalador de fibra trabaja solo, con las manos ocupadas. Le escribe a Cuadrilla por WhatsApp — con texto o una nota de voz — y el agente lo guía con el manual de la operadora, revisa cada foto antes de aceptarla y avisa a un supervisor cuando hace falta una persona. | A fiber installer works alone with busy hands. They message Cuadrilla on WhatsApp — text or a voice note — and the agent guides them with the operator's manual, checks every photo before accepting it, and brings in a supervisor when a person is needed. |
| CTA primario | Probar la demo | Try the demo |
| CTA secundario | Ingresar | Sign in |
| CTA terciario | Hablemos | Let's talk |
| Nota bajo los CTA | Entorno de demostración con datos sintéticos, en unos minutos. Tu cuenta y tu propio mundo de prueba se crean al confirmar tu email. | Demo environment with synthetic data, in a few minutes. Your account and your own test world are created once you confirm your email. |

Los tres CTAs, en ese orden de peso visual: **Probar la demo** (botón sólido `bg-cyan`, como el CTA
actual) → `/signup`; **Ingresar** (botón outline, `border-mist` sobre navy o `border-cyan-soft`) →
`/login`; **Hablemos** (link de texto con flecha, sin botón) → `https://craftech.io/contact/` en una
pestaña nueva (`target="_blank" rel="noopener"`), porque saca al visitante del sitio y no debe cortar
su sesión de exploración.

**Nota de confianza sin promesa de tiempo (B10)**: la nota bajo los CTA ya no dice "en menos de un
minuto" — el alta pasa por un código de verificación por email, que ninguna landing puede prometer en
segundos; dice "en unos minutos", honesto con el viaje real (§7.1). El mismo cambio aplica al CTA final
(§1.12).

**Idioma persistente entre la landing y el alta/login (B9)**: los links a `/signup` y `/login` de los
tres CTAs (hero y CTA final) agregan el parámetro `?lang=es-MX` o `?lang=en` según el idioma actual de
`useLandingLang`; el shell de signup/login (`AuthShell`, §7.1) lo lee al montar y arranca en ese idioma,
sin pedirle al visitante que elija de nuevo. El toggle es/en del header de la landing es el mismo patrón
que el toggle del `AuthShell` (§7.9): cambiar de idioma en cualquiera de las dos superficies no pierde el
progreso del formulario.

### 1.4 El problema (`#problema`)

Tres dolores concretos, cada uno con antes/después, tomados de `docs/design-brief.md` §1 (sin la columna
de mitigación técnica, que es lenguaje interno):

| # | Dolor | es-MX (antes → con Cuadrilla) | en |
|---|---|---|---|
| 1 | Dudas en sitio | Hoy llama o le escribe a su jefe de equipo y espera; si no contesta, improvisa. → Con Cuadrilla pregunta por WhatsApp — texto o nota de voz — y en segundos tiene la respuesta del manual, con la sección citada. | Today they call or text their crew lead and wait; if no one answers, they improvise. → With Cuadrilla they ask on WhatsApp — text or voice note — and get the manual's answer in seconds, with the section cited. |
| 2 | Revisitas por evidencia mala | Hoy la instalación se cierra con fotos borrosas o sin la lectura de potencia; el acta se arma después, a mano. → Cada foto se revisa al llegar, con un motivo accionable si no sirve ("hay reflejo: inclina el teléfono"), y el acta sale sola con la evidencia validada. | Today the job closes with blurry photos or no power reading; the certificate gets pieced together later, by hand. → Every photo is checked on arrival, with an actionable reason if it doesn't pass ("there's glare: tilt the phone"), and the certificate is issued on its own from validated evidence. |
| 3 | Escalamientos que nadie toma | Hoy el supervisor no ve el mensaje a tiempo y el instalador espera sin saber qué pasa. → Una escalera con tiempos: supervisor de turno, de respaldo y, si nadie responde, aviso al jefe de zona por email. | Today the supervisor doesn't see the message in time and the installer waits without knowing what's next. → A timed ladder: the on-duty supervisor, a backup, and — if no one answers — an email to the zone lead. |

Layout: tres tarjetas iguales en fila (desktop) / columna (mobile), cada una con un ícono lineal (no
fotográfico) y el patrón antes→después con una flecha; revelan con `IntersectionObserver` al 20% de
visibilidad, translateY(12px)→0 + opacity, 100ms de stagger entre tarjetas.

### 1.5 El recorrido del producto — el corazón (`#recorrido`)

Ver especificación completa en §1.6 (contenido de las escenas) y en el documento de motion (§3) para el
mecanismo de scroll. Título de sección: **es** "Así trabaja un instalador con Cuadrilla" / **en** "How an
installer works with Cuadrilla". Subtítulo (B1: nunca "instalación real" — todo lo que ve el visitante es
un mundo sintético): **es** "Seis momentos de una instalación, de principio a fin — mira cómo cambia la
pantalla en cada paso." / **en** "Six moments of one installation, start to finish — watch the screen
change at each step."

### 1.6 Las seis escenas

Historia base: Rogelio Méndez, órdenes 24817-24819 (`docs/design-brief.md` §4), la misma que usa el
recorrido guiado de la consola — así toda captura real que reemplace un render (§6) sale de un estado
del mundo que ya existe y no hay que inventar una segunda historia. Orden cronológico (N5): las seis
escenas siguen la hora del mundo, sin saltar hacia atrás — la OT 24817 abre y cierra el recorrido (S1-S4),
la OT 24818 es la escalación de un caso distinto (S5) y la OT 24819 es el diferencial de seguridad (S6),
la razón técnica más fuerte para un comprador de operaciones de campo y que hasta esta revisión solo
aparecía como garantía (§1.8) y como meta (§1.9), nunca mostrada en una escena.

Cada escena corrige, además del orden, tres detalles que la revisión comercial marcó como funciones que el
producto no tiene (B2): ninguna tool ni pantalla del producto dibuja un contorno sobre una foto, no hay
enlaces visuales dentro de un mensaje saliente (`CP-NO-FOREIGN-LINKS`) y la consola de Casos solo tiene los
botones "Tomar" y "cerrar" — "No puedo" es un botón de WhatsApp, no de la consola (`docs/tool-catalog.md`,
`docs/design-brief.md` §5 bridge).

| # | Escena | Qué se ve | Actor primario | Real/simulado |
|---|---|---|---|---|
| S1 | La conversación se escribe sola | 09:20, OT 24817. Un teléfono con el chat de Rogelio: escribe una nota de voz ("Ya estoy con la señora Treviño, la ONU no prende la luz PON" — la burbuja de voz se anima con una forma de onda, no texto), doble check gris → azul, "escribiendo…", y la respuesta llega citando el manual ("Manual v1, §DIAG-02"), como texto plano dentro de la burbuja — nunca un link ni un subrayado, porque el producto nunca manda enlaces salientes. Esa respuesta (`exampleAgentReply`) se auto-tipea carácter por carácter a velocidad de lectura (M2: ~35 ms/carácter, con techo de 4s por mensaje), nunca aparece de golpe. | Instalador | Real: WhatsApp (simulado en esta demo con el simulador de teléfono), Transcribe, AgentCore, Knowledge Base |
| S2 | La decisión que toma el sistema | ~09:35, OT 24817. Mismo teléfono. Pregunta de política ("¿la roseta en otro cuarto se cobra?"); la respuesta cita §COM-04 **como texto plano** dentro de la burbuja ("Manual v1, §COM-04") — nunca subrayado ni con apariencia de link, porque el producto real no manda enlaces; debajo, una cita de la misma pregunta *fuera* del manual ("¿le dejo la contraseña de administrador?") con la respuesta "No está en el manual, ¿lo consulto con tu supervisora?" — para mostrar que el sistema no inventa. | Instalador | Real: AgentCore, Knowledge Base, Guardrails |
| S3 | El chequeo de foto | ~09:40, OT 24817. Tres fotos en secuencia rápida: la del medidor (✅ al instante), la de la etiqueta con reflejo, la segunda foto de la etiqueta (✅). En el teléfono, el mensaje con la foto rechazada recibe la reacción de WhatsApp 🔁 (`VERDICT_REACTION`, `docs/design-brief.md` §5 paso 5, fila 79); a continuación, una burbuja de texto del agente con el motivo accionable — el texto exacto de `packages/bff/src/story/main-story.ts` (WP-61), que importa `copy/es-MX.ts` → `rejectReason('GLARE', 'ONU_LABEL_PHOTO')`: "Hay reflejo sobre la etiqueta de la ONU y no se lee el serial: inclina un poco el teléfono y apaga el flash." — nunca un contorno ni una región marcada sobre la imagen, porque la tool no informa coordenadas (`docs/design-brief.md` §5.10, `docs/tool-catalog.md`). Aparte, un inset rotulado **"Consola · Revisión de evidencia"** (`/app/evidence`) muestra la lectura compacta de la rúbrica con los campos reales de `quality` — enfoque ✓, reflejo ✗, encuadre ✓. | Instalador | Real: Bedrock (validación aislada, `record_verdict`), chequeos deterministas |
| S4 | El acta y el buzón de salida | 10:05, OT 24817 (cierre). En la consola, un inset **"Consola · Orden"** (`/app/orders/:workOrderId`) muestra el checklist completo (5/5 con marca verde), sin botón de cierre — cerrar una instalación no es una acción de la consola. En el teléfono, Rogelio toca **"Cerrar instalación"** (botón de WhatsApp, FL-047) y recibe el documento PDF; en paralelo, una vista compacta del buzón de salida muestra dos emails entregados (cliente, buzón de operaciones) con su evento "Delivered". | Instalador + sistema | Real: SES (al simulador de buzones de esta demo), generación de PDF |
| S5 | La escalación | OT 24818, un caso distinto que corre en paralelo. Cambia el marco al **teléfono de Adriana** (supervisora de turno): recibe exactamente el cuerpo de la plantilla de WhatsApp `caso_escalado` (`packages/bff/src/copy/templates.ts`) — "Tienes un caso nuevo de tu equipo: C-0412. El instalador Rogelio necesita apoyo en la orden 24818 por este motivo: potencia fuera de rango después de 3 pasos. ¿Puedes tomarlo ahora?" — como es `fixedCopy` (texto literal de la plantilla, no una respuesta redactada), aparece completa de una sola vez, sin el auto-tipeo de M2 — con los botones **[Tomar caso]** **[No puedo]**, y nada más: sin miniaturas ni badge de tiempo, porque `caso_escalado` es solo texto y botones y el resumen verificado con hasta 3 fotos llega recién en el `CASE_BRIEF`, después de tomar el caso. Si nadie lo toma en 10 minutos, una línea narrativa lo cuenta ("si nadie lo toma en 10 minutos, pasa al supervisor de respaldo"); si hace falta mostrarlo, un inset aparte rotulado **"Consola · Casos"** puede listar la escalera con "vencimiento pendiente 12:00" — nunca un contador regresivo sobre el teléfono. El escalón vence; el caso pasa a Héctor (`caso_reasignado`, mismo patrón de plantilla y botones); Héctor toca **[Tomar caso]** y su teléfono recibe, **por WhatsApp**, el `CASE_BRIEF` (resumen verificado, hasta 3 fotos, botón **[Cerrar caso]**) y escribe una instrucción; en el teléfono de Rogelio aparece "Héctor (supervisor): Cambia el conector de la roseta…", con el prefijo de nombre que identifica que ya no es el agente quien habla (el puente, `docs/design-brief.md` §5). | Supervisor + instalador | Real: WhatsApp (simulado), Cognito; determinista: escalera, puente |
| S6 | La seguridad | OT 24819, otro caso en paralelo. Rogelio escribe un mensaje con una palabra de riesgo físico; el clasificador de léxico determinista lo detecta antes del turno del agente y responde al instante con la instrucción fija de §SEG-01 (el mismo texto siempre, nunca redactado por el modelo) — como es `fixedCopy`, aparece completa de una sola vez, sin el auto-tipeo de M2 (eso es justamente lo que muestra que no la escribió el modelo). En paralelo, dos avisos con su hora: el teléfono de Adriana recibe la alerta de WhatsApp (también `fixedCopy`, plantilla `alerta_seguridad`, completa de una vez) y un compacto del buzón de salida muestra el email al jefe de zona — ambos entregados en menos de 60s desde el mensaje de Rogelio, el mismo número que promete la meta de §1.9. | Instalador + supervisor + jefe de zona | Determinista: clasificador de léxico, instrucción fija; real: SES |

Cada escena tiene, en la narrativa (columna angosta de texto que scrollea), 2-3 líneas fijas que no se
auto-tipean — el auto-tipeo es solo dentro del "dispositivo" simulado, nunca en el texto explicativo, para
no obligar a nadie a esperar para leer.

### 1.7 Qué hace, por actor (`#actores`)

Cuatro columnas (grid `md:grid-cols-2 lg:grid-cols-4`), una por actor pedido en el brief; cada una es una
lista corta de 3-4 funciones con verbo + objeto, sin explicar el "cómo" (eso ya lo mostró el recorrido):

| Actor | es-MX | en |
|---|---|---|
| Instalador | Pregunta por WhatsApp y recibe la respuesta del manual citada · Ve qué le falta para cerrar y por qué se rechazó una foto · Pide ayuda a su supervisor con un botón · Recibe su acta en el momento | Asks on WhatsApp and gets the manual's answer, cited · Sees what's missing to close and why a photo was rejected · Asks their supervisor for help with one button · Gets their certificate on the spot |
| Supervisor | Recibe solo lo que necesita a una persona, con el resumen y las fotos · Toma o pasa un caso con un botón · Responde al instalador sin salir de WhatsApp · Valida manualmente una foto dudosa desde la consola | Gets only what needs a person, with the summary and photos · Takes or passes a case with one button · Replies to the installer without leaving WhatsApp · Manually reviews a doubtful photo from the console |
| Jefe de zona | Se entera de un riesgo de seguridad en menos de un minuto · Recibe por email los casos que nadie tomó · No necesita WhatsApp: le llega por email | Hears about a safety risk in under a minute · Gets by email the cases no one took · Doesn't need WhatsApp: it reaches them by email |
| Operaciones | Ve cada instalación del día, con su checklist y su estado de red · Revisa la bitácora de decisiones y las reglas aplicadas · Exporta el acta y las métricas | Sees every job of the day, with its checklist and network status · Reviews the decision log and the rules applied · Exports the certificate and the metrics |

### 1.8 Confianza: reglas garantizadas en código (`#confianza`)

Título: **es** "Lo que Cuadrilla nunca hace" / **en** "What Cuadrilla never does" — se enmarca como
garantías, no como lista de features, porque en un producto que habla con clientes de un tercero la
confianza se vende mostrando los límites. Seis tarjetas con ícono de candado/regla:

| Garantía | es-MX | en |
|---|---|---|
| Cita siempre su fuente | Toda respuesta de política o procedimiento cita la sección del manual; si el manual no lo cubre, lo dice y ofrece escalar — nunca inventa una política. | Every policy or procedure answer cites the manual's section; if the manual doesn't cover it, it says so and offers to escalate — it never makes up a policy. |
| La instrucción de seguridad no la escribe un modelo | Ante un riesgo físico, el texto de seguridad es el mismo, fijo, del manual — no lo redacta el agente. | Facing a physical risk, the safety text is the same fixed text from the manual — the agent never drafts it. |
| Una foto dudosa la decide una persona | El chequeo de evidencia asiste y puede aceptar una foto por su cuenta; validar manualmente una foto dudosa es siempre decisión de una persona, con su propio usuario. | Evidence review assists and can accept a photo on its own; manually approving a doubtful photo is always a person's decision, under their own login. |
| Nunca cobra ni promete | El agente no cambia precios, no ofrece descuentos ni compensaciones — esas preguntas se escalan. | The agent never changes prices or offers discounts or compensation — those questions get escalated. |
| Cada decisión queda registrada | Toda regla que se aplicó, todo mensaje que salió y por qué, quedan en una bitácora auditable. | Every rule applied, every message sent and why, is kept in an auditable log. |
| Solo habla con quien corresponde | Un mensaje sale solo a quien tiene el consentimiento vigente y el rol correcto — nunca a un número o una persona fuera de la política. | A message goes out only to someone with active consent and the right role — never to a number or a person outside policy. |

### 1.9 Impacto (`#impacto`)

Regla dura: **toda cifra de esta sección lleva su rótulo visible** ("meta" / "supuesto") junto al número,
nunca solo en una nota al pie — el rótulo se pinta en el mismo tamaño de fuente que la cifra, no en gris
chico, porque es información y no un descargo legal. Ningún número de esta sección se presenta como
medido en producción (eso solo existiría después de un piloto real, que no es esta demo). **Ninguna cifra
de esta sección es un placeholder literal** (B3): las cuatro metas llevan su **fuente y su N** en una
leyenda chica bajo el número, igual que la pestaña de métricas de la consola ("se mide sobre las 40 preguntas
del set del manual", "se mide sobre 60 fotos etiquetadas"), y la fila de piloto (antes "−X% revisitas · −Y min", un texto
que se vería literal en pantalla) se reemplaza por una frase sin cifra, del mismo tamaño de letra que las
demás cifras — nunca en gris chico de descargo — para que se lea como información y no como una promesa
inventada.

| Cifra | Rótulo | es-MX | en |
|---|---|---|---|
| ≥ 70% | meta — fuente es "se mide sobre las 40 preguntas del set del manual" / en "measured on the manual's 40-question set" | de las preguntas del instalador, resueltas sin escalar y con la sección correcta citada | of installer questions resolved without escalating, with the right section cited |
| &lt; 30 s | meta — fuente es "objetivo p95 del turno de texto" / en "p95 target for a text turn" | tiempo hasta la primera respuesta del agente (texto) | time to the agent's first reply (text) |
| ≥ 90% | meta — fuente es "se mide sobre 60 fotos etiquetadas" / en "measured on 60 labeled photos" | exactitud del chequeo de fotos de evidencia contra un set etiquetado | accuracy of the evidence-photo check against a labeled set |
| &lt; 60 s | meta — fuente es "objetivo de la alerta de seguridad" / en "safety-alert target" | desde un riesgo reportado hasta el aviso al jefe de zona | from a reported hazard to the zone lead's alert |
| Sin cifra | supuesto | En un piloto mediríamos revisitas a 30 días y minutos por instalación contra tu línea de base. | In a pilot we would measure 30-day repeat visits and minutes per installation against your baseline. |

Los contadores animan de 0 al valor final cuando la sección entra en viewport (`IntersectionObserver`,
una sola vez, `once: true` para que no se repita si el visitante vuelve a scrollear) — **excepto los dos
topes de latencia** (`< 30 s`, `< 60 s`): un objetivo de "menos que" no se cuenta hacia arriba desde 0 (se
leería como si el sistema empeorara con el tiempo), así que se pintan estáticos en su valor final o, si se
prefiere motion, con una cuenta regresiva desde un valor arbitrario mayor hasta el objetivo. Los dos
porcentajes de exactitud (`≥ 70%`, `≥ 90%`) sí cuentan hacia arriba, porque un "más que" que sube tiene
sentido. Con `prefers-reduced-motion`, todo número aparece directamente en su valor final, sin conteo ni
cuenta regresiva. La fila de piloto no anima: no tiene cifra que contar (fila M6 de §3, antes M7).

### 1.10 Cómo se integra (`#integracion`)

Un diagrama simple (no el de arquitectura completo de `docs/architecture.md`, que es interno) con cinco
bloques y flechas, más una tabla de apoyo para quien lee en vez de mirar el diagrama:

```
Instalador (WhatsApp) → Cuadrilla (agente) → Manual de la operadora (base de conocimiento)
                                ↕
                    Orquestador de red · Sistema de despacho     (conectores del lado de la operadora)
                                ↓
                    Supervisor (WhatsApp) · Jefe de zona (email) · Consola
```

| Bloque | es-MX | en |
|---|---|---|
| Canal | WhatsApp, sobre AWS End User Messaging Social — el mismo canal que ya usa el instalador, sin una app nueva que instalar; en esta demo, con un simulador de teléfono. | WhatsApp, over AWS End User Messaging Social — the same channel the installer already uses, no new app to install; in this demo, with a phone simulator. |
| Agente | Un agente sobre Amazon Bedrock AgentCore que decide qué hacer con cada mensaje, siempre con las herramientas y los datos de la orden en curso — nunca a ciegas. | An agent on Amazon Bedrock AgentCore that decides what to do with each message, always with the tools and the data of the job at hand — never blind. |
| Conocimiento | El manual de procedimientos de la operadora, en una base de conocimiento propia: el agente responde solo desde ahí y cita la sección. | The operator's own procedures manual, in a dedicated knowledge base: the agent answers only from there and cites the section. |
| Conectores de la operadora | Dos integraciones del lado de la operadora: el estado del equipo de red (para saber si la conexión quedó en línea) y el sistema de asignación de órdenes (para saber la agenda del día). En esta demo, ambos están simulados con datos sintéticos — el contrato de integración es real. | Two integrations on the operator's side: the network equipment status (to know whether the connection came online) and the work-order dispatch system (to know the day's schedule). In this demo both are simulated with synthetic data — the integration contract is real. |
| Notificación por email | Amazon SES entrega el acta al cliente y a operaciones, y avisa al jefe de zona ante un riesgo. | Amazon SES delivers the certificate to the customer and to operations, and alerts the zone lead on a hazard. |
| Infraestructura | Todo serverless sobre AWS: sin servidores que mantener, sin capacidad que reservar de antemano. | Fully serverless on AWS: no servers to maintain, no capacity to provision ahead of time. |
| Seguridad | Cada operadora ve solo sus propios datos; el acceso a la consola es con su propio usuario. | Each operator sees only its own data; console access is under each person's own login. |

**Qué necesita tu operación (N7)**: debajo de la tabla, una lista corta y sin fechas ni precios (eso lo
resuelve "Hablemos"), tomada de `docs/architecture-integrations.md`, para que quien evalúa un piloto sepa
qué le van a pedir:

| es-MX | en |
|---|---|
| Qué necesita tu operación: tu manual de procedimientos, acceso de lectura al estado de la ONU y a las órdenes del día, una cuenta de WhatsApp Business conectada por AWS End User Messaging Social, y un buzón para las actas. | What your operation needs: your procedures manual, read access to ONU status and the day's work orders, a WhatsApp Business account connected through AWS End User Messaging Social, and a mailbox for the certificates. |

### 1.11 Qué es simulado en esta demo (`#real`)

**Reescrita completa (B1, compliance-B6)**: la tabla anterior decía "el envío de emails y de WhatsApp"
como real, lo que sugiere a un prospecto que su mundo manda WhatsApp de verdad. Es falso para todo mundo de
invitado: el transporte vivo de WhatsApp solo existe para el mundo único del operador, después de cerrar
P-01 (ADR-0002 §5); el WhatsApp que ve un invitado, siempre, es el simulador de teléfono. La propia §1.6 S1
ya lo decía bien ("simulado en esta demo") — esta sección contradecía esa fila. Se reemplaza por las
**cuatro columnas de `docs/design-brief.md` §7.2**, la fuente de verdad de qué es real:

| Columna | es-MX | en |
|---|---|---|
| Real en `poc` | Todo servicio de nube que hace el trabajo: el agente (Bedrock AgentCore), el chequeo de fotos, la transcripción de voz, el envío de emails, el almacenamiento y el inicio de sesión. | Every cloud service doing the work: the agent (Bedrock AgentCore), the photo check, voice transcription, email delivery, storage and sign-in. |
| Implementado, en modo simulado | El adaptador de WhatsApp sobre AWS End User Messaging Social: está construido y probado; en tu demo lo usas con un simulador de teléfono, y pasa a estar en vivo una vez que la cuenta de WhatsApp Business quede conectada. | The WhatsApp adapter over AWS End User Messaging Social: it's built and tested; in your demo you use it with a phone simulator, and it goes live once the WhatsApp Business account is connected. |
| Mocks propios | El despacho de órdenes, el orquestador de red (ONU), el personal, los clientes y los teléfonos. | Work-order dispatch, the network orchestrator (ONU), staff, customers and phones. |
| Datos | 100% sintéticos: toda persona, dirección, orden de trabajo y manual de esta demo es inventado. Nadie tuyo va a aparecer en ninguna captura. | 100% synthetic: every person, address, work order and manual in this demo is made up. Nothing of yours appears in any screenshot. |

Fila añadida sobre el envío de emails (B1, para que la línea "real" no se lea como "manda emails a
cualquiera"): **es** "SES manda emails de verdad, dirigidos a un buzón de prueba que ves en el buzón de
salida." / **en** "SES sends real emails, addressed to a test mailbox that you see in the outbox."

Fila "Tu prueba" (sin cambios de fondo, sigue describiendo el mundo aislado): **es** "Al probar la demo
entras a tu propio mundo aislado, con datos sintéticos que nadie más ve ni toca." / **en** "Trying the demo
puts you in your own isolated world, with synthetic data no one else sees or touches."

**Honestidad sobre qué se habilita cuándo (compliance-B6)**: desde que se despliega la ola 2b.2 hasta que
las olas 3-5 completen la consola (simulador, agente, reloj, casos, métricas), un alta nueva solo ve la
portada del invitado (`/app/home`, §7.6) — el recorrido de esta sección muestra el producto completo, con
sus componentes y textos reales, pero no es una sesión en vivo mientras eso pasa. Una línea corta cerca del
CTA y de esta sección lo dice sin tecnicismos: **es** "Algunas partes de la consola se habilitan por
etapas; tu mundo te muestra cuáles ya puedes usar." / **en** "Some parts of the console roll out in
stages; your world shows you which ones you can already use." Se calcula igual que la portada del
invitado, con el mismo registro de vistas (`lib/view-registry.ts`, §1.12) o con una bandera de build, y se
retira cuando WP-44 cierra la consola completa. Además, §6 aclara que los renders ilustran el producto con
sus componentes reales y no son una sesión en vivo (§6.1).

Nota de marca (`BrandMark`, ya construida, sin cambios de lógica): en modo neutral no hay aviso extra
(la tabla de arriba ya lo dice); en modo `cobrand` se agrega, debajo de esta sección y también en el
footer, el aviso fijo de ADR-0018 ("Demo sintética: el manual, las políticas y los datos son inventados y
no son las políticas reales de &lt;socio&gt;" / su versión en inglés), resuelto en runtime y nunca escrito
en este documento con un nombre real.

### 1.12 CTA final y footer (`#empezar`, `#footer`)

CTA final: mismo bloque de tres accesos que el hero (§1.3, con el mismo `?lang=` persistente), repetido
porque quien llegó hasta acá ya vio todo el recorrido y es el momento de conversión; título: **es** "¿Lo
probamos?" / **en** "Ready to try it?"; bajada (B10, sin prometer un minuto; B5, tuteo): **es** "Crea tu
cuenta y entra a tu propio mundo de prueba en unos minutos." / **en** "Create your account and step into
your own test world in a few minutes."

**"Qué puedes hacer hoy en tu demo" (B10)**: franja junto al CTA final, calculada con el mismo registro de
vistas que usa la portada del invitado (`lib/view-registry.ts`, mismo bundle de la SPA — `VIEWS.names`), no
con una fecha fija. Antes de que la consola esté completa, lista solo lo que ya existe (portada, mundo,
alta); cuando el registro tiene las vistas del simulador, la consola y el reloj, dice: **es** "Serás
Rogelio en un simulador de teléfono, Adriana en la consola y controlas el reloj del mundo; recorrido
exprés de 5 minutos." / **en** "You'll be Rogelio on a phone simulator, Adriana on the console, and you
control the world's clock; a 5-minute express tour." Deja de mostrarse en cuanto WP-44 reemplaza los
renders por capturas reales.

Footer (extiende el ya construido, mismo layout): wordmark de Cuadrilla, `PoweredByCraftech`, nav con
Privacidad / Términos, y se agrega un tercer link **Hablemos** → `https://craftech.io/contact/`. Cero
menciones al concurso en ningún idioma.

---

## 2. Identidad visual

### 2.1 Decisión de paleta (justificación) — reescrita (B7)

La versión anterior de esta sección decía "no se reemplaza esta paleta" y dejaba los mismos valores hex
que la landing de referencia interna (solo lectura): navy `#0b1f3a`, navy-deep `#071429`,
cyan `#12b5d9` y el resto de los semánticos, más Inter y el mismo patrón de marco de teléfono con escenas
sticky. Es la misma paleta, con los mismos números, del producto que la decisión del CTO pide no copiar
("no es una copia: estilo propio y moderno", "cada POC tiene su propia identidad visual", skill
`poc-landing` §2). Se corrige así:

- **Los nombres de token no cambian** (`navy`/`navy-deep`/`navy-soft`, `cyan`/`cyan-deep`/`cyan-soft`,
  `ink`/`slate`/`mist`/`paper`/`white`, `success`/`warning`/`danger`/`info` + sus `-soft`, `craftech`):
  la consola, el login y la landing siguen siendo **un solo sistema** de clases (`bg-navy`, `text-cyan`…),
  y los valores hex siguen viviendo solo en `index.css`, nunca en JSX.
- **Lo que cambia son los valores hex** bajo esos mismos nombres, a una paleta derivada del dominio FTTH en
  vez de un gradiente navy/cyan genérico de SaaS: una base oscura "asfalto/grafito" (en vez de un navy de
  producto de software), un amarillo de **cordón de parcheo monomodo** como acento de marca (en vez de un
  cyan genérico) y un verde de **conector APC** como segundo acento, para las citas al manual y las notas
  de sistema. `success`/`warning`/`danger` se retunean para no colisionar con los dos acentos nuevos y para
  corregir el contraste que N4 (§5.1) encontró roto en la paleta anterior.
- Se retoca el mismo PR de WP-55 que ya toca `index.css` (§0): re-skinea a la vez la landing, el login y la
  consola, porque son un solo sistema de tokens — nunca dos paletas que un prospecto note distintas entre
  "la página que convence" y "el producto que después usa".
- El motivo visual recurrente tampoco es el genérico de la referencia (malla de gradiente + marco de
  teléfono suelto): es un **motivo propio del dominio** (§2.4) — una hebra de fibra que baja por la página
  del OLT al ONU, con un pulso de luz marcando la escena activa, y puntos de estado tipo luz PON (apagado,
  parpadeando, fijo) como marcadores de sección. El marco de teléfono se conserva porque es el producto
  real (WhatsApp), no un elemento decorativo — lo decorativo es la hebra y los puntos PON.

Valores nuevos, con su AA verificado (§5.1 trae la tabla completa de pares texto/fondo):

```css
@theme {
  /* Base "asfalto/grafito": ya no el navy azulado genérico, un gris-carbón de infraestructura de calle. */
  --color-navy: #1b1f24;
  --color-navy-deep: #0a0c0f;
  --color-navy-soft: #2c323a;

  /* Acento de marca: amarillo de cordón de parcheo monomodo (el color real del cable en un rack FTTH). */
  --color-cyan: #f4c430;
  --color-cyan-deep: #8a6400;  /* texto/links/foco sobre fondo claro, §5.1 */
  --color-cyan-soft: #fbf0cf;

  /* Segundo acento: verde de conector APC — citas al manual, notas de sistema (antes "info" azul). */
  --color-info: #146b5c;
  --color-info-soft: #dcefe9;

  /* Retuneados para AA (§5.1) y para no competir con los dos acentos nuevos. */
  --color-success: #167a49;
  --color-success-soft: #dff5ea;
  --color-warning: #9a5b00;
  --color-warning-soft: #fdecd2;
  --color-danger: #c62839;
  --color-danger-soft: #fbe1e6;

  --color-ink: #12161b;
  --color-slate: #57626e;
  --color-mist: #dfe3e8;
  --color-paper: #f4f5f7;
  --color-white: #ffffff;

  /* Craftech's navy, para el wordmark de "Powered by Craftech": es la marca de Craftech, no la de
     Cuadrilla, y no cambia con este re-skin. */
  --color-craftech: #122d45;
}
```

Tokens **nuevos** (tipografía, elevación, radios y el motivo de fibra), agregados al mismo `@theme`:

```css
@theme {
  /* … tokens existentes, sin cambios en su nombre … */

  /* Tipografía de despliegue (display), propia de Cuadrilla — §2.3. Self-hosted, no Google Fonts. */
  --font-display: "Space Grotesk Variable", "Space Grotesk", ui-sans-serif, system-ui, sans-serif;

  /* Landing: tipografía fluida (clamp), evita clases arbitrarias en JSX (CLAUDE.md: preferir
     canónicas). Escala en rem, con un mínimo legible en 360px y un techo en 1440px+. */
  --text-hero: clamp(2rem, 1.3rem + 3vw, 3.75rem);      /* h1 del hero */
  --text-h2: clamp(1.5rem, 1.25rem + 1.1vw, 2.25rem);   /* títulos de sección */
  --text-lead: clamp(1rem, 0.93rem + 0.3vw, 1.125rem);  /* bajadas */

  /* Landing: elevación del panel "pegado" del recorrido (§4.1), distinta de --shadow-card en reposo. */
  --shadow-float: 0 12px 32px rgb(10 12 15 / 0.24), 0 2px 8px rgb(10 12 15 / 0.12);

  /* Landing: radio de las burbujas de chat del marco de teléfono (§2.4), más redondo que --radius-card. */
  --radius-bubble: 1.125rem;

  /* Motivo de fibra (§2.4, fila M10 de §3): el pulso de luz que marca la escena activa sobre la hebra
     vertical. Finito (WCAG 2.2.2, N7): 2 iteraciones de 2.4s (≤4.8s), después descansa en opacidad
     plena — nunca `infinite`. Se retriggerea (se reinicia la animación) cada vez que cambia el marcador
     activo, no corre en loop mientras una escena permanece activa. */
  --animate-fiber-pulse: fiber-pulse 2.4s ease-in-out 2 forwards;

  @keyframes fiber-pulse {
    0% {
      opacity: 0.35;
      transform: translateY(0);
    }
    50% {
      opacity: 1;
      transform: translateY(6px);
    }
    100% {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
```

Uso en JSX: `text-hero`, `text-h2`, `text-lead`, `font-display`, `shadow-[var(--shadow-float)]` está
prohibido por la regla de "sin arbitrarias" del proyecto — en su lugar se declara una utilidad canónica
adicional en el mismo `@theme` (`--shadow-float` ya sigue la convención de `--shadow-card`, que Tailwind v4
expone como `shadow-card`; análogamente `shadow-float`) y `rounded-bubble` para `--radius-bubble`.

### 2.2 Paleta con roles (nombres de token ya existentes; valores hex re-tuneados en §2.1)

| Token | Rol en la landing |
|---|---|
| `navy` / `navy-deep` / `navy-soft` | Fondo del hero, del panel de marca del login/signup, del footer, de la hebra de fibra; texto sobre fondo claro para títulos |
| `cyan` / `cyan-deep` / `cyan-soft` | Acento de marca (amarillo de cordón monomodo): CTA primario, foco de teclado sobre fondo oscuro, el pulso de la hebra activa. **`cyan-deep`, nunca `cyan`, para texto, links y el foco de teclado sobre fondo claro** (§5.1: `cyan` puro no llega a AA sobre blanco) |
| `ink` / `slate` | Texto de cuerpo sobre fondo claro |
| `mist` / `paper` / `white` | Bordes, fondos de tarjeta, alternancia de secciones (uso decorativo, nunca como texto ni foco: §5.1) |
| `success` / `success-soft` | ✅ de foto validada (S3), ítems `PASSED` del checklist (S4) |
| `danger` / `danger-soft` | 🔁 de foto rechazada (S3) — nunca un contorno sobre la imagen (B2, §1.6) |
| `warning` / `warning-soft` | Chip de vencimiento pendiente en el inset "Consola · Casos" (S5), nunca un badge sobre el teléfono |
| `info` / `info-soft` | Acento de marca secundario (verde de conector APC): cita al manual como texto plano (S1, S2), notas de sistema, puntos de estado tipo luz PON de la hebra (§2.4) |
| `craftech` | Wordmark de "Powered by Craftech" cuando falta el logo (ya así en `Brand.tsx`); es la marca de Craftech, no cambia |

### 2.3 Tipografía

Dos familias, ninguna Google Fonts (B7: la nota de que "Inter ya está cargada por la consola" era falsa —
ni `index.html` ni el CSS cargaban ninguna fuente, así que hoy todo renderiza en la fuente del sistema):

- **Cuerpo, `--font-sans`**: Inter, self-hosted igual que la fuente de despliegue de abajo (no Google
  Fonts: sin una petición a un dominio de terceros en el critical path). Si al implementar se prefiere
  ahorrar el peso y usar la fuente del sistema para el cuerpo (`ui-sans-serif, system-ui…`), es una
  decisión válida de `typescript-dev` en WP-55 dentro del presupuesto de §5.2 — esta spec no lo exige.
- **Despliegue, `--font-display` (nuevo, identidad propia de Cuadrilla)**: **Space Grotesk** — una
  geométrica de trazo técnico, distinta de la humanista de la referencia interna y del Inter del cuerpo,
  para H1, H2 y el eyebrow. Self-hosted vía el paquete versionado `@fontsource-variable/space-grotesk`
  (declarado por `typescript-dev` en WP-55 con su versión exacta), subconjunto Latin en woff2,
  `font-display: swap` y un `<link rel="preload">` del único peso variable que usa el hero (evita el salto
  de layout del H1, que es el elemento más grande del *above the fold*). Presupuesto en §5.2.

Escala fluida con `clamp()` (§2.1) en vez de saltos fijos por breakpoint, para que el hero no se sienta
"a medio camino" en anchos intermedios (iPad en vertical, ventanas de laptop chicas):

| Uso | Clase | Familia | Peso | Line-height |
|---|---|---|---|---|
| H1 (hero) | `text-hero font-display font-semibold` | `--font-display` | 600 | 1.05 |
| H2 (título de sección) | `text-h2 font-display font-semibold` | `--font-display` | 600 | 1.15 |
| H3 (tarjeta) | `text-lg font-semibold` | `--font-sans` | 600 | 1.3 |
| Eyebrow / label | `text-xs font-display font-semibold uppercase tracking-widest` | `--font-display` | 600 | 1.4 |
| Bajada / lead | `text-lead` | `--font-sans` | 400 | 1.6 |
| Cuerpo | `text-sm` / `text-base` | `--font-sans` | 400 | 1.6 |

### 2.4 Espaciado, radios, elevación, iconografía

- **Espaciado**: escala estándar de Tailwind (4px base); secciones con `py-16 lg:py-24` (ya el patrón
  del hero actual), tarjetas con `p-5`/`p-6`. Sin valores arbitrarios.
- **Radios**: `rounded-card` (0.75rem, ya existente) para tarjetas y paneles; `rounded-bubble` (nuevo,
  1.125rem) solo para las burbujas de chat del marco de teléfono, porque una burbuja de mensaje real de
  WhatsApp es más redonda que una tarjeta de UI; `rounded-full` para pills y badges de tiempo.
- **Elevación**: `shadow-card` (ya existente) en reposo; `shadow-float` (nuevo) en el panel pegado del
  recorrido (§4.1) y en el marco de teléfono cuando está "activo" (scroll-linked), para separarlo
  visualmente del fondo mientras es el foco de atención.
- **Iconografía**: set lineal de un solo trazo (2px), sin relleno, estilo consistente con los `Badge`/
  `Callout` ya existentes en la consola (no se introduce una librería de íconos nueva sin declarar
  versión: si hace falta, `lucide-react`, ya común en el ecosistema React 19 + Tailwind v4, versión
  fijada por `typescript-dev` en la ola de build). Los íconos de §1.4 (dolores) y §1.8 (garantías) son
  lineales; los verdes/rojos de evidencia (✅/🔁) son los emoji reales que ya usa el producto — no se
  reinventan como íconos custom, porque son parte de la experiencia real de WhatsApp que la landing
  muestra.
- **Estilo de ilustración**: nada de fotografía de stock de "instaladores genéricos" (rompería la
  narrativa de "todo lo que ves es el producto real, no una promesa"). Todo elemento visual es o (a) un
  marco de teléfono con la conversación real, o (b) un recorte de la consola real, o (c) un diagrama
  lineal simple (§1.10).
- **Motivo de fibra (B7, nuevo — reemplaza la malla de gradiente genérica de la referencia interna)**: una
  hebra vertical (un SVG lineal de 2-3px, color `navy-soft` en reposo) corre por el borde de la columna
  narrativa del recorrido (§4.1) y por el eje del hero en mobile, desde un ícono de OLT arriba hasta un
  ícono de ONU abajo — la topología real que describe §1.10. Sobre la hebra, un pulso de luz (`--animate-
  fiber-pulse`, solo `transform`/`opacity`, ya declarado en §2.1, fila **M10** de §3) corre **2 iteraciones
  (≤4.8s)** cada vez que el visitante cruza al siguiente marcador de escena, y después descansa en opacidad
  plena sobre el marcador activo — nunca en loop indefinido mientras la escena sigue activa (WCAG 2.2.2,
  N7); con `prefers-reduced-motion` el pulso nace directo en opacidad plena sobre la escena activa, sin
  correr. Los marcadores de cada sección (header, cada escena del recorrido, la galería) son **puntos de
  estado tipo luz PON** (apagado `mist`, parpadeando `cyan`, fijo `info`) — un motivo tomado directo del
  equipo de red que el producto opera, no un punto genérico de progreso: cada punto **parpadea como máximo
  5s** al entrar en el viewport (fila **M11** de §3) y después queda **fijo** en `info`, nunca parpadeando
  de forma indefinida; con `prefers-reduced-motion` nace directo `fijo`, sin parpadeo. Es el único elemento
  "decorativo puro" de la página; nunca reemplaza al marco de teléfono ni al recorte de consola, que
  siguen siendo el producto real.

### 2.5 Tema

Solo **claro** para la landing pública y el signup/login (igual que la consola hoy: `color-scheme: light`
declarado en `index.css`). No se justifica un tema oscuro completo para esta ola: el hero y el panel de
marca ya usan navy oscuro como bloque, que cubre el efecto "moderno" sin duplicar cada componente en dos
temas. Si más adelante se pide dark mode de sitio completo, es un ADR propio (cambia `color-scheme` y
duplica tokens bajo `@media (prefers-color-scheme: dark)`), fuera de esta spec.

---

## 3. Motion

Regla general: solo `transform` y `opacity` (60 fps, sin repintado de layout); disparadores por
`IntersectionObserver` para reveals y por posición de scroll (`scrollY` normalizado dentro de un
contenedor alto, sin una librería de scroll-driven-animations nueva — ver §4.1) para el recorrido.
Ninguna animación bloquea la lectura: todo el contenido final es accesible sin esperar a que termine.

| # | Animación | Disparador | Duración / easing | Con `prefers-reduced-motion` |
|---|---|---|---|---|
| M0 | Loop del hero (`hero-loop`, B6 — antes sin fila propia) | Autoplay al entrar en viewport (`IntersectionObserver`) | 14-18s por vuelta; se detiene sola a las **2 vueltas** y descansa en el cuadro final, dentro del marco de teléfono y solo con lo que el simulador de teléfono muestra (`docs/design-brief.md` §6): la nota de voz (forma de onda y duración, ✓✓ leído — **sin transcripción**: en WhatsApp quien envía una nota de voz nunca ve su texto, y las transcripciones viven solo en la línea de tiempo de `/app/orders/:workOrderId`), la respuesta citada como texto plano, la foto rechazada con 🔁 y la siguiente con ✅, el PDF recibido — todo visible a la vez, no solo el cuadro más vistoso (R4-B1, ADR-0023 §6); un control visible **"Pausar animación" / "Pause animation"** de ≥44px alterna pausa/play; se pausa además con `:hover`, con `:focus` dentro del loop, al salir del viewport (mismo `IntersectionObserver`) y en `visibilitychange` (pestaña oculta) — cumple WCAG 2.2.2 (contenido en movimiento &gt;5s junto a otro contenido necesita pausa) | Sin loop: un póster estático del cuadro final (mismo que el descanso tras 2 vueltas), con un `<span class="sr-only">` que resume los **cinco** momentos del loop (voz → respuesta citada → foto rechazada → ✅ → PDF) en una frase; ahí, y solo ahí, puede decir qué dice la nota de voz ("la ONU no prende la luz PON"), como texto alternativo del audio, nunca como texto visible en el teléfono |
| M1 | Reveal de sección (título + tarjetas) | `IntersectionObserver`, 20% visible, `once: true` | `opacity 0→1` + `translateY(12px→0)`, 400ms `ease-out`, stagger 80-120ms entre hijos | Sin transición: aparece en su posición final, opacity 1, sin delay |
| M2 | Auto-tipeo del chat — solo mensajes `exampleAgentReply` y texto de la historia escrito por una persona (S1, S2, y la instrucción de Héctor en S5); nunca un mensaje `fixedCopy` (plantillas `caso_escalado`/`caso_reasignado` de S5, instrucción `safetyInstruction` de §SEG-01 en S6), que siempre aparece completo de una sola vez — así se ve que el modelo no lo redacta | Escena activa del recorrido (§4.1) | `ms/carácter = min(35, 4000 / longitud)` (techo de 4s por mensaje, WCAG 2.2.2 — §9.1), cursor parpadeante `opacity` 0/1 cada 500ms mientras tipea, se detiene al terminar | El mensaje aparece completo de una vez, sin cursor parpadeante ni demora — nunca se oculta contenido esperando la animación |
| M3 | Nota de voz (forma de onda) | Con S1, al empezar la reproducción simulada de la nota de voz | Corre **una vez**, la duración real de la nota (≤4s) — barras con `transform: scaleY()` entre 0.3 y 1, offsets escalonados por barra (look de audio real) — y descansa fija en su estado final; nunca en loop mientras la escena sigue activa | Forma de onda estática en su estado "medio" (barras a 0.6 de escala), sin animar |
| M4 | Reacción ✅ / 🔁 sobre la burbuja de la foto (S3) | Con la escena S3, tras un delay fijo simulando "procesando" (~600ms) | `opacity 0→1` + `scale(0.6→1)`, 250ms `ease-out` con leve *overshoot* (`cubic-bezier(0.34,1.56,0.64,1)`) | Aparece directo en `scale(1)`, `opacity 1`, sin overshoot |
| M5 | Cambio de escena del recorrido (marco de teléfono ↔ vista de consola, y el pulso de la hebra de fibra sobre el marcador activo, §2.4) | Progreso de scroll cruza el umbral de la escena (§4.1) | Cruce con `opacity` (`crossfade` 220ms) + el saliente se desplaza `translateX(-16px)` y el entrante desde `translateX(16px)`, mismo tiempo; el pulso de la hebra se desplaza al marcador de la escena nueva | Cambia sin desplazamiento ni crossfade: la escena nueva reemplaza a la anterior en un solo frame; el marcador de la hebra salta directo, sin desplazarse (equivalente a `transition: none`) |
| M6 | Contador animado (§1.9) | `IntersectionObserver`, `once: true` | `requestAnimationFrame` interpolando el número, 900ms `ease-out`, sin reflow (solo se actualiza `textContent`, no se anima con `transform`); los dos topes "menos que" (`< 30s`, `< 60s`) no cuentan hacia arriba (§1.9) | El número se pinta directo en su valor final |
| M7 | Indicador de progreso de la escena activa (barra fina bajo el marco de teléfono) | Progreso de scroll dentro de la escena activa — el mismo cálculo de fracción 0-1 de §4.1, en **desktop únicamente** | `transform: scaleX()` interpolado en directo de la fracción de scroll (0→1); ligada al scroll del visitante, sin `keyframe` ni temporizador propio — no es una animación autónoma, así que no cuenta para el chequeo de WCAG 2.2.2 (§9.1) ni depende de una duración fija (nunca reutiliza el `--animate-scene-progress`/`scene-progress` de 9s de `index.css`, pensado para otro uso) | Barra oculta — el visitante avanza a mano (scroll) |
| M8 | Hover/tap de botones y tarjetas | `:hover` / `:active` | `background-color` + `transform: scale(0.98)` en `:active`, 150ms | Sin cambio: no depende de motion, es feedback de estado, se conserva igual |
| M9 | Header que se comprime al hacer scroll | `scroll` (con throttle a `requestAnimationFrame`, no un listener por frame sin control) | `padding` interpolado vía clase (`py-3`↔`py-2`), 200ms | Igual, es un cambio de tamaño sutil, no motion que dependa de vestibular; se mantiene |
| M10 | Pulso de la hebra de fibra (`--animate-fiber-pulse`, §2.4, nuevo — WCAG 2.2.2) | El visitante cruza al siguiente marcador de escena (mismo cálculo de escena activa de §4.1) | 2 iteraciones de 2.4s (≤4.8s total), después descansa en `opacity: 1` sobre el marcador activo — nunca `infinite` | Nace directo en `opacity: 1` sobre el marcador activo, sin iterar |
| M11 | Parpadeo de punto de estado tipo luz PON (§2.4, nuevo — WCAG 2.2.2) | `IntersectionObserver`, al entrar la sección en el viewport | Parpadea como máximo 5s, después queda `fijo` en `info` — nunca parpadea de forma indefinida | Nace directo `fijo` en `info`, sin parpadeo |

**B2/B6, qué se quitó de esta tabla**: la fila anterior "M5, contorno de reflejo sobre la foto rechazada"
desaparece por completo — ninguna tool del producto dibuja una región sobre una foto (§1.6 S3); no queda
reemplazada por otra animación, la reacción de M4 y el mensaje de texto con el motivo (§1.6 S3) bastan. En mobile, M7 ya no tiene
"autoplay opcional" (B6: el indicador de progreso solo corre en desktop, ligado al scroll; en mobile el
avance es siempre manual).

Ninguna animación de esta tabla depende de una librería nueva: `IntersectionObserver` y `transform`/
`opacity` con CSS o `requestAnimationFrame` alcanzan para las doce (M0-M11). Si en la implementación
conviene una librería (por ejemplo para el auto-tipeo o el manejo de listas de reveals), debe ser una
versión estable y declarada por `typescript-dev` en la ola de build (regla del repo, `docs/design-
brief.md` intro): no la fija esta spec.

---

## 4. El recorrido: mecanismo responsive

### 4.1 Desktop (≥1024px): sticky + scroll-driven

Contenedor de la sección `#recorrido` con altura = `6 escenas × 100vh` (o el alto necesario para que cada
escena tenga espacio de lectura cómodo, ~140vh por escena en vez de 100vh exactos, para no obligar a un
scroll milimétricamente calibrado). Layout de dos columnas dentro de ese contenedor:

- **Columna izquierda (narrativa, ~40%)**: no es sticky; scrollea normal. Cada escena es un bloque con
  su número ("1/6"), su título corto y sus 2-3 líneas fijas (§1.6). Al entrar en el tercio central del
  viewport, ese bloque se resalta (texto pasa de `text-slate` a `text-ink`, con una barra vertical
  `bg-cyan` a la izquierda que aparece con M1); los demás quedan atenuados (`opacity-60`).
- **Columna derecha (visual, ~60%)**: `position: sticky; top: <alto del header>` mientras el contenedor
  padre está en viewport. Adentro, el marco de teléfono (S1, S2, S5, S6) o el recorte de consola (ninguna
  escena base necesita uno tras B2/N5, salvo la galería de §6) correspondiente a la escena activa, con la
  transición M5 al cambiar. Debajo del marco, la barra de progreso M7 y el contador "2/6".

La escena "activa" se calcula por la posición de scroll del contenedor respecto del viewport (fracción
0-1 dividida en 6 tramos iguales), no por listeners de scroll costosos: un solo `IntersectionObserver`
por bloque de narrativa con `threshold` escalonados, o el equivalente con `scroll-timeline`/
`animation-timeline` si el navegador objetivo lo soporta (Chrome/Edge recientes; con *fallback* al
`IntersectionObserver` donde no, sin librería de terceros obligatoria). Nunca bloquea el scroll nativo
(no es "scroll-jacking": el visitante siempre puede seguir bajando a velocidad normal, la sticky
simplemente se libera al llegar al final del contenedor y la página sigue a la sección de actores).

### 4.2 Mobile y tablet (<1024px): apiladas, sin snap ni carrusel (reescrito, N1)

**La versión anterior era contradictoria y arriesgaba contenido inalcanzable (N1)**: pedía tarjetas
apiladas del alto del viewport y a la vez `scroll-snap-type: y mandatory` a nivel de página, más un
"carrusel opcional" con flechas de swipe — con una tarjeta más alta que el viewport (marco + 2-3 líneas de
texto), el snap deja contenido a medio cortar o exige un scroll calibrado al pixel en iOS y Android a
360×640. Se resuelve así:

- No hay sticky (una columna sticky de 60% no cabe ni tiene sentido en 390px). Cada escena es una tarjeta
  completa, apilada verticalmente, con **scroll normal, sin `scroll-snap`** (ni `mandatory` ni
  `proximity` a nivel de contenedor — como mucho `scroll-snap-type: y proximity` en la tarjeta individual,
  nunca obligatorio, y solo si no genera saltos en la prueba de QA de 390×844).
- El visual de cada tarjeta (marco de teléfono o recorte de consola) se limita a **~70svh como máximo**,
  nunca el 100% del viewport: así el texto de la escena (número, título, 2-3 líneas) siempre queda visible
  junto a su visual, sin que haga falta scrollear dentro de la tarjeta para leerlo.
- **Sin carrusel, sin flechas de swipe**: el indicador de progreso tipo puntos (`● ○ ○ ○ ○ ○`) sobre la
  primera tarjeta se mantiene (es información, no una pista de gesto), pero no hay flechas ni gesto
  custom — el visitante avanza con el scroll normal de la página, igual que el resto de la landing.
- El auto-tipeo (M2) y la reacción de foto (M4) se disparan cuando la tarjeta entra en el 40% central del
  viewport (`IntersectionObserver`), igual que un reveal — no hace falta el cálculo de fracción de scroll
  de desktop porque no hay "escena fija" que llenar.

### 4.3 Layouts por ancho (checklist de implementación) — números unificados (N3)

La versión anterior daba números distintos para el mismo elemento en distintas tablas (220px vs. 200-240px
de loop, 60% vs. 55% de columna visual). Esta tabla es la única fuente de esos números; §1.3 y §2 la citan
en vez de repetir una cifra propia:

| Ancho | Hero (orden N3: texto y CTA primero, loop después) | Recorrido | Actores/Confianza | Galería |
|---|---|---|---|---|
| 360-389px | 1 columna; eyebrow, H1, bajada, CTA primario arriba del pliegue; loop (o póster) debajo a ≥320px de alto | Apilado, sin snap, visual ≤70svh por tarjeta | 1 columna | 1 columna, miniaturas 2 por fila |
| 390-767px | Igual, loop a ≥320px de alto (mismo mínimo, nunca 200-240px) | Apilado, sin snap, visual ≤70svh | 1 columna | 2 por fila |
| 768-1023px | Igual (el layout de 2 columnas del hero pide ≥1024 por el ancho mínimo legible de la columna visual) | Apilado, sin snap, tarjeta más ancha | 2 columnas | 3 por fila |
| 1024-1439px | 2 columnas 55/45 (texto 55, loop 45 — el único ancho con dos columnas en el hero) | Sticky + scroll-driven, columna visual 55% | 4 columnas | 4 por fila |
| ≥1440px | 2 columnas, `max-w-6xl` centrado (el contenedor ya usado en `LandingView.tsx`) | Igual, con más aire lateral | 4 columnas | 5 por fila |

Sin scroll horizontal en ningún ancho (regla dura del proyecto): todo grid usa `grid-template-columns`
con `minmax(0, 1fr)`, nunca anchos fijos que excedan el viewport; las tarjetas de galería usan `object-fit:
cover` dentro de su celda, nunca desbordan. Objetivos táctiles ≥44px: los CTAs ya cumplen (`py-3` sobre
`text-sm` da ~44px de alto); el control de pausa del hero (M0) y los botones de la galería se verifican en
QA (§9).

---

## 5. Accesibilidad y performance

### 5.1 Accesibilidad

- **Landmarks**: `<header>`, `<main>`, `<footer>` (ya así en `LandingView.tsx`); cada sección numerada
  con `<section aria-labelledby="...">` y su `<h2 id="...">`.
- **Teclado**: todo CTA, link de galería, el control de pausa del hero (M0) y control del recorrido
  (flechas del lightbox, ya implementadas en `Lightbox.tsx`) alcanzable por Tab en orden de lectura; el
  recorrido sticky de desktop no atrapa el foco — el usuario de teclado avanza con scroll normal (`Page
  Down`/flechas), igual que cualquier usuario. Foco visible con `:focus-visible`, re-tuneado en el punto
  de abajo.
- **Contraste AA — tabla recalculada para la paleta de §2.1 (reescrita, N4)**. La versión anterior citaba
  cifras equivocadas (`cyan` sobre `navy-deep` daba ~7.7:1, no 4.6:1, y `cyan-soft` sobre `navy` ya pasaba
  con ~13.5:1: ninguno de los dos era el riesgo real) y no señalaba los tres pares que sí fallaban: el
  `text-cyan`/subrayado sobre fondo claro (~2.4:1), el foco global `outline-cyan` sobre blanco (~2.4:1,
  por debajo del mínimo no-textual de 3:1 de WCAG 1.4.11) y `warning` como texto del chip de vencimiento del
  inset "Consola · Casos" de S5 (~2.9:1 sobre blanco). Con la paleta de §2.1, los pares aprobados (verificados con la fórmula de WCAG
  2.x, ratios exactos):

  | Texto / control | Fondo | Ratio | Uso |
  |---|---|---|---|
  | `cyan` `#f4c430` | `navy-deep` `#0a0c0f` | 11.9:1 | CTA y foco sobre fondo oscuro (hero, panel de marca) |
  | `cyan-deep` `#8a6400` | `white`/`paper` | 5.4:1 / 4.9:1 | **Texto, links y foco sobre fondo claro** — nunca `cyan` puro para texto en sección clara |
  | `cyan-deep` `#8a6400` | `cyan-soft` `#fbf0cf` | 4.7:1 | Texto dentro de un badge o pill con fondo `cyan-soft` |
  | `navy` `#1b1f24` | `white`/`paper` | 16.6:1 / 15.2:1 | Titulares y cuerpo sobre fondo claro |
  | `info` `#146b5c` | `white` / `info-soft` | 6.4:1 / 5.3:1 | Cita al manual, notas de sistema sobre fondo claro |
  | `success` `#167a49` | `white` / `success-soft` | 5.4:1 / 4.7:1 | Texto "PASSED" / ✅, nunca el `success` anterior (4.1:1, por debajo de AA) |
  | `warning` `#9a5b00` | `white` / `warning-soft` | 5.4:1 / 4.7:1 | Texto del chip de vencimiento del inset "Consola · Casos" (S5) — corrige el `#c98a12` anterior (2.9:1) |
  | `danger` `#c62839` | `white` / `danger-soft` | 5.6:1 / 4.5:1 | Texto de rechazo (S3) |
  | `slate` `#57626e` | `white` | 6.2:1 | Texto secundario sobre fondo claro |
  | `ink` `#12161b` | `white` | 18.2:1 | Cuerpo sobre fondo claro |

  `mist` y `cyan` (el amarillo puro) quedan **solo para superficie decorativa** (bordes, fondos de badge,
  foco sobre fondo oscuro) y nunca como texto ni como foco sobre fondo claro. **Foco de teclado**:
  `outline-cyan-deep` (no `outline-cyan`) sobre toda sección de fondo claro — 5.4:1, por encima del mínimo
  no-textual de 3:1; `outline-cyan` se mantiene solo dentro del hero y el panel de marca (fondo oscuro),
  donde ya da 11.9:1.
- **Alt text**: cada imagen del manifiesto (§6) trae su `alt` descriptivo obligatorio (el schema de
  `media.ts` ya lo exige, `z.string().min(1)`); el marco de teléfono animado de cada escena lleva un
  `aria-label` que resume la escena en una frase (no transcribe cada mensaje) más un `<span
  className="sr-only">` con el texto final una vez terminado el auto-tipeo, para que un lector de
  pantalla no reciba el efecto de tipeo carácter por carácter.
- **Idioma**: `<html lang="es-MX">` por defecto (N10: no `lang="es"` a secas — el copy de producto es
  es-MX), actualizado a `lang="en"` cuando el visitante cambia el selector, y al idioma que traiga
  `?lang=` al entrar por un CTA (§1.3/B9) — ya existe la lógica de idioma en `lang.tsx`; falta setear
  `document.documentElement.lang` al cambiar — se agrega en WP-55.
- **Movimiento**: cada animación de §3 tiene su equivalente sin motion (columna derecha de la tabla),
  incluida la fila nueva M0 del hero-loop; el contenido final es siempre el mismo con o sin animación —
  ninguna información vive solo dentro de una transición.
- **Toggle es/en**: ya construido (`LandingLangProvider`, `useLandingLang`); se reutiliza sin cambios de
  mecanismo, solo se completan las claves nuevas de `copy.ts` con los textos de este documento; el mismo
  patrón se extiende al `AuthShell` de signup/login (§7.9).

### 5.2 Performance — objetivos ampliados y aclaraciones (N8)

**Qué son los renders, para que no quede ambiguo (N8, corregido)**: mientras dura `status: "render"`
(§6.1), cada escena y cada recorte de consola es **DOM en vivo** (en el propio bundle de la landing, con
datos fijos), no una secuencia de imágenes — el render sí puede animarse con CSS/JS del propio bundle
porque nunca sale del `<canvas>`/`<img>`, sale de React. El **marco de teléfono** es un componente propio
de `views/landing/`, no de `packages/web/src/components/*` (no es el simulador de la consola; WP-44 lo
borra cuando la captura real lo reemplaza, §6.1); los **recortes de consola** (checklist, buzón de salida,
galería) sí reusan los componentes reales de `packages/web/src/components/*`, con datos fijos. Las
imágenes (AVIF/WebP) entran recién con `status: "capture"`, cuando el pipeline de §6.2 saca capturas de la
consola real; hasta entonces no hay imágenes de escena que optimizar, solo las de galería que ya existan
como captura.

- **LCP < 2.5s en 4G**: el elemento más pesado del *above the fold* es el loop del hero (§1.3), DOM en vivo
  mientras es `render`; al pasar a `capture` (WP-44), se sirve como secuencia de imágenes AVIF (con
  `srcset` para 1x/2x) o como `<video autoplay muted loop playsinline>` sin controles — la decisión la
  toma `typescript-dev` según el peso final de cada opción, con el requisito de que cualquiera de las dos
  cumpla el presupuesto de LCP.
- **CLS < 0.1**: el `<link rel="preload">` de la fuente de despliegue (§2.3) y un tamaño reservado
  (`aspect-ratio`) para el marco de teléfono/recorte de consola de cada escena evitan el salto de layout
  cuando el DOM en vivo o la imagen cargan.
- **INP < 200ms**: ningún handler de scroll o de auto-tipeo bloquea el hilo por más de 200ms; el cálculo de
  escena activa (§4.1) y el auto-tipeo (M2) corren en `requestAnimationFrame`, nunca en un `setInterval`
  corto sin throttle.
- **Cero violaciones serias o críticas de axe**, y **Lighthouse Accessibility ≥ 95** sobre la landing, el
  signup y el login, en los dos idiomas — el mismo umbral que verifica QA (§9.1).
- **Formatos**: AVIF con fallback WebP (`<picture>`) para toda imagen de galería y de captura de escena;
  SVG para íconos, para el motivo de fibra (§2.4) y para los logos de marca (ya el patrón en
  `BrandImage.tsx`, que valida SVG sin script).
- **Carga diferida**: `loading="lazy"` en toda imagen fuera del hero (regla dura del proyecto); las seis
  escenas del recorrido cargan sus imágenes (cuando ya son `capture`) a un margen de 1 viewport de
  distancia (`rootMargin: "100% 0px"` en el `IntersectionObserver`), no todas de entrada. Un
  `Content-Security-Policy`/`crossorigin` estándar en el `<picture>`.
- **Presupuesto de fuentes**: Inter (cuerpo) e Space Grotesk (despliegue, §2.3), las dos self-hosted, woff2
  Latin subset, dentro del presupuesto de 60KB de JS de la landing **o** contadas aparte con un techo
  propio de 40KB de woff2 combinado — la implementación elige y lo declara en el PR de WP-55, pero nunca
  las deja fuera de un presupuesto.
- **Sin bloqueo del hilo principal**: el auto-tipeo (M2) y el cálculo de escena activa (§4.1) usan
  `requestAnimationFrame`, nunca `setInterval` corto sin throttle; el manifiesto de galería (`media.ts`,
  ya así) se carga una vez por visita y se cachea en memoria (`cached` ya implementado).
- **Presupuesto por página**: JS de la landing (sin el bundle compartido de React/Tailwind runtime) bajo
  ~60KB gzip; ninguna dependencia nueva sin declarar versión y justificación (regla del repo).
- **Share/OG (N8, nuevo)**: `index.html` de la landing agrega meta `og:title`, `og:description`,
  `og:image` (una imagen de share neutral, sin nombre del socio — el build es estático y no puede resolver
  el modo de marca en tiempo de request) y las equivalentes `twitter:card summary_large_image`, para que un
  link pegado en WhatsApp o LinkedIn tenga preview. **`noindex` se mantiene** (el `<meta name="robots"
  content="noindex">` que ya existe): la landing se comparte por link directo desde la submission y el
  contacto comercial, no busca tráfico orgánico todavía — se revisa como decisión propia cuando haya un
  dominio de marca definitivo, no en esta ola.

---

## 6. Capturas: manifiesto de renders → capturas reales

**Estado (cierre de la ola 5, WP-44): la landing no tiene ningún render.** Las 20 entradas de
`public/landing/manifest.json` (§6.3) están en `status: "capture"`, cada una con su archivo y su hash en
`scripts/landing/captures.json`, producidas por el pipeline de §6.2 sobre la consola real servida
localmente con el mundo sintético determinista; ninguna está en `render` ni en `placeholder`
(`npm run landing:check` lo verifica en CI). El marco de teléfono propio de la landing y los componentes de
cada render se borraron con su reemplazo. §6.1 queda como el criterio histórico con el que se construyeron
los renders de la ola 2b; una entrada nueva del manifiesto entra directamente como `capture`.

### 6.1 Mientras la consola de la GUEST no existía: renders con componentes y textos reales (histórico, reemplazado por WP-44)

Cada elemento visual de la landing (marco de teléfono de una escena, recorte de consola) se construye con
componentes reales renderizados en un estado de datos fijo y curado — nunca una maqueta de Figma ni una
feature que no exista todavía. Los textos de cada escena salen de **una sola fuente**: la historia
principal de `packages/bff/src/story/main-story.ts` (WP-61, OT 24817 y 24818 de Rogelio), donde cada
mensaje está rotulado como `fixedCopy` (texto fijo del producto, importado de `copy/`) o
`exampleAgentReply` (respuesta de ejemplo del agente); el resto de la landing usa `copy/`. Ningún texto de
un render se escribe en `views/landing/**` ni se copia de `docs/design-brief.md`. El **marco de teléfono**
de los renders es un componente propio de la landing (`views/landing/`) — no el simulador de
`/app/simulator`, que llega recién con WP-43 — y WP-44 lo borra junto con cada render que su captura real
reemplaza. Los **recortes de consola** (galería, checklist, buzón de salida) sí reusan los componentes
reales de `packages/web/src/components/*` (`BrandMark`, `Table`, `Badge`, `Callout`, `StatTile`, etc.), con
datos fijos. **En la landing en inglés, el teléfono sigue en es-MX** (el producto le habla al instalador en
es-MX, ADR-0023): cada escena agrega una sola leyenda en inglés junto al mensaje, tomada de una glosa
(`en-gloss.ts` para las plantillas de WhatsApp, o la glosa que acompaña a cada mensaje de `main-story.ts`),
nunca una traducción del chat completo.

**Aclaración (compliance-B6)**: todo render de esta sección ilustra el producto con sus componentes y
textos reales; **no es una sesión en vivo** ni una grabación de un mundo de invitado real — es el mismo
criterio que ya aplica la portada del invitado (§1.11) para lo que todavía no está desplegado.

### 6.2 Pipeline de captura (para cuando la consola exista) — WP-60 adapta la referencia (N10)

Estos scripts están en `scripts/landing/**` (adaptados por WP-60 en la ola 2b.2 del scaffolding reusado,
`docs/reuse-map.md`, con el renombre a `GUEST` y el mundo `guest` de §0) y WP-44 (ola 5) los corrió sobre
la consola completa: son la única fuente de las 20 entradas del manifiesto.

1. `scripts/landing/console-server.ts` (adaptado por WP-60 del scaffolding reusado, `docs/reuse-map.md`
   línea 156) sirve la consola localmente contra un mundo sintético determinista — el mismo mundo `guest`
   de la plantilla curada (ADR-0024), nunca datos reales.
2. `scripts/landing/console-world.ts` siembra el estado exacto de cada escena (S1-S6, más las capturas
   de galería de §6.3) usando los mismos presets de "Saltar a escena" (`world.create`, `docs/seed-spec.md`)
   — así una captura nunca depende de que un turno del agente haya salido bien en el momento de capturar.
3. `scripts/landing/capture-console.ts` (Playwright) navega a cada ruta/estado, espera a que el mundo
   esté "quieto" (sin `WORLD_BUSY`), y captura en dos viewports: **desktop** 1440×900 y **mobile**
   390×844 (los mismos anchos que usa QA, §9), en PNG, convertidos después a AVIF/WebP.
4. `scripts/landing/render-visuals.ts` (adaptado por WP-60, `docs/reuse-map.md` línea 156) compone el marco de
   teléfono o el recorte de consola alrededor de la captura cruda cuando hace falta (por ejemplo, la
   captura cruda del simulador de teléfono ya incluye su propio marco; una captura de una tarjeta de
   caso puede necesitar recorte + sombra).
5. Cada corrida escribe `public/landing/manifest.json` con `status: "capture"` y actualiza
   `captures.json` (ya existente, versionado) con el hash de cada imagen — así un cambio de copy o de
   estilo que no cambió el pixel no genera una captura nueva innecesaria.
6. Un placeholder provisorio (`status: "placeholder"`, ya tipado en `media.ts`) nunca se muestra como si
   fuera un render: la landing lo dice ("captura pendiente", ya el texto existente en `copy.ts`) y tiene
   fecha de reemplazo en `docs/build-plan.md`.

### 6.3 Tabla de manifiesto — reescrita (B2, B4, N5, compliance-B5/B6)

`id` es la clave dentro de `manifest.media` (`media.ts`); `estado inicial` es lo que existía el día que se
integró esta spec (todo `render`, hecho con componentes reales, cero mockups de features inexistentes; hoy
todas las filas están en `capture`, ver el estado al principio de §6);
`reemplazo real` dice la ruta/estado de consola + viewport que produce la captura definitiva y en qué
paquete de trabajo (WP, a asignar por `pm`/`architect` en el plan de olas — aquí solo se numeran en
orden). Los ids siguen el orden de escenas de §1.6 (N5); ninguna fila describe una función inexistente
(B2) ni una palabra de la lista de neutralidad al concurso en una posición de texto de producto
(compliance-B5: la fila `gallery-metrics` ya no dice "evaluación").

| id | Qué muestra | Estado inicial | Reemplazo real (ruta · viewport · estado del mundo) | Cuándo |
|---|---|---|---|---|
| `hero-loop` | Loop de 14-18s: nota de voz (forma de onda y duración, ✓✓ leído, sin transcripción) → cita del manual (texto plano) → foto rechazada con 🔁 → ✅ → PDF, en el marco de teléfono | `render` | `/app/simulator` (identidad Rogelio) · 1440×900 y 390×844 · escena "En sitio 09:20" hasta "Cierre 10:05" | Landing, WP-44, cuando exista `/app/simulator` |
| `s1-voice-diagnosis` | Escena 1 (09:20, OT 24817): nota de voz + cita §DIAG-02 como texto plano | `render` | `/app/simulator` · 1440×900 y 390×844 · escena "En sitio 09:20" | Landing |
| `s2-policy-cite` | Escena 2 (~09:35, OT 24817): pregunta de política citada (texto plano, sin subrayado) + pregunta fuera de manual | `render` | `/app/simulator` · escena "Pregunta de política" | Landing |
| `s3-photo-reject` | Escena 3 (~09:40, OT 24817): en el teléfono, foto con reflejo, reacción 🔁 y el mensaje con el motivo accionable; en un inset aparte, la rúbrica (enfoque/reflejo/encuadre) | `render` | `/app/simulator` · escena "Evidencia" (reacción y mensaje del motivo), más `/app/evidence` (inset de rúbrica) | Landing |
| `s3-photo-pass` | Escena 3: segunda foto validada | `render` | `/app/simulator` · misma escena, segundo envío | Landing |
| `s4-checklist-complete` | Escena 4 (10:05, OT 24817): checklist 5/5 en la consola, sin botón de cierre (la orden no tiene esa acción) | `render` | `/app/orders/:workOrderId` · escena "Checklist completo" | Landing |
| `s4-certificate-pdf` | Escena 4: PDF recibido en el teléfono | `render` | `/app/simulator` · tras "Cerrar instalación" | Landing |
| `s4-outbox` | Escena 4: buzón de salida con dos entregas | `render` | `/app/outbox` · tras el cierre | Landing |
| `s5-escalation-template` | Escena 5 (OT 24818): teléfono de Adriana con el cuerpo exacto de la plantilla `caso_escalado` y los botones [Tomar caso] [No puedo], y nada más — sin miniaturas ni badge de vencimiento | `render` | `/app/simulator` (identidad Adriana) · 1440×900 y 390×844 · escena "Escalación recibida" | Landing |
| `s5-escalation-take` | Escena 5: Héctor toma el caso (`caso_reasignado` → `CASE_BRIEF`) y responde por el puente | `render` | `/app/cases/:caseId` + `/app/simulator` (identidad Héctor) · escena "Vencimiento"/"Tomar y responder" | Landing |
| `s6-safety-hazard` | Escena 6 (OT 24819): mensaje de riesgo del instalador y la instrucción fija de §SEG-01 al instante | `render` | `/app/simulator` (identidad Rogelio) · escena "Riesgo detectado" | Landing |
| `s6-safety-alerts` | Escena 6: alerta de WhatsApp a Adriana y email al jefe de zona, con sus horas, en menos de 60s | `render` | `/app/simulator` (identidad Adriana) + `/app/outbox` · escena "Alertas de seguridad" | Landing |
| `gallery-orders` | Galería: tabla de órdenes del día | `render` | `/app/orders` · 1440×900 y 390×844 | Landing |
| `gallery-order-detail` | Galería: línea de tiempo unificada de una orden | `render` | `/app/orders/:workOrderId` · 1440×900 | Landing |
| `gallery-manual` | Galería: vista del manual con una sección citada abierta | `render` | `/app/manual/:sectionId` (§DIAG-02) · 1440×900 | Landing |
| `gallery-metrics` | Galería: pestaña "Medición del manual" con N y meta (B4: renombrado de ADR-0023 — nunca "evaluación" en una superficie visible) | `render` | `/app/metrics` · pestaña "Medición del manual" · 1440×900 | Landing |
| `gallery-audit` | Galería: bitácora con una decisión y su regla | `render` | `/app/audit` · 1440×900 | Landing |
| `gallery-clock` | Galería: barra de hora simulada con "Avanzar al próximo evento" | `render` | `/app/clock` · 1440×900 | Landing |
| `signup-form` | Signup: formulario con los dos consentimientos separados | `render` (construido junto con la vista real de `/signup`, §7) | Es la vista real: no hay "reemplazo", es captura directa una vez que existe | Signup |
| `signup-code` | Signup: pantalla de verificación por código | `render`/captura directa | Igual | Signup |

20 entradas de manifiesto (18 de landing: `hero-loop`, las 11 de escena y las 6 de la galería; + 2 de signup, que en rigor no son "renders" sino la primera
captura real porque el signup se construye directo, sin una consola previa que reemplazar) — una más que
antes, porque N5 agrega la escena de seguridad (S6) como sus dos propias entradas en vez de reusar las de
S2/S5. Ninguna muestra una funcionalidad que el producto no vaya a tener: cada una corresponde a una vista
o un flujo ya descrito en `docs/design-brief.md`. **`architect` puede retirar en el mismo PR** la excepción
que `docs/build-plan.md` WP-55 registra para `gallery-metrics` ("ADR-0023 prevalece sobre el texto de
§6.3"): esta tabla ya dice "Medición del manual", así que la excepción queda sin objeto.

### 6.4 Galería con zoom

Reusa `gallery.tsx`/`Lightbox.tsx`/`MediaFigure.tsx` tal cual (ya genéricos, `docs/reuse-map.md` línea
132: "Copiar", sin adaptación). Grid de miniaturas (§4.3 para columnas por ancho); cada miniatura abre el
lightbox en su propia imagen; navegación anterior/siguiente ya implementada por teclado (flechas),
`Escape` para cerrar, swipe en mobile — verificar en QA que el foco vuelve a la miniatura que abrió el
lightbox al cerrar (accesibilidad de diálogo modal).

---

## 7. UX de signup y login

### 7.1 Principios — reescrito (B8a)

- El signup **es** captación de leads (skill §"Captación de leads"): cada alta confirmada es un lead.
  Esto no cambia la UX hacia "formulario de venta" — sigue sintiéndose como crear una cuenta de prueba,
  porque forzar el tono comercial en el formulario reduce conversión y contradice "prueba la demo sola".
- Mismo lenguaje visual que el login ya construido (`LoginView.tsx`): panel de marca a la izquierda
  (oculto en mobile, con `BrandPanel` reusado tal cual — mismo componente, mismo `tagline`/`points`),
  tarjeta blanca a la derecha con el formulario. El signup y el login **comparten el mismo shell**
  (`AuthShell`, a extraer de `LoginView.tsx` en WP-57 ya que hoy el JSX del layout está inline en
  `LoginView`): un cambio de fondo o de copy del panel se hace una vez, no dos. El `AuthShell` agrega el
  toggle es/en y lee `?lang=` (§7.9, B9).
- **Máquina de pasos corregida, sin paso intermedio ni destino equivocado (B8a)**: la versión anterior
  saltaba de `confirmCode` directo a `CONSOLE_HOME`, pero `ConfirmSignUp` de Cognito **no inicia sesión** —
  confirma el email, nada más (ADR-0025 §1). La máquina real es `signUp → confirmCode → done`:
  1. `signUp`: llama `signup.start` (ticket) y `SignUp` de Cognito (§7.3).
  2. `confirmCode`: `ConfirmSignUp` con el código (§7.4).
  3. Al confirmar, el propio paso **inicia sesión por SRP automáticamente**, con la contraseña que el
     formulario ya tiene en memoria (nunca se guarda ni se manda de nuevo por red más que dentro del
     intercambio SRP) — el mismo flujo que usa `LoginView.tsx` para `credentials`, invocado en código en
     vez de por un formulario. Un error de login en este paso (poco probable, mismo usuario recién
     confirmado) cae al paso `credentials` del login normal con el email precargado, nunca a un error
     genérico.
  4. `done` redirige a **`/app/home`** (portada del invitado, `guest-home`, ADR-0025 §2) — no a
     `CONSOLE_HOME`, que no es el punto de entrada de un `GUEST` (§7.8).

  No hay paso `worldPending`: el aprovisionamiento del mundo corre asíncrono desde `post-confirmation`
  (ADR-0025 §2) y su estado se muestra en la portada del invitado, no en la máquina de signup (§7.6).

### 7.2 Rutas

| Ruta | Vista | Notas |
|---|---|---|
| `/signup` | Formulario de alta | Nueva; agrega `?lang=es-MX`/`en` desde la landing (§1.3, B9) |
| `/signup?code=1` (o un paso interno, no una ruta separada) | Verificación por código | Se resuelve como paso de la misma máquina, no una ruta nueva — igual que el login no tiene una ruta por paso |
| `/login` | Ya existe | Se agrega un link "¿No tienes cuenta? Prueba la demo" bajo el formulario de credenciales, hacia `/signup` (§7.7) |
| `/login?forgot=1` (paso existente) | Recuperar contraseña | Ya construido (`ForgotRequestStep`/`ForgotConfirmStep`), sin cambios |
| `/app/home` | Portada del invitado (`guest-home`) | Destino de `done` en el signup (B8a) y de todo login de un `GUEST`; nueva, §7.6 |

### 7.3 Formulario de alta (paso `signUp`)

Layout: tarjeta blanca (`rounded-card bg-white p-6 shadow-card sm:p-8`, mismo patrón que
`LoginView.tsx`). Campos, en este orden:

1. **Email** (obligatorio, `type="email"`, autocomplete `email`)
2. **Contraseña** (obligatoria, mismas reglas que ya existen en `lib/auth/credentials.ts` — se reutilizan
   sin cambios: `PASSWORD_MIN_LENGTH` 12+, minúscula, mayúscula, número, símbolo. **Reusa el componente
   `PasswordField` con su control de mostrar/ocultar y sus reglas visibles tal cual el login los usa hoy en
   `newPassword`** (N6: la versión anterior no lo decía explícito); **sin campo de confirmación** — el
   mismo `PasswordField` ya expone el valor en claro al togglear "Mostrar", así que un segundo campo de
   confirmación es fricción redundante, no seguridad adicional.
3. Separador visual sutil ("Opcional") antes de los tres campos extra, para que se entienda que el
   formulario "corto" ya terminó en el punto 2:
4. **Nombre** (opcional)
5. **Empresa** (opcional)
6. **Cargo** (opcional)

Nunca más de 3 campos extra (regla dura del skill) — son exactamente los tres de arriba, ninguno más.
Debajo de los campos, **dos casillas separadas, ninguna tildada por defecto**:

- Casilla A (obligatoria para enviar el formulario): texto con dos links inline a `/legal/terms.html` y
  `/legal/privacy.html`.
- Casilla B (opcional, no bloquea el envío): consentimiento de contacto comercial.
- **Protección contra bots, invisible (B8d/N2, corregido — ADR-0025 §4 descarta CAPTCHA, "ninguna regla usa
  CAPTCHA")**: la protección contra bots es invisible: `lib/waf-token.ts` adquiere el token de AWS WAF
  (Challenge silencioso) antes de habilitar "Crear cuenta"; no hay widget ni texto propio. El único texto
  visible es el de la fila "Challenge silencioso de WAF" de §7.5, para el caso en que el token no llega.

Textos exactos (es-MX y en); el texto y la **versión** de las dos casillas de consentimiento no viven en
este documento ni en el código del signup — vienen de la fuente única `packages/shared/src/legal/
consents.ts` (`TERMS_PRIVACY`, `CONTACT`, ADR-0026), que el signup importa y valida; esta tabla los cita
tal como están hoy en esa fuente, versión `2026-09-26` (R2-B4: `consents.ts` es la única fuente y su texto
de `TERMS_PRIVACY` tiene que coincidir con el de la fila "Casilla A" de abajo, que ahora nombra la
transferencia internacional que ADR-0026 §4 basa en este consentimiento). El texto más largo de la Casilla
A se verifica en QA (§9.1) para que siga envolviendo con claridad a 360px junto al objetivo táctil de 44px
de la casilla:

| Campo | es-MX | en |
|---|---|---|
| Título | Crea tu cuenta | Create your account |
| Bajada | Entras con esta cuenta y tu propio mundo de prueba se crea al confirmar el email. | Sign in with this account and your own test world is created once you confirm your email. |
| Email | Email | Email |
| Contraseña | Contraseña | Password |
| Nombre | Nombre (opcional) | Name (optional) |
| Empresa | Empresa (opcional) | Company (optional) |
| Cargo | Cargo (opcional) | Job title (optional) |
| Casilla A (obligatoria, `legal/consents.ts` `TERMS_PRIVACY`) | Acepto los [Términos](/legal/terms.html) y el [Aviso de privacidad](/legal/privacy.html) de Craftech, incluida la transferencia de mis datos a Estados Unidos y a otras regiones de AWS descrita en el aviso. | I accept Craftech's [Terms](/legal/terms.html) and [Privacy Notice](/legal/privacy.html), including the transfer of my data to the United States and other AWS regions described in the notice. |
| Casilla B (opcional, `legal/consents.ts` `CONTACT`) | Acepto que Craftech me contacte por esta solución. | I agree that Craftech may contact me about this solution. |
| Botón | Crear cuenta | Create account |
| Nota bajo el botón | Vas a recibir un código por email para confirmar tu cuenta. | You'll get an email code to confirm your account. |
| Link a login | ¿Ya tienes cuenta? Inicia sesión | Already have an account? Sign in |

Validación: la casilla A sin marcar deshabilita el botón "Crear cuenta" (no un error después del envío);
la casilla B nunca bloquea nada. El error de contraseña débil reusa el patrón visual ya existente
(`ErrorNote`, reglas visibles con check/cross). El `locale` que manda `signup.start` (`es-MX` o `en`) es
el idioma elegido en el toggle del `AuthShell` en ese momento, no un valor fijo (B9(4)): Cognito lo usa
para elegir la plantilla de `custom-message.ts` (es-MX/en) del código de verificación.

### 7.4 Verificación por código (paso `confirmCode`)

Mismo patrón visual que `TotpStep`/`ForgotConfirmStep` ya construidos (campo de código, botón "Verificar",
mensaje de reenvío). Copy:

| Campo | es-MX | en |
|---|---|---|
| Título | Revisa tu email | Check your email |
| Bajada | Te enviamos un código de 6 dígitos a `{email}`. Si no llega en unos minutos, revisa tu carpeta de spam. | We sent a 6-digit code to `{email}`. If it doesn't arrive in a few minutes, check your spam folder. |
| Campo | Código | Code |
| Botón | Confirmar cuenta | Confirm account |
| Reenviar | Reenviar código | Resend code |
| Reenviado | Código reenviado. | Code resent. |
| Error código inválido | El código no es válido o venció. Pide uno nuevo. | The code isn't valid or expired. Request a new one. |
| Volver | Usar otro email | Use a different email |

Al confirmar (B8a), este paso encadena el login SRP automático y navega a `/app/home`; no hay copy propio
para ese instante — es el mismo spinner corto de "Un momento…" que ya usa `loginCopy.working` en
`LoginView.tsx`, reusado tal cual.

### 7.5 Anti-abuso, visible para quien prueba — reescrito contra ADR-0025 (B8c/d, N13)

Ninguno de estos límites se explica como "seguridad" en la UI (sería ruido); se explican solo si el
visitante los toca, con un mensaje claro y sin tecnicismos. Cada código de error de `signup.start` /
`SignUp` / `ConfirmSignUp` tiene su propio mensaje — ninguno revela si un email existe, salvo
`EMAIL_TAKEN`, que es intencional (ADR-0025 asume ese riesgo acotado por los límites por IP y por email):

| Código / situación | Dónde ocurre | Mensaje, es-MX | en |
|---|---|---|---|
| `EMAIL_TAKEN` (una cuenta por email) | `signup.start` | Ya existe una cuenta con este email. ¿Quieres [iniciar sesión](/login) o [restablecer tu contraseña](/login?forgot=1)? | There's already an account with this email. Want to [sign in](/login) or [reset your password](/login?forgot=1)? |
| `RATE_LIMITED` — agrupa **cinco** límites de ADR-0025 §3 (5 altas/hora por IP; IP anónima 1/hora y 30/día en el stage; 3/hora o 5/día por persona; 3 usuarios sin confirmar por el mismo email; 2 cuentas confirmadas por persona), neutral y sin promesa de tiempo porque la mayoría no se resuelve "en minutos" | `signup.start` | Llegaste al límite de altas desde esta conexión o con este email. Intenta más tarde o [hablemos](https://craftech.io/contact/) y te preparamos una demo guiada. | You've reached the sign-up limit for this connection or email. Try again later, or [let's talk](https://craftech.io/contact/) and we'll set up a guided demo. |
| `CAP_REACHED` — tope diario de altas *iniciadas* en el stage (300/día, ADR-0025 §3) **o** `KILL#SIGNUP` encendido (ADR-0025 §4): los dos casos comparten el mismo código, así que el texto no promete "mañana" | `signup.start` | Por ahora no estamos abriendo cuentas nuevas de prueba. Vuelve más tarde o [hablemos](https://craftech.io/contact/) y te preparamos una demo guiada. | We're not opening new test accounts right now. Try again later, or [let's talk](https://craftech.io/contact/) and we'll set up a guided demo. |
| `TICKET_INVALID` — el ticket de alta venció (10 min) o llegó a sus **a lo sumo dos usos** (ADR-0025 §3) | `SignUp` | La sesión del formulario venció, intenta de nuevo. | The form session expired, please try again. |
| `INVALID` — consentimiento (versión vieja, o `TERMS_PRIVACY` sin marcar) | `signup.start` | Reusa el error de validación de la casilla A (no se envía) — no hay un mensaje aparte, el botón sigue deshabilitado. | Same. |
| `INVALID` — dominio del email sin MX ni A/AAAA (ADR-0025 §3; `docs/test-plan.md` §6.1 lo prueba) | `signup.start` | Revisa tu email: ese dominio no puede recibir correo. | Check your email: that domain can't receive mail. |
| `UNAVAILABLE` — sin `edge.viewerIp` (el pedido no pasó por CloudFront, ADR-0025 §3) | `signup.start` | No pudimos crear tu cuenta en este momento. Intenta de nuevo en unos minutos. | We couldn't create your account right now. Please try again in a few minutes. |
| Errores de Cognito en `SignUp`/`ConfirmSignUp` (código inválido, contraseña débil, etc.) | Cognito | Traducidos a los textos de §7.3/§7.4 — nunca el texto crudo de Cognito. | Same. |
| Challenge silencioso de WAF (`lib/waf-token.ts`, ADR-0025 §4 — "ninguna regla usa CAPTCHA") | Antes de `signup.start` | Sin texto propio: el botón "Crear cuenta" se habilita recién cuando `lib/waf-token.ts` consigue el token. Si no lo consigue en 10s (bloqueador de contenido, extensión de navegador o error de red): "No pudimos verificar tu navegador. Recarga la página, desactiva el bloqueador de contenido para este sitio o intenta desde otro navegador." | "We couldn't verify your browser. Reload the page, turn off your content blocker for this site, or try another browser." |
| **Tope de mundos `SIGNUP` activos (`CAP_FULL`)** | **Ya no es un error del formulario (B8c)** — ADR-0025 §3: la cuenta y el lead ya existen; el mundo queda pendiente | Se muestra en la **portada del invitado** después de iniciar sesión, no en el signup (§7.6) | Same |

**Corrección de fondo (B8c)**: la versión anterior de esta tabla trataba el tope de mundos como un rechazo
del formulario de alta. Per ADR-0025 §3, ese tope (`CAP_FULL`) se descubre **después** de confirmar el
email: la cuenta de Cognito y el lead ya se crearon, y es la portada del invitado (§7.6) la que muestra el
estado y el "Reintentar" — el signup nunca lo bloquea antes de crear la cuenta. Lo que sí puede rechazar
`signup.start` **antes** de crear nada es `CAP_REACHED` (el tope diario de altas *iniciadas*, no de
mundos), agregado arriba.

**Corrección de fondo (B8d/N2, reescrita — R2-B2/NB-1)**: la versión anterior de esta sección pedía un
widget de **AWS WAF JS CAPTCHA API** que ADR-0025 §4 **descarta explícitamente** ("Ninguna regla usa
CAPTCHA"; la opción A' — CAPTCHA para IP anónimas — queda "Descartada por ahora" porque una acción CAPTCHA
sobre el `fetch` del alta responde `405` con HTML que la página no puede mostrar, y bloquearía a
prospectos detrás de una VPN corporativa); WP-56 no crea ninguna clave de API de WAF y CLAUDE.md pide
"AWS WAF … sin CAPTCHA". La protección real, la opción **A** elegida por ADR-0025 §4, es **AWS WAF en el
Router** (reputación de IP, tasa por IP, un **Challenge silencioso** en `/api/signup.*`, la regla
`AnonymousIpSignup` que solo **etiqueta** la IP anónima o de VPN corporativa, sin bloquear ni mostrar nada)
**+ AWS WAF regional en el user pool** (tasa por operación de Cognito) — nunca un widget visible. Una IP
anónima o de VPN corporativa no ve ninguna interfaz distinta: solo tiene el límite de altas más estricto
de ADR-0025 §3 (1 por hora por IP, 30 por día en el stage), que el visitante experimenta como
`RATE_LIMITED` (misma tabla de arriba). El Challenge no tiene UI propia — `lib/waf-token.ts` adquiere el
token antes de habilitar "Crear cuenta" — y solo hay texto visible cuando el token no llega (fila
"Challenge silencioso de WAF" de arriba).

El **costo real de la cuenta compartida** (por qué existen estos límites) no se explica en el signup —
es información de `docs/design-brief.md` §12, interna. En la UI pública solo se ve el efecto (los mensajes
de arriba), nunca la razón de costo, porque explicarla ahí suena a excusa y no aporta a quien prueba la
demo.

### 7.6 Portada del invitado (`/app/home`) — reescrita por completo (B8b)

**Por qué se reescribe**: la versión anterior mezclaba el estado del mundo en dos lugares (un paso
`worldPending` del signup y "los tres estados" de la portada) y solo definía copy para `PROVISIONING` y
una variante lenta. `docs/build-plan.md` WP-58 ya cita "§7.6 los tres estados" para construir la portada;
esta sección es ahora esa única fuente, con los **cuatro** estados reales de ADR-0025 §2-§3: `PROVISIONING`
→ `READY` (o `FAILED`, reintentable) o `CAP_FULL`. No hay paso de signup para esto (§7.1): todo vive acá,
en `/app/home`, el destino de todo login de un `GUEST` (§7.2).

Layout: mismo shell de la consola (header con `BrandMark`, sin el panel de marca de dos columnas del
login/signup — ya es una vista autenticada), tarjeta central con el estado del mundo.

| Estado | es-MX | en |
|---|---|---|
| `PROVISIONING` (spinner, **sin porcentaje falso** — no hay forma honesta de estimarlo) | **Título**: Estamos preparando tu mundo de prueba. **Bajada**: Tu instalador, tus órdenes y tu manual sintéticos ya casi están listos. **Espera prolongada (&gt;8s)**: Está tardando más de lo normal. Si no carga en un momento, [escríbenos](https://craftech.io/contact/). | **Title**: We're setting up your test world. **Lead**: Your synthetic installer, work orders and manual are almost ready. **Long wait (&gt;8s)**: This is taking longer than usual. If it doesn't load in a moment, [reach out](https://craftech.io/contact/). |
| `READY` | **Título**: Tu mundo está listo. **Resumen**: nombre del instalador y de la operadora sembrados, fecha de creación. **Vencimiento**: Tu mundo vence el {fecha}; al volver a entrar se recrea. **Habilitación por etapas**: Se habilita por etapas — lista de lo que ya puedes usar (calculada con `lib/view-registry.ts`, igual que §1.11/§1.12), sin fechas para lo que falta. **Borrar cuenta**: link "Borrar mi cuenta" → confirmación con tu contraseña y el texto "Esto borra tu cuenta, tus datos de contacto y tu mundo de prueba. No se puede deshacer." **Logout**: "Cerrar sesión" | **Title**: Your world is ready. **Summary**: seeded installer and operator names, creation date. **Expiry**: Your world expires on {date}; it's recreated the next time you sign in. **Rolling out in stages**: what you can already use (from `lib/view-registry.ts`), no dates for what's still rolling out. **Delete account**: "Delete my account" link → confirm with your password, "This deletes your account, your contact details and your test world. This can't be undone." **Logout**: "Sign out" |
| `FAILED` (aprovisionamiento falló, reintentable) | **Título**: No pudimos preparar tu mundo. **Bajada**: Puede ser algo temporal. **Botón**: Reintentar (`guest.retryWorld`, 1 por minuto) | **Title**: We couldn't set up your world. **Lead**: This might be temporary. **Button**: Retry (`guest.retryWorld`, once a minute) |
| `CAP_FULL` (tope de 150 mundos `SIGNUP` activos, ADR-0025 §3 — **ya no es un error del formulario, B8c**) | **Título**: Por ahora llegamos al límite de mundos de prueba disponibles. **Bajada**: Tu cuenta ya está creada; solo falta lugar para tu mundo. **Botón**: Reintentar. **Alternativa**: [Hablemos](https://craftech.io/contact/) si quieres una demo guiada mientras tanto. | **Title**: We've hit the limit of test worlds available right now. **Lead**: Your account is already created; we just need room for your world. **Button**: Retry. **Alternative**: [Let's talk](https://craftech.io/contact/) if you'd like a guided demo meanwhile. |
| `PERSON_LIMIT` (tercera cuenta confirmada de una misma persona, ADR-0025 §3: la cuenta y el lead existen, el mundo no llega) | **Título**: Ya tienes dos cuentas de prueba con su mundo. **Bajada**: Esta cuenta quedó creada, pero sin mundo propio: cada persona puede tener hasta dos mundos de prueba. Sigue con una de tus otras cuentas. **Sin botón Reintentar**. **Alternativa**: [Hablemos](https://craftech.io/contact/) si quieres una demo guiada con más espacio. | **Title**: You already have two test accounts with their worlds. **Lead**: This account is created, but without a world of its own: each person can have up to two test worlds. Carry on with one of your other accounts. **No Retry button**. **Alternative**: [Let's talk](https://craftech.io/contact/) if you'd like a guided demo with more room. |

`PROVISIONING` usa `<FullScreenMessage>` (componente ya existente en `packages/web/src/components/`) con
un spinner; `READY`/`FAILED`/`CAP_FULL`/`PERSON_LIMIT` son la vista normal de `/app/home` con su tarjeta de estado.

### 7.7 Login — copy neutral y columna en completa (B9)

`LoginView.tsx`/`copy.ts` no cambian de máquina de estados. `packages/web/src/views/login/copy.ts` es hoy
**solo español** (`loginCopy` sin contraparte `en`); B9 pide una columna en completa para cada string —
credenciales, `newPassword`, `totp`, `mfaSetup`, recuperación (`forgot`/`reset`), errores y el panel de
marca — con la misma estructura de claves que el objeto es actual, para que `LoginView.tsx` elija por
`useLandingLang`/`?lang=` igual que ya hace `copy.ts` de la landing. Esta spec no repite las ~40 claves de
`loginCopy` con su traducción una por una (las trae `packages/web/src/views/login/copy.en.ts`, nuevo,
mismo patrón que `views/login/copy.ts`); especifica los cambios de fondo:

| Campo | Antes (ya en el repo, voseo) | es-MX nuevo (tuteo) | en (nuevo) |
|---|---|---|---|
| `credentials.lead` | "Usa el email y la contraseña de tu invitación." | **Neutral (B9(5)): "Usa tu email y tu contraseña."** — ya no asume que todo login viene de una invitación, porque desde esta ola también inician sesión los invitados de alta propia | "Use your email and password." |
| `credentials.hint` | "Tu usuario se crea por invitación. Si no lo tienes, pídeselo a tu supervisor." | Se mantiene, **debajo** de `credentials.lead` como aclaración para roles internos, y se agrega un link: "¿Nunca has usado Cuadrilla? [Prueba la demo](/signup)" | "Never used Cuadrilla? [Try the demo](/signup)" |
| `panel.points` (lista del panel de marca) | "Demo sintética: datos 100% inventados" | Se mantiene (ya sin mención al concurso) | Igual |

**Por qué se corrige `credentials.lead` (B9(5))**: "usa el email y la contraseña de tu invitación" es falso
para un invitado que se registró solo — nunca recibió una invitación. El texto neutral sirve para los dos
caminos; el hint de invitación queda como aclaración secundaria para quien sí llegó por `console:invite`.

### 7.8 Roles internos — reescrito contra ADR-0024 (B4)

**La versión anterior citaba el rol viejo** ("el futuro nombre no-`JUDGE`… el rol de evaluador"), que
ADR-0024 ya resolvió: no hay un nombre pendiente, y no hay un rol aparte para pruebas internas. El estado
real:

- **`GUEST` es el único rol de quien prueba la demo**, con tres orígenes que solo cambian cómo nace la
  cuenta y el ciclo de vida de su mundo (ADR-0024): **`INVITED`** (cuentas `guest-01`..`guest-NN` creadas
  por el operador con `console:invite --guest`, credenciales solo en las instrucciones privadas de la
  submission), **`TEST`** (`guest-test`, ensayo del operador) y **`SIGNUP`** (alta propia por `/signup`,
  esta spec). Los tres orígenes tienen exactamente el mismo comportamiento en la consola: el de
  `SUPERVISOR` dentro de su propio mundo, nunca de otro.
- **`SUPERVISOR` y `OPS` son solo por invitación** (`console:invite`), sin cambios; `/signup` **nunca**
  crea esos roles.
- El formulario de `/signup` crea **exclusivamente** cuentas `GUEST` de origen `SIGNUP`.

### 7.9 Mobile vs. desktop, e idioma del `AuthShell` (B9(2))

Mismo patrón que el login ya construido: en `<lg` el panel de marca (`BrandPanel`) se oculta (ya así,
`hidden lg:block` en los bloques con `title`/`lead`/`points`) y solo queda un `BrandMark` chico arriba de
la tarjeta; en `≥lg` es un grid de dos columnas `5fr/6fr` (ya el patrón exacto de `LoginView.tsx`, se
reusa sin cambios de proporción).

**Toggle es/en (nuevo, B9)**: el `AuthShell` (§7.1) agrega, en el header de la tarjeta (junto al
`BrandMark` chico en mobile, junto al panel de marca en desktop), el mismo componente de toggle es/en que
ya usa la landing (`useLandingLang`, extendido a un contexto propio del `AuthShell` que no depende de estar
montado dentro de `LandingView`). Al montar, lee `?lang=` de la URL (§1.3); al cambiar, actualiza
`document.documentElement.lang` igual que la landing (§5.1) y persiste la elección en el estado del propio
flujo (`use-auth-flow.ts`), no en la URL, para que un cambio de paso (`signUp` → `confirmCode`) no la
pierda.

---

## 8. Copy — resumen de dónde vive cada texto

**Regla de voz, sobre todo lo que sigue: es-MX = tuteo.** Nunca voseo ("crea" no "creá", "prueba" no
"probá", "revisa" no "revisá", "tienes" no "tenés"). Todo texto es-MX de este documento ya está en tuteo
(N11/N13); ninguna implementación necesita convertir nada.

Este documento ya trae, inline, el texto es-MX/en de cada bloque (§1, §7). Al implementar, con las rutas
de archivo corregidas contra ADR-0026 (N9/N13 — la versión anterior decía que el consentimiento vivía "en
el código del signup" y el aviso de lead en `copy/es-MX.ts`, y ninguno de los dos es correcto):

| Bloque | Archivo destino |
|---|---|
| Landing (hero, problema, recorrido, actores, confianza, impacto, integración, real/simulado, CTA final, footer) | `packages/web/src/views/landing/copy.ts` (extiende el objeto `es`/`en` ya existente) |
| Signup, verificación, portada del invitado (§7.6) | `packages/web/src/views/signup/copy.ts` y `packages/web/src/views/guest-home/copy.ts` (nuevos, mismo patrón que `views/login/copy.ts`) |
| Login, columna en completa (§7.7) | `packages/web/src/views/login/copy.ts` (es, ya existente) y `packages/web/src/views/login/copy.en.ts` (nuevo) |
| Texto de los dos consentimientos y su versión (§7.3) | `packages/shared/src/legal/consents.ts` (ADR-0026) — **no** el código del signup; el signup y la vista lo importan |
| Emails de autenticación (código de alta, reenvío, recuperación) | `packages/bff/src/copy/auth-emails.ts` (es-MX) y `auth-emails.en.ts` (ADR-0025 §1) |
| Texto del aviso de lead nuevo a Craftech | `packages/bff/src/copy/lead-notify.ts` (ADR-0026) — **no** `copy/es-MX.ts`, que es el copy de producto de la demo (personal, plantillas, acta) |

---

## 9. Checklist de aceptación

### 9.1 QA funcional (Playwright, 390×844 y 1440×900, es y en, con y sin `prefers-reduced-motion`)

- [ ] Landing carga sin scroll horizontal en 360, 390, 768, 1024, 1440px.
- [ ] Los tres CTAs del hero y del CTA final llevan a `/signup`, `/login` (con `?lang=` según el idioma
      activo, B9) y `https://craftech.io/contact/` (nueva pestaña) respectivamente, en los dos idiomas.
- [ ] El loop del hero (`hero-loop`, M0) tiene su control de pausa visible de ≥44px, se pausa con hover,
      foco, fuera de viewport y `visibilitychange`, se detiene solo a las 2 vueltas y descansa en el
      cuadro final; con `prefers-reduced-motion` muestra el póster estático, sin loop. Ni el cuadro final
      ni el póster muestran texto bajo la burbuja de voz (forma de onda, duración y ✓✓, nunca una
      transcripción), y su `sr-only` nombra los cinco momentos del loop.
- [ ] El recorrido (`#recorrido`) muestra las 6 escenas en el orden de §1.6 (voz+diagnóstico, política,
      foto, acta+buzón, escalación, seguridad), con sticky en desktop y apiladas sin snap en mobile
      (visual ≤70svh por tarjeta); con `prefers-reduced-motion` no hay auto-tipeo ni crossfade, el
      contenido final es legible igual (un teléfono quieto cuya conversación no entra se desplaza por
      dentro, abre en el último mensaje y, en sus extremos, la rueda o el dedo siguen con la página; uno
      cuya conversación entra nunca retiene el scroll de la página); ninguna escena dibuja un contorno sobre una foto ni un link
      subrayado dentro de un mensaje.
- [ ] Los contadores de impacto (§1.9) llegan a su valor final y **siempre** muestran su rótulo ("meta" /
      "supuesto") con su fuente y su N, en los dos idiomas; los dos topes "menos que" no cuentan hacia
      arriba desde 0.
- [ ] La galería abre en lightbox, navega con teclado (flechas, Escape) y con swipe en mobile; el foco
      vuelve a la miniatura al cerrar; la pestaña de métricas capturada dice "Medición del manual".
- [ ] Signup: la casilla A sin marcar deja el botón deshabilitado; con A marcada y B sin marcar, el envío
      funciona; el código de verificación confirma la cuenta **y arranca sesión sola** (SRP automático),
      llevando a `/app/home`; un código inválido muestra el error sin decir si el email existe; el
      Challenge silencioso de WAF no bloquea un alta normal y no renderiza ningún widget de CAPTCHA en
      ningún caso; con `lib/waf-token.ts` bloqueado (extensión/red), aparece el mensaje de verificación de
      navegador de §7.5, nunca un error sin manejar.
- [ ] Portada del invitado (`/app/home`, §7.6): los cuatro estados (`PROVISIONING`, `READY`, `FAILED`,
      `CAP_FULL`) muestran su copy; "Borrar mi cuenta" pide contraseña y confirmación explícita.
- [ ] Login: el link a `/signup` está presente y funciona; el lead de credenciales es neutral (no asume
      invitación); la columna en completa existe para cada string (credenciales, `newPassword`, `totp`,
      recuperación, errores); el flujo de recuperación de contraseña sigue igual que antes de esta spec.
- [ ] Cero texto visible (landing, signup, login, legales, portada del invitado) contiene una palabra de
      la lista de términos prohibidos ni del léxico de neutralidad al concurso (hackathon, Devpost,
      concurso, premio, jurado, juez/jueces, judge(s), evaluación/evaluador) — `npm run lint:neutral-
      surfaces` y `lint:forbidden` en verde sobre fuentes y sobre el build `dist`; ningún string es-MX
      usa voseo.
- [ ] `document.documentElement.lang` (`es-MX`/`en`) cambia con el selector, en la landing y en el
      `AuthShell` de signup/login.
- [ ] Contraste AA verificado con una herramienta automática (axe o equivalente) sobre cada sección,
      landing y signup/login, contra la tabla de pares de §5.1 — cero violaciones serias o críticas,
      Lighthouse Accessibility ≥ 95.
- [ ] LCP medido en una corrida de Lighthouse contra el stage con throttling 4G < 2.5s; CLS < 0.1;
      INP < 200ms.
- [ ] **WCAG 2.2.2 (nuevo, N7)**: ninguna animación fuera de M0 se mueve por más de 5s sin un control de
      pausa. El pulso de la hebra de fibra (M10) corre a lo sumo 2 iteraciones (≤4.8s) por cambio de
      marcador y descansa en opacidad plena; el parpadeo de los puntos PON (M11) para a los 5s de entrar en
      viewport y queda fijo; la forma de onda de la nota de voz (M3) corre una sola vez (≤4s) y descansa
      estática; el auto-tipeo (M2) no supera 4s por mensaje (`min(35ms, 4000ms/longitud)`) y ningún mensaje
      `fixedCopy` (instrucción de §SEG-01, plantillas `caso_escalado`/`caso_reasignado`/`alerta_seguridad`)
      pasa por M2, aparece completo de una vez; la barra de progreso de escena (M7) sigue el scroll del
      visitante sin temporizador propio, por lo que no es una animación autónoma y queda fuera de este
      chequeo. Con `prefers-reduced-motion`, M10, M11 y M3 nacen directo en su estado final sin animar, y
      M2 muestra el mensaje completo sin cursor.

### 9.2 Revisión de diseño (mirada de cliente potencial)

- [ ] En los primeros 5 segundos sobre el hero, sin scrollear, se entiende qué es el producto, para quién
      es y que funciona de verdad (no es una promesa); nada dice ni implica "en menos de un minuto".
- [ ] El recorrido de 6 escenas cuenta una historia con principio (el instalador solo, con una duda) y
      fin (el acta emitida), más el diferencial de seguridad como su propia escena — sin necesitar el
      texto de acompañamiento para seguirla; las capturas/renders solas narran.
- [ ] La sección de confianza (§1.8) responde, sin que haga falta preguntarlo, "¿qué pasa si el agente se
      equivoca o inventa algo" y "¿quién decide de verdad".
- [ ] Ninguna cifra de impacto se lee como un resultado medido en producción, y ninguna es un placeholder
      literal.
- [ ] El signup se siente como "crear una cuenta de prueba", no como "dejar mis datos para que me
      llamen" — aunque técnicamente sea lo segundo también.
- [ ] Un visitante que se registra durante las olas 2b-5 entiende, desde la portada del invitado y desde
      la nota de la landing, qué partes de la consola ya puede usar hoy y que el resto llega por etapas —
      nunca cree que algo no funciona quedó roto.
- [ ] Nada en la landing, el signup, la portada del invitado o los legales sugiere que hay un jurado, un
      concurso o una evaluación detrás.
- [ ] La identidad visual (paleta, tipografía de despliegue, motivo de fibra) se distingue a simple vista
      de la landing de referencia interna — no es la misma paleta con otro logo.

---

## 10. Resumen ejecutivo

**Concepto**: la landing muestra el producto funcionando en 6 escenas de una sola historia (Rogelio,
órdenes 24817-24819, en orden cronológico: voz+diagnóstico, política, foto, acta+buzón, escalación,
seguridad) contadas como un recorrido sticky/scroll-driven en desktop y apiladas sin snap ni carrusel en
mobile — nunca una lista de features. La identidad visual **es propia de Cuadrilla** (B7): los mismos
nombres de token de la consola y el login, con valores hex propios (asfalto/grafito, amarillo de cordón de
parcheo monomodo, verde de conector APC), una tipografía de despliegue self-hosted distinta de Inter, y un
motivo de fibra con pulso de luz y puntos de estado tipo luz PON — no la paleta ni el motivo de la landing
de referencia interna. El signup es una máquina de pasos corregida (`signUp → confirmCode → done`, con
login SRP automático al confirmar, hacia `/app/home`), captura el lead con dos consentimientos separados y
sin tildar (fuente única en `legal/consents.ts`), y la portada del invitado (`/app/home`) es honesta sobre
qué se habilita por etapas, con sus cuatro estados (`PROVISIONING`/`READY`/`FAILED`/`CAP_FULL`). El
recorrido en inglés funciona de punta a punta (`?lang=` persistente, `AuthShell` con toggle propio, login
con columna en completa). Todo texto es-MX está en tuteo. Cero superficie visible nombra el concurso, un
jurado o un cliente de Craftech; el rol público es `GUEST`, con sus tres orígenes (`INVITED`/`TEST`/
`SIGNUP`).

**Secciones de la landing**: header (compacto en mobile, N2), hero, el problema (3 dolores), el recorrido
(6 escenas), qué hace por actor (4 actores), confianza (6 garantías en código), impacto (4 metas con
fuente y N + 1 supuesto de piloto sin cifra, todas rotuladas), cómo se integra (+ "qué necesita tu
operación"), qué es real y qué es simulado (las cuatro columnas de `docs/design-brief.md` §7.2 + la nota
de habilitación por etapas), galería con zoom, CTA final (+ "qué puedes hacer hoy en tu demo"), footer —
12 bloques en total.

**Manifiesto de capturas**: 19 entradas (17 de landing — hero-loop más las 6 escenas con sus variantes,
más 6 de galería —, 2 de signup), todas partiendo como `render` construido con componentes y textos
reales, cada una con su reemplazo real nombrado (ruta de consola, viewport, estado del mundo) y ninguna
mostrando una función que el producto no vaya a tener; `gallery-metrics` apunta a "Medición del manual"
(ADR-0023), no a "evaluación".
