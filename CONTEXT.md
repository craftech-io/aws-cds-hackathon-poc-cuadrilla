# Cuadrilla

Copiloto de campo en WhatsApp para instaladores de fibra hasta el hogar (FTTH) de una operadora de internet latinoamericana: el instalador trabaja solo, en el domicilio del cliente y con las manos ocupadas; le escribe o le manda una nota de voz al agente, que lee su orden de trabajo y el estado de la ONU, lo guía con el manual de procedimientos de la operadora (citando la sección), valida las fotos de evidencia, escala al supervisor de turno cuando hace falta, da la instrucción de seguridad del manual ante un riesgo y, al cerrar, emite el acta de instalación. Este glosario fija la palabra que se usa en documentos y textos públicos (español) y el identificador que se usa en código (inglés, entre backticks). Todo dato es sintético; la operadora de la demo es ficticia o, en co-branding, el socio de diseño con políticas y datos inventados (ADR-0018).

## Language

### Organización y personas

**Operadora** (`Isp`, `ispId`):
Empresa proveedora de internet por fibra que usa Cuadrilla; es el tenant. Todo dato (personal, clientes, órdenes, casos, bitácora) pertenece a una operadora y ningún usuario ve otra. En la demo (`isp-demo`) su nombre visible sale en runtime de la configuración de marca (`resolveBrand`): el socio de diseño en co-branding, que es el modo de `poc`, o **Tulvara Fibra** (ficticia) en el modo `neutral` de respaldo; ningún texto estático la nombra; cada mundo de invitado tiene una copia propia (`isp-guest-<nn>`, `isp-guest-test` o, en un alta propia, `isp-guest-s<yymmdd><5>` por generación) y cada escenario de QA una operadora propia (`isp-qa-<runId>-<escenario>`).
_Avoid_: empresa, cliente (el cliente es el del domicilio), carrier, ISP (en textos en español)

**Zona** (`Zone`):
Área geográfica de la operadora con un jefe de zona y una clase óptica de su red (`zone-norte`, `zone-sur`).
_Avoid_: región, plaza

**Equipo de campo** (`Crew`):
Grupo de instaladores de una zona que comparte supervisores por turno (`crew-n3`, `crew-s1`).
_Avoid_: cuadrilla (en minúscula; ver "Flagged ambiguities"), brigada

**Instalador** (`Installer`):
Técnico de campo que instala el servicio en el domicilio del cliente. Habla español de México y usa WhatsApp: texto, notas de voz, fotos y botones. Solo conversa con el agente si su teléfono está en la **lista de permitidos** y tiene **opt-in** vigente.
_Avoid_: técnico (en UI), usuario, operario

**Supervisor de turno** (`Supervisor`, escalón `PRIMARY`):
Supervisor asignado al equipo de campo en el turno de trabajo vigente; primer destinatario de un caso. Recibe plantillas de WhatsApp con los botones "Tomar caso" y "No puedo".
_Avoid_: jefe, coordinador

**Supervisor de respaldo** (`Supervisor`, escalón `SECONDARY`):
Segundo supervisor del mismo turno; recibe el caso cuando el de turno no lo toma a tiempo o responde "No puedo".
_Avoid_: suplente, backup (en UI)

**Jefe de zona** (`ZoneChief`):
Responsable de la zona. Recibe por email (SES) las alertas de seguridad y los casos que ningún supervisor tomó. No usa WhatsApp en la POC.
_Avoid_: gerente, director

**Cliente** (`Customer`):
Titular del servicio en el domicilio de la orden. Sintético en la POC; recibe el acta de instalación por email. Nunca conversa con el agente.
_Avoid_: suscriptor, usuario final, abonado

**Buzón de operaciones** (`opsMailbox`):
Dirección de email de la operadora que recibe copia de cada acta. En la POC apunta al simulador de buzones de SES o a un buzón del equipo registrado.
_Avoid_: mesa de control (como dirección)

**Usuario de consola** (`ConsoleUser`, rol `SUPERVISOR` | `OPS` | `GUEST`):
Persona de la operadora que entra a la consola: `SUPERVISOR` ve y actúa (toma casos, hace la validación manual de evidencia); `OPS` ve y no valida; `GUEST` tiene los permisos de `SUPERVISOR` solo dentro de su propio mundo.
_Avoid_: admin, operador (el operador es la persona de Craftech que despliega)

**Marca de la demo** (`BrandConfig`, `BrandMark`):
Cómo se presenta la operadora de la demo: en co-branding con el socio de diseño ("Cuadrilla for <socio> · Powered by Craftech", con el aviso de demo sintética; modo de `poc` desde el 2026-09-26) o neutral ("Cuadrilla · Powered by Craftech", operadora ficticia por defecto). Es configuración de runtime (secreto `BrandConfig`, logos en `Seed/brand/`): el nombre del socio nunca se escribe en el repo (ADR-0018).
_Avoid_: white label, marca del cliente (suelto)

**Operador** (sin identificador de código):
Persona de Craftech que aplica el bootstrap, carga secretos y crea cuentas. No es un rol del producto.
_Avoid_: operadora (es la empresa)

### Trabajo de campo

**Orden de trabajo** (`WorkOrder`, "OT"):
Instalación asignada a un instalador para un día: número (`workOrderNumber`, 5 dígitos, p. ej. `24817`), cliente, domicilio, plan, ventana de cita, serial de la ONU, puerto de la OLT y clase óptica. Estados (`WorkOrderStatus`): `SCHEDULED`, `IN_PROGRESS`, `CLOSED` (acta emitida), `FAILED_VISIT`, `RESCHEDULED`, `CANCELLED`, `REASSIGNED`.
_Avoid_: ticket, tarea, servicio (como sustantivo de la orden), trabajo

**Orden activa** (`activeWorkOrderId`):
La orden sobre la que el instalador está trabajando; los mensajes del instalador se atribuyen a ella. Pasa a activa con la primera interacción sobre esa orden o cuando el instalador la elige de la lista; nunca la adivina el modelo.
_Avoid_: orden actual (suelto)

**Ventana de cita** (`appointmentWindow`):
Franja horaria acordada con el cliente (p. ej. 09:00-11:00, hora de la Ciudad de México).
_Avoid_: horario, turno

**Plan** (`plan`):
Producto contratado por el cliente ("Fibra 300", ficticio). Cuadrilla no cambia planes ni precios.
_Avoid_: paquete, tarifa

**ONU** (`Onu`, `onuSerial`):
Terminal óptico de red en el domicilio del cliente (también llamado ONT). Se identifica por su serial (p. ej. `DEMO3F2C19A0`, sintético). Modelo genérico, sin fabricante real.
_Avoid_: módem, router (es otra función), ONT (en UI)

**Estado de la ONU** (`OnuStatus`):
Lo que devuelve el orquestador de red para un serial: `operState` (`ONLINE`, `OFFLINE`, `LOS` pérdida de señal, `DYING_GASP` corte de energía, `NOT_PROVISIONED`), potencia recibida (`rxPowerDbm`) y transmitida, puerto de la OLT, última vez visto.
_Avoid_: estado del módem, señal (suelto)

**Clase óptica** (`opticalClass`) y **rango de aceptación** (`acceptanceRange`):
Clase de la red PON de la zona (`B+` o `C+`) y rango de potencia recibida en la ONU que la operadora acepta para cerrar una instalación, con margen sobre la sensibilidad de la clase: `B+` de −8 a −25 dBm, `C+` de −8 a −28 dBm (manual §MED-01). Una lectura fuera de rango no se cierra.
_Avoid_: señal buena/mala, nivel

**Orquestador de red** (`NetworkMock`):
Sistema externo simulado que conoce las ONU y sus estados, detrás de un contrato OpenAPI (`packages/network-contract/openapi.yaml`). No replica a ningún fabricante ni producto real.
_Avoid_: OSS, gestor de red, nombre de un fabricante

**Despacho** (`DispatchMock`):
Sistema externo simulado que asigna, reprograma, reasigna y cancela órdenes, y avisa por eventos al bus `Feeds`.
_Avoid_: CRM, sistema del cliente

**Paso de diagnóstico** (`TroubleshootingStep`):
Acción que el agente le indicó al instalador para resolver un síntoma (p. ej. "limpia el conector de la roseta", §DIAG-02) con su resultado (`FIXED`, `NO_CHANGE`, `WORSE`). Se registra con `record_troubleshooting_step`.
_Avoid_: intento (suelto), prueba

**Intento fallido** (`failedAttempts`):
Conteo, por orden y síntoma, de pasos de diagnóstico con resultado `NO_CHANGE` o `WORSE`, y por ítem del checklist, de fotos rechazadas. Al tercero el código escala sin preguntarle al modelo.
_Avoid_: reintento (es técnico)

**Visita fallida** (`FAILED_VISIT`):
Orden que no se pudo instalar (cliente ausente, domicilio inaccesible, riesgo sin resolver). No produce acta; la reprograma el despacho.
_Avoid_: cancelación (la cancela el despacho, no el instalador)

### Evidencia y cierre

**Checklist de cierre** (`Checklist`):
Ítems que exige el manual para cerrar una instalación (§EVI-01): `ONU_ONLINE` (estado del orquestador), `POWER_READING_PHOTO` (foto de la lectura del medidor), `ONU_LABEL_PHOTO` (foto de la etiqueta de la ONU), `ROSETTE_PHOTO` (foto de la roseta instalada) y `CUSTOMER_OK` (conformidad del cliente declarada por el instalador con un botón). Estados del ítem (`ChecklistItemStatus`): `PENDING`, `IN_REVIEW`, `PASSED`, `REJECTED`, `OVERRIDDEN`.
_Avoid_: lista (suelta), formulario

**Roseta** (`rosette`):
Caja terminal óptica dentro del domicilio donde termina el cable de acometida y se conecta el cordón hacia la ONU.
_Avoid_: toma, caja (suelto)

**Evidencia** (`Evidence`):
Foto que manda el instalador para un ítem del checklist, guardada con su `sha256`, el ítem para el que se pidió y su validación. Una evidencia rechazada se conserva con su motivo.
_Avoid_: adjunto, imagen (suelto)

**Validación de foto** (`PhotoValidation`):
Resultado de la tool `validate_install_photo`: una llamada multimodal aislada cuya única tool es `record_verdict` (sin efectos), con la **rúbrica** versionada y salida estructurada (qué muestra la foto, valores leídos, calidad; si el modelo no llama la tool, `UNSURE`), seguida de chequeos deterministas en código (rango por clase óptica, serial contra la orden, lectura contra el orquestador, foto repetida). Veredicto (`verdict`): `PASS`, `REJECT` o `UNSURE`, con un **motivo de rechazo** accionable.
_Avoid_: aprobación de la foto, OCR

**Rúbrica** (`Rubric`, `RUBRIC#v<nnn>`):
Criterios escritos para validar cada tipo de foto (encuadre, enfoque, reflejo, legibilidad, qué debe verse). Versionada en `Reference`.
_Avoid_: prompt (suelto), reglas del modelo

**Motivo de rechazo** (`RejectReason`):
`BLURRY`, `GLARE`, `CROPPED`, `DARK`, `WRONG_SUBJECT`, `OUT_OF_RANGE_LOW`, `OUT_OF_RANGE_HIGH`, `WRONG_WAVELENGTH`, `SERIAL_MISMATCH`, `READING_MISMATCH`, `DUPLICATE_EVIDENCE`, `UNREADABLE`. Cada uno tiene un texto accionable en `copy/es-MX.ts` ("hay reflejo sobre la etiqueta: inclina el teléfono y apaga el flash").
_Avoid_: error, falla

**Validación manual** (`Override`):
Decisión de una persona con rol `SUPERVISOR` (o `GUEST` en su mundo), desde la consola y con login reciente, que marca un ítem `OVERRIDDEN` con motivo. Es siempre humana: el agente no tiene forma de hacerla.
_Avoid_: aprobación del agente, forzar, bypass

**Acta de instalación** (`Certificate`):
PDF que emite `close_installation` cuando el checklist está completo: datos de la orden, ONU y potencia, ítems con su evidencia y quién los validó, fotos validadas. Se envía por SES al cliente y al buzón de operaciones y por WhatsApp al instalador. Pasa por el filtro de datos personales G3 antes de generarse.
_Avoid_: comprobante, certificado (en UI), reporte

**Entrega del acta** (`CertificateDelivery`):
Estado de cada envío del acta por destinatario, alimentado por los eventos de SES (`DELIVERY`, `BOUNCE`, `COMPLAINT`) y los estados de WhatsApp.
_Avoid_: acuse

### Conocimiento

**Manual de procedimientos** (`Manual`, `v001`):
Documento escrito de cero para la POC, que dice "la operadora" sin nombrar a ninguna (el visor antepone la marca resuelta en runtime), con conocimiento general público de FTTH/GPON (rangos por clase, buenas prácticas de seguridad) y políticas comerciales inventadas. Está en una **Base de conocimiento** de Bedrock (`KnowledgeBase`) sobre S3 Vectors. Es la única fuente con la que el agente responde dudas de procedimiento y de política.
_Avoid_: normativa, reglamento, FAQ

**Sección** (`ManualSection`, id como `COM-04`):
Unidad citable del manual; cada archivo del manual es una sección con su id, título y versión en los metadatos.
_Avoid_: artículo, capítulo

**Cita** (`Citation`):
Referencia a la sección que funda una respuesta ("Manual v1, §COM-04"). Toda respuesta de política o procedimiento lleva al menos una, tomada del resultado de `search_procedures` del mismo turno.
_Avoid_: fuente (suelta), link

**Fuera del manual** (`OUT_OF_MANUAL`):
Pregunta que el manual no responde. El agente lo dice, no inventa y ofrece escalar al supervisor.
_Avoid_: no sé (como estado)

**Tema denegado** (`DeniedTopic`):
Tema que el agente nunca responde, bloqueado por el guardrail G1: cambios de precio o promociones, bonificaciones o compensaciones al cliente, instrucciones eléctricas fuera del manual.
_Avoid_: tema prohibido (en UI)

**Set de medición** (`EvalSet`, corridas `EV-01` y `EV-02`):
50 preguntas escritas de cero sobre el manual (40 respondibles con la sección esperada, 10 fuera de alcance o riesgosas) y 60 fotos sintéticas etiquetadas, con las que se miden las métricas del agente. En la consola y la landing se llama **medición** ("Medición del manual", "Medición de fotos"); los identificadores internos (`EV-01`, `EvalResult`, `eval-<runId>`) no se muestran nunca (ADR-0023).
_Avoid_: evaluación (en superficies visibles), dataset de pruebas (suelto), benchmark

### Casos y seguridad

**Caso** (`Case`, `kind` `ESCALATION` | `SAFETY`):
Pedido de ayuda humana sobre una orden, con motivo (`CaseReason`: `OUT_OF_MANUAL`, `DIAGNOSIS_ATTEMPTS`, `PHOTO_ATTEMPTS`, `INSTALLER_ASKED`, `NOT_PROVISIONED`, `DENIED_TOPIC`, `PROMPT_INJECTION`, `SAFETY`, `CERTIFICATE_UNDELIVERED`, `OTHER`), resumen verificado y fotos de la orden. Estados (`CaseStatus`): `OPEN`, `TAKEN`, `CLOSED`.
_Avoid_: ticket, incidente, alerta (la alerta es un email)

**Escalera** (`EscalationLadder`) y **escalón** (`rung`):
Secuencia fija de destinatarios de un caso abierto: `PRIMARY` (supervisor de turno) → `SECONDARY` (supervisor de respaldo) → `ZONE_CHIEF` (email al jefe de zona). Cada escalón tiene un **vencimiento** (`CASE_TIMEOUT`): 10 minutos simulados, 60 segundos en **modo demo**. Un escalón sin canal alcanzable se salta con motivo.
_Avoid_: cadena, flujo de escalamiento

**Tomar caso** (`take`) y **No puedo** (`decline`):
Botones del supervisor. Tomar pone el caso `TAKEN` a su nombre (gana el primero; los demás reciben "Ya lo tomó …"); No puedo pasa al escalón siguiente sin esperar el vencimiento.
_Avoid_: aceptar, rechazar

**Reasignación** (`caso_reasignado`):
Paso del caso al supervisor de respaldo por vencimiento o por "No puedo".
_Avoid_: derivación

**Alerta al jefe de zona** (`ZONE_CHIEF_ALERT`):
Email por SES al jefe de zona cuando nadie tomó el caso en los dos escalones, o inmediatamente ante un riesgo de seguridad.
_Avoid_: notificación (suelta), SMS

**Puente** (`Bridge`):
Mientras un caso está `TAKEN`, los mensajes del instalador sobre esa orden van al supervisor y los del supervisor al instalador, sin pasar por el modelo; el agente no toma turnos de esa orden hasta que el caso se cierra. La **respuesta del supervisor** se entrega como texto si la ventana del instalador está abierta, o con la plantilla `respuesta_supervisor` si no.
_Avoid_: chat humano, handoff (en UI)

**Riesgo de seguridad** (`SafetyHazard`):
Situación con peligro para el instalador o terceros (cable de energía pelado o caído, chispas, poste inclinado, tormenta eléctrica, trabajo en altura inseguro). La detecta primero el **clasificador de seguridad** (`SafetyClassifier`, determinista, por léxico) y, si no, el agente con `report_safety_hazard`. Dispara la **instrucción de seguridad** fija del manual (§SEG-01: no tocar, alejarse, señalizar, avisar) y, en paralelo, el caso `SAFETY` al supervisor y la alerta al jefe de zona.
_Avoid_: emergencia (no somos un servicio de emergencias), accidente

### Canales y contacto

**Canal** (`Channel`):
`WHATSAPP` (instaladores y supervisores), `EMAIL` (jefe de zona, cliente, buzón de operaciones; solo salida) y la consola (`CONSOLE`, nunca canal de envío). Sin SMS, RCS ni voz.
_Avoid_: medio, vía

**Transportes y modo de canal** (`ChannelModes`, `whatsappMode`):
El stage declara qué transportes de WhatsApp existen (`ChannelModes.whatsapp.transports`: `simulated` y, con la cuenta de WhatsApp Business conectada, `live`); cada **mundo** tiene su modo (`Isps/SETTINGS.whatsappMode`): `live` solo para el **mundo vivo** (uno solo, el del operador), `simulated` para invitados, QA y evaluación. El transporte de cada envío lo decide el destinatario (teléfono real → vivo; identidad sintética → simulado). Email corre `live`. El modo cambia el transporte, nunca el flujo.
_Avoid_: feature flag, modo prueba, "pasar todo a vivo"

**Mundo vivo** (`liveWorldClockId`):
El único mundo cuyos teléfonos reales (del equipo, por `SeedOverrides`) reciben WhatsApp de verdad. Lo fija el operador; los mundos de invitado nunca lo son.
_Avoid_: producción

**Alta por código** (`PhoneLease`, `JOINCODE#`):
Con el canal vivo, un invitado liga su propio teléfono a una persona de su mundo mandando por WhatsApp el código de un solo uso que ve en su consola ("ALTA G07-4F2K"); dura 48 h y un teléfono solo puede estar ligado a un mundo.
_Avoid_: registro manual, whitelist del invitado

**Lista de permitidos** (`allowList`):
Teléfonos registrados en `People` de instaladores y supervisores activos de la operadora. Un número fuera de la lista recibe a lo sumo una respuesta fija por día y nunca llega al agente.
_Avoid_: whitelist

**Opt-in** (`Consent` `WHATSAPP_OPT_IN`) y **ALTA**:
Consentimiento de una persona de la lista de permitidos para recibir mensajes de Cuadrilla; se registra cuando envía "ALTA" (desde el QR del póster de alta, con la versión del texto mostrado). **BAJA** lo revoca.
_Avoid_: suscripción, registro (suelto)

**Ventana de 24 h** (`serviceWindow`):
Período desde el último mensaje de la persona en el que WhatsApp admite texto libre e interactivos. Fuera de la ventana solo salen **plantillas** aprobadas. Para una identidad sintética se mide con el reloj del mundo; para un teléfono real (mundo vivo o ligado por código a un mundo de invitado) con el reloj real y el último entrante real (`lastInboundAtReal`), porque Meta la mide así.
_Avoid_: sesión, conversación abierta

**Plantilla** (`Template`):
Mensaje de WhatsApp preaprobado por Meta, categoría `UTILITY`, idioma `es_MX`, con parámetros y botones: `ordenes_del_dia`, `caso_escalado`, `caso_reasignado`, `alerta_seguridad`, `respuesta_supervisor`, `acta_instalacion`.
_Avoid_: template (en UI), mensaje predefinido

**Plan B "TURNO"** (`shiftWindow`):
Si Meta demora o rechaza la plantilla de escalamiento, el supervisor envía "TURNO" al empezar su turno de trabajo: eso abre su ventana de 24 h y los casos le llegan como mensaje interactivo con los mismos botones. Análogo para el instalador: "ÓRDENES" pide la lista del día sin plantilla.
_Avoid_: modo degradado

**Nota de voz** (`VoiceNote`) y **transcripción** (`Transcript`):
Audio de WhatsApp (Ogg/Opus) que se transcribe con Amazon Transcribe en `es-MX` con un vocabulario propio de términos FTTH; el agente recibe el texto y su confianza, nunca el audio.
_Avoid_: audio (suelto), dictado

**Número de la POC** (`WhatsAppPhoneNumberId`, `WhatsAppMetaPhoneNumberId`):
El número de WhatsApp de Cuadrilla, que EUM Social identifica de dos formas: el **id de AWS** (`phone-number-id-<32 hex>`), que sirve para enviar, bajar y subir media y en IAM, y el **id de Meta** (numérico), que es el que traen los eventos (`metadata.phone_number_id`, `MetaPhoneNumberIds`). Es un número **nuevo**, con una WABA propia, solo de Cuadrilla; su alta de Meta la hace el CTO al final del build (P-01, ADR-0028). Todo evento cuyo id de Meta no sea el nuestro (otra POC que comparta la cuenta de WhatsApp Business o el topic) es un **evento ajeno** y se descarta antes de leer su contenido. Nunca se filtra con el id de AWS.
_Avoid_: línea, "el phone number id" (sin decir cuál)

**Política de contacto** (`ContactPolicy`, reglas `CP-*`):
Reglas en código que deciden si un mensaje sale, cuándo y por dónde: lista de permitidos, opt-in, ventana de 24 h, plantilla aprobada, horario de silencio, roster de supervisores, cerco de destinatarios, evidencia completa para el acta. Nunca en el prompt.
_Avoid_: reglas del bot

**Horario de silencio** (`quietHours`):
21:00-07:00 America/Mexico_City: ningún mensaje proactivo al personal salvo seguridad y casos en curso; las respuestas a un mensaje entrante están exentas.
_Avoid_: fuera de horario (suelto)

**Cerco de destinatarios** (`RecipientFence`):
Regla por mundo dentro del único cliente de SES, reforzada por IAM y al escribir una persona: en mundos de invitado, QA y evaluación solo se envía a `*@simulator.amazonses.com`; los destinatarios de demo registrados en el secreto `SeedOverrides` valen solo en el mundo vivo o de demo del operador; nunca a nuestro propio dominio (no tiene buzones), nunca a dominios reservados.
_Avoid_: allowlist de emails

**Violación de política** (`PolicyViolation`):
Mensaje enviado sin una decisión `ALLOW` registrada, o que la política, reevaluada después con los datos de ese momento, habría denegado. La meta es cero.
_Avoid_: error de envío

### Agente

**Agente** (`Agent`):
El Harness de AgentCore que decide qué hacer ante cada evento de un instalador, usando tools. Habla **solo** por `send_whatsapp`; el texto final de su turno es una **nota del turno** (`turnNote`) interna.
_Avoid_: bot, asistente virtual, IA

**Turno del agente** (`Turn`):
Una invocación del Harness disparada por un evento (`TurnTrigger`: `INSTALLER_MESSAGE`, `ORDERS_REQUESTED`, `CASE_CLOSED`, `WORK_ORDER_CHANGED`, `EVIDENCE_OVERRIDDEN`). Los turnos de un instalador corren de a uno, en orden (cola FIFO por instalador).
_Avoid_: turno (suelto; ver "Flagged ambiguities"), ejecución, request

**Lectura precargada** (`turns/preload.ts`, `<tool-result>`):
Lectura que todo turno necesita (la orden en curso, su checklist y, en un mensaje del instalador, sus últimas diez órdenes) que el worker corre en código con el token del turno **antes** de invocar el Harness y pone en el sobre como `<tool-result tool="…">` escapado. Pasa los mismos controles que una tool y respalda a G2 igual; el modelo no la vuelve a pedir (ADR-0028).
_Avoid_: caché, contexto (suelto), prefetch

**Responder siempre** (`ALWAYS_ANSWER`):
Regla del system prompt: todo mensaje del instalador recibe en su turno un `REPLY` o un escalamiento; un saludo o un "ok" reciben el estado breve de su orden. Le gana a cualquier conclusión anterior de la conversación o de la memoria (ADR-0028).
_Avoid_: cortesía, small talk (como categoría aparte)

**Pregunta fija de estado** (`groundingQuery`):
La pregunta con la que G2 mide la relevancia de una respuesta cuando el mensaje del instalador no pregunta nada (hasta tres palabras y sin "?"): "¿Cómo va mi orden y qué me falta?". No es un texto visible (ADR-0028).
_Avoid_: pregunta por defecto

**Envío repetido** (`outbound/repeat.ts`, `replayOf`):
Un `send_whatsapp` igual a otro del mismo turno y canal (mismo texto, o misma plantilla con los mismos parámetros); el pipeline lo contesta con el mensaje ya enviado y no sale nada (ADR-0028).
_Avoid_: duplicado (es el del evento reentregado), reintento

**Perfil de inferencia de la app** (`<app>-<stage>-sonnet-5-5`):
Perfil de inferencia de Bedrock con los tags del proyecto que copia el perfil global del modelo; el Harness, Memory y el validador de fotos llaman por su ARN. Su nombre lleva el modelo, así un cambio de modelo crea uno nuevo antes de borrar el viejo (ADR-0028).
_Avoid_: modelo (cuando se habla del ARN), endpoint

**Techo global y corte** (`CostCaps`, `KILL#`):
Topes de costo del stage por día real para todos los mundos que no son QA ni evaluación (turnos, validaciones, minutos de transcripción), además de los del mundo y la operadora; y el **corte** de emergencia en runtime (`KILL#ALL`, `SIMULATOR`, `AGENT`) que detiene el gasto sin deploy. La seguridad física nunca se corta (ADR-0019).
_Avoid_: kill switch de Cedar (es la segunda capa), apagar el stack

**Consejo** (`tip`):
Recordatorio breve que el agente da a un instalador según sus errores recurrentes ("tus últimas fotos de etiqueta tuvieron reflejo: apaga el flash"), sacado de la memoria de largo plazo del instalador y del perfil medido (`InstallerProfile`).
_Avoid_: regaño, feedback

### Acceso, invitados y leads

**Invitado** (`GUEST`, `isGuest`, `GuestOrigin` `INVITED` | `SIGNUP` | `TEST`):
Persona que prueba la demo en su propio mundo, con los permisos de `SUPERVISOR` solo dentro de él (ADR-0024). `INVITED`: cuentas `guest-NN` que crea el operador (credenciales solo por vía privada); `SIGNUP`: alta propia con email verificado; `TEST`: `guest-test`, el ensayo del operador y el principal `usr-qa-guest` del ejecutor. Los roles internos (`SUPERVISOR`, `OPS`) nunca nacen de un alta propia.
_Avoid_: jurado, juez, evaluador, judge (en código, datos y superficies visibles), demo user

**Alta propia** (`signup`):
Creación de una cuenta de invitado desde `/signup`: formulario, **ticket de alta**, `SignUp` de Cognito, **código de verificación** por email y confirmación (ADR-0025). Cada alta confirmada es un **lead**.
_Avoid_: registro (suelto; ver "Flagged ambiguities"), onboarding

**Ticket de alta** (`signupTicket`):
Credencial de 10 minutos que emite `signup.start` después de validar el formulario, los consentimientos, el dominio del email y los límites; está ligada al email y al usuario `gst-<ULID>` que genera el mismo `signup.start`, y sirve a lo sumo dos veces para ese usuario. El trigger pre-sign-up rechaza todo `SignUp` sin uno válido para ese email y ese usuario.
_Avoid_: token de alta, captcha

**Encabezado de origen** (`x-cuadrilla-origin`, secreto `OriginVerifyKey`):
Valor secreto que CloudFront agrega a todo pedido que manda al BFF; el BFF rechaza con `403`, antes de leer nada, un pedido que no lo trae. Es lo que hace del borde (WAF incluido) la única entrada al BFF y lo que permite confiar en la IP de `CloudFront-Viewer-Address` (ADR-0025 §3).
_Avoid_: token, API key

**Clave de abuso** (`abuseHash`):
Hash de una forma reducida del email (sin etiqueta `+…` ni puntos de Gmail) con la que se cuentan los límites del alta por persona y las cuentas por persona. No reemplaza al email del lead, que se guarda tal como lo escribió el visitante.
_Avoid_: email normalizado (suelto)

**Corte del alta** (`KILL#SIGNUP`):
Alcance del corte de emergencia (ADR-0019) que frena las altas nuevas y el envío de códigos cuando los emails de autenticación rebotan o reciben quejas, o ante una ráfaga de altas; lo enciende y lo apaga el operador (`npm run ops:kill`; sin alarmas desde P-07). Protege la reputación de SES de la cuenta compartida.
_Avoid_: bloqueo, mantenimiento

**Mundo de invitado** y **generación** (`isp-guest-s<yymmdd><5>`):
Mundo sembrado desde la plantilla `guest` que pertenece a una sola cuenta de invitado. En un alta propia, cada creación es una **generación** con operadora y reloj nuevos; la generación vigente se guarda en `Runtime/GUESTACCOUNT#<userId>`.
_Avoid_: sandbox, tenant, copia

**TTL del mundo de invitado**:
Vida de una generación de un alta propia: 7 días reales desde su creación. Al vencer, la cuenta y el lead siguen; en el ingreso siguiente se crea una generación nueva. Los mundos `INVITED` no tienen TTL durante la ventana de sus cuentas.
_Avoid_: expiración de la cuenta

**Portada del invitado** (`/app/home`, `guest.world`):
Primera vista después del login de un invitado: estado de su mundo (`PROVISIONING`, `READY`, `CAP_FULL`), qué tiene sembrado, qué partes de la consola están habilitadas y, solo para un invitado de alta propia, cuándo vence su mundo y "Borrar mi cuenta".
_Avoid_: dashboard, home

**Lead** (`Lead`, tabla `Leads`):
Registro de contacto de una persona que inició (lead **pendiente**, `PENDING`: sin `status`, vence a los 7 días) o confirmó (`CONFIRMED`) un alta propia: email, nombre, empresa y cargo si los dio, idioma, consentimientos, origen y fechas (ADR-0026). Vive en una tabla propia, separada de los datos de la demo; nunca aparece en logs, bitácoras ni exportaciones de la demo. Un lead pendiente lista sus **usuarios pendientes** (`pendingUsernames`), los usuarios de Cognito sin confirmar que guardan su email, para poder borrarlos.
_Avoid_: cliente (es el del domicilio), contacto (suelto), usuario

**Consentimiento del alta** (`TERMS_PRIVACY`, `CONTACT`):
Aceptación explícita, separada y sin tildar por defecto, guardada con fecha, versión del texto e idioma: términos y privacidad (obligatorio) y "Acepto que Craftech me contacte por esta solución" (opcional).
_Avoid_: opt-in (es el de WhatsApp), aceptación (suelta)

**Aviso de lead** (`LeadStream`, `LeadConfig`):
Email por SES a las casillas `@craftech.io` de la configuración `LeadConfig` por cada lead confirmado, con su propio cerco (solo `@craftech.io`), distinto del cerco de destinatarios de la demo. Hoy, la casilla del CTO (ADR-0027), nunca escrita en el repo.
_Avoid_: notificación (suelta), alerta

**Responsable de los leads** (ADR-0027):
Quien responde por los datos de los leads ante la Ley 25.326: Craftech, Ciudad Autónoma de Buenos Aires; los derechos se ejercen en sales@craftech.io (o por `https://craftech.io/contact/`). El aviso de privacidad lo nombra sin datos que el CTO no dio.
_Avoid_: dueño de los datos, contacto de privacidad (suelto)

**Superficie visible** y **guard de superficies neutrales** (`lint:neutral-surfaces`):
Todo texto que puede leer o escuchar una persona fuera del equipo (landing, alta, consola, legales, emails, PDF, plantillas, textos del seed que ve un usuario, build y el README antes de `## Submission notes`). Ninguna nombra el concurso ni a sus evaluadores; el guard lo verifica en CI (ADR-0023).
_Avoid_: UI (suelto)

**Costura de QA** (`auth.confirmQaSignup`, `npm run qa:confirm-signup`):
Confirmación administrativa de un alta sin leer el código, permitida solo para usuarios cuyo email en Cognito (leído con `AdminGetUser`, nunca tomado del pedido) es `success+qa-…@simulator.amazonses.com`, y auditada; la usan el ejecutor de escenarios y las verificaciones desplegadas. No inicia altas: el inicio (`signup.start`) siempre va por el camino público, también en `SC-20`.
_Avoid_: bypass, backdoor

### Tiempo y mundos

**Reloj de demo** (`DemoClock`, `clockId`):
Tiempo simulado de un mundo. Por defecto **en pausa** (`PAUSED`): la hora solo se mueve con los controles ("Iniciar el día", "Avanzar al próximo evento", "+10 min", "+1 h", "Forzar vencimiento"), que disparan en orden los temporizadores vencidos. **Reloj en vivo** (`RUNNING`) lo hace correr en tiempo real por 30 minutos. Toda regla de negocio lee el reloj del mundo, nunca `Date.now()`.
_Avoid_: tiempo falso, mock de fecha

**Temporizador** (`Timer`, `TIMER#<kind>#<id>`):
Todo lo que tiene que pasar a una hora simulada: inicio del día (`DAY_START`, uno por instalador activo; el disparo planifica el día siguiente), vencimiento de un escalón (`CASE_TIMEOUT`), envío diferido por horario (`DEFERRED_SEND`), reintento de entrega del acta (`CERT_RETRY`). La consola lo muestra como **pendiente** con su motivo.
_Avoid_: job, cron

**Modo demo** (`settings.demoMode`):
Ajuste del mundo que acorta el vencimiento de cada escalón a 60 segundos **solo mientras el reloj corre en vivo**, para que un invitado vea la escalera completa en tiempo real; con el reloj en pausa rige el vencimiento normal (10 minutos simulados), un temporizador más que "Avanzar al próximo evento" alcanza.
_Avoid_: modo rápido

**Mundo** (`World`):
Conjunto de datos con su reloj: la demo de la operadora (`GLOBAL#isp-demo`, que puede ser el mundo vivo), el **mundo de invitado** (`GUEST#isp-guest-<nn>` de un invitado `INVITED`, creado en su primer login; `GUEST#isp-guest-s…` de un alta propia, creado al confirmar el email; los dos desde la plantilla curada `guest`), los mundos del ejecutor de escenarios (`qa-<runId>-<escenario>`, cada uno con su operadora) y los de la evaluación (`eval-<runId>`). Reiniciar uno no toca a otro. Un teléfono es único **dentro de un mundo**: la misma persona sintética existe en muchos mundos.
_Avoid_: sandbox, tenant

**Época** (`worldEpoch`):
Número del reloj que sube en cada reinicio, recarga del seed y mundo nuevo, y nunca vuelve atrás; separa la memoria del agente de un mundo de la del anterior.
_Avoid_: versión

**Mundo ocupado** (`WORLD_BUSY`):
Estado de un mundo mientras un turno del agente, una transcripción, una validación de foto, un evento en cola o un email esperando su primer evento de SES siguen en curso. La consola no mueve el reloj hasta que el mundo está **quieto**.
_Avoid_: bloqueado

### Superficies y pruebas

**Consola** (`Console`):
Web de la operadora detrás de login propio sobre Cognito: órdenes del día, detalle de la orden, casos, revisión de evidencia, personal, reloj de demo, simulador de teléfono, buzón de salida, manual, métricas, bitácora.
_Avoid_: backoffice, panel

**Simulador de teléfono** (`PhoneSimulator`):
Vista de la consola, rotulada "simulador", que hace de teléfono de un instalador, de un supervisor o de un número desconocido en todo mundo simulado, aunque el stage tenga el canal vivo: entra por el mismo normalizador que el evento real (texto, botones, notas de voz y fotos) y muestra lo saliente como WhatsApp.
_Avoid_: chat de prueba, emulador

**Buzón de salida** (`Outbox`):
Vista de la consola con cada email que Cuadrilla envió (acta, alertas) tal como salió, con sus eventos de SES. Reemplaza a un buzón de entrada: Cuadrilla no recibe email.
_Avoid_: bandeja de entrada, inbox

**Ejecutor de escenarios** (`ScenarioRunner`) y **`QaDriver`**:
Script que recorre los flujos del catálogo contra el stage desplegado, solo con IAM y sin credenciales humanas, a través de la Lambda `QaDriver` (con principales armados en el servidor, incluido uno `GUEST`), y asierta sobre estado persistido y bitácora. Cada paso es `det` (determinista, pasa 3 de 3) o `agent` (depende del modelo, se acepta con oráculo en ≥ 2 de 3); un paso que mezcla segmentos se divide en **partes** (`SC-18/4.a`, `SC-18/4.b`, …), cada una con su tipo, sus flujos y su dependencia, evaluadas por separado.
_Avoid_: bot de pruebas

**Recorrido guiado** (`Tour`):
Pasos del invitado sobre la historia principal (orden 24817 y siguientes de Rogelio), con un botón por paso, "Saltar a escena" y glosa en inglés; tiene un recorrido **exprés** (~5 min) y uno **completo** (~15 min); la misma fuente genera la sección "Guided tour" del README y el escenario `SC-18`.
_Avoid_: tutorial

### Métricas

**Resuelta sin escalar con cita correcta** (`answeredWithCitation`):
Pregunta respondible del set de evaluación contestada sin abrir un caso y citando la sección esperada. Meta ≥ 70 % de 40.
_Avoid_: precisión del bot

**Escalada sin inventar** (`escalatedNoInvention`):
Pregunta fuera de alcance o riesgosa del set que terminó en uno de sus resultados aceptados (caso, bloqueo de G1, oferta de escalar aceptada, respuesta citada sin cifras, negativa) sin ninguna afirmación de política en el texto saliente. Meta 100 % de 10.
_Avoid_: rechazo

**Exactitud de validación** (`photoAccuracy`) y **falsos positivos** (`falseAccepts`):
Exactitud (accuracy): proporción de fotos del set cuyo veredicto coincide con su etiqueta (meta ≥ 90 %); se informan además la precisión y la cobertura (recall) de `PASS`, y aparte la cantidad de fotos que debían rechazarse y se aceptaron, con cero aceptadas fuera de rango y cero adversarias.
_Avoid_: "precisión" para la exactitud (son métricas distintas)

**Tiempo a primera respuesta** (`firstReplyLatency`):
Desde el mensaje entrante hasta el primer saliente del agente: meta < 30 s en texto y < 45 s en voz (p95); se informa también la p50. El acuse de lectura con "escribiendo…" no cuenta como respuesta.
_Avoid_: tiempo de respuesta (suelto)

**Costo por conversación** (`costPerConversation`):
Bedrock (Harness y validaciones), AgentCore, Transcribe, WhatsApp (valorizado como vivo y rotulado en modo simulado) y SES de una orden, por las tarifas de `RateCard`.
_Avoid_: precio

## Relationships

- Una **Operadora** tiene **Zonas**; cada zona tiene un **Jefe de zona**, una clase óptica y **Equipos de campo**.
- Un **Equipo de campo** tiene **Instaladores** y, por turno de trabajo, un **Supervisor de turno** y un **Supervisor de respaldo** (roster).
- Un **Instalador** tiene un **Opt-in** (vigente o revocado), un perfil medido y cero o más **Órdenes de trabajo** por día; a lo sumo una es la **orden activa**.
- Una **Orden de trabajo** tiene exactamente un **Cliente**, una **ONU**, un **Checklist de cierre** con cinco ítems, cero o más **Pasos de diagnóstico**, cero o más **Evidencias** (cada una con su **Validación**), cero o más **Casos** y, si se cerró, un **Acta**.
- Un **Caso** pertenece a una orden y recorre la **Escalera**; mientras está tomado abre un **Puente**.
- Un **Invitado** de alta propia tiene exactamente una cuenta de Cognito, un **Lead** y, a lo sumo, una **generación** vigente de su **Mundo de invitado**; un invitado `INVITED` tiene su mundo y ningún lead.
- Un **Turno del agente** pertenece a un instalador y, si hay orden activa, a su sesión de memoria de esa orden.

## Example dialogue

> **Supervisora (consola):** "¿Cómo va la 24817 de Rogelio?"
> **Consola:** "ONU en línea con −21,4 dBm (clase B+, rango −8 a −25). Checklist: lectura del medidor **validada**, etiqueta de la ONU **rechazada** una vez por reflejo y **validada** en la segunda foto, roseta **validada**, conformidad del cliente pendiente."
> **Supervisora:** "¿Preguntó algo del cobro?"
> **Consola:** "Sí: si la roseta en otro cuarto se cobra. El agente respondió con el manual §COM-04: hasta 15 m de cable dentro del domicilio sin costo; más, cargo de extensión en la siguiente factura, y el instalador nunca cobra en sitio."
> **Supervisora:** "¿Y si la foto de la etiqueta hubiera fallado tres veces?"
> **Consola:** "Se abre un caso `PHOTO_ATTEMPTS` y te llega `caso_escalado`. Si no lo tomas en 10 minutos pasa a Héctor; si él tampoco, se le avisa por email a Marisol, la jefa de zona. La validación manual de la foto la haces tú desde la consola; el agente no puede."

## Flagged ambiguities

- "Cuadrilla" es el nombre del producto y, en el habla de campo, un equipo de instaladores: se resolvió que en documentos y UI el grupo de instaladores es **equipo de campo** (`Crew`) y "Cuadrilla" con mayúscula es siempre el producto.
- "Turno" se usó para el turno de trabajo del supervisor y para la invocación del agente: en textos al personal y en la UI, "turno" es el **turno de trabajo** (palabra clave "TURNO", "supervisor de turno"); en documentos técnicos la invocación es siempre **turno del agente** (`Turn`), nunca "turno" suelto.
- "Aprobar" se usó para fotos y para el cierre: se resolvió que una foto se **valida** (el validador) o se **valida manualmente** (una persona, `Override`); el agente nunca aprueba nada y la orden se **cierra** con el acta.
- "Operador" y "operadora": la **operadora** es la empresa de internet (tenant); el **operador** es la persona de Craftech que despliega. En código solo existe `Isp`.
- "Alerta" se usó para el caso de seguridad y para el email: el **caso** `SAFETY` es el registro; la **alerta al jefe de zona** es el email que ese caso produce.
- "Precisión" se usó para la coincidencia de veredictos con las etiquetas: se resolvió que esa métrica es la **exactitud** (accuracy) y que "precisión" y "cobertura" se reservan para las de `PASS`.
- "Phone number id" se usó para dos cosas distintas: el **id de AWS** del número (envíos, media, IAM) y el **id de Meta** (eventos); siempre se dice cuál.
- "Alta" nombraba cuatro cosas: el opt-in de WhatsApp ("ALTA"), el alta de una persona en la consola, el alta por código de un teléfono real y la cuenta que crea un visitante. Se resolvió: **opt-in** o "ALTA" para WhatsApp, **alta de persona** en la consola, **alta por código** para el teléfono ligado y **alta propia** para la cuenta de invitado.
- "Consentimiento" se usa para el opt-in de WhatsApp (`Consent WHATSAPP_OPT_IN`) y para los del alta (`TERMS_PRIVACY`, `CONTACT`): se dice siempre cuál; el del alta vive en el lead, nunca en `People`.
- "Invitado" (el rol `GUEST`) e "invitación" (cómo nacen las cuentas `INVITED` y los roles internos): un invitado puede venir de una invitación o de un alta propia.
- "Evaluación" era el set con el que se mide el agente y también el contexto del concurso: en superficies visibles es **medición**; en docs internos, `EV-01`/`EV-02` y "set de medición".
- "Modo vivo" se usó para todo el stage: se resolvió que el stage tiene **transportes** y cada **mundo** tiene su modo; solo el mundo vivo es `live`.
