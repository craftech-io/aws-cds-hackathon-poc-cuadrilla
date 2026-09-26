---
status: accepted
---

# Las esperas de la escalera son temporizadores del reloj del mundo con EventBridge Scheduler, no Step Functions

Un caso espera que el supervisor de turno lo tome (10 minutos; 60 segundos en modo demo), después al de respaldo, y si nadie lo toma alerta al jefe de zona. El brief pedía elegir entre Step Functions con task tokens y EventBridge Scheduler. Decidimos que cada vencimiento sea un **temporizador** `Cases/TIMER#CASE_TIMEOUT#<rung>` con `dueAtSim` en el reloj del mundo, con a lo sumo un schedule `at()` de EventBridge Scheduler cuando el mundo corre en tiempo real, y que la escalera sea una máquina de estados determinista en código (`cases/ladder.ts`) con escrituras condicionales sobre `rungVersion`, serializada por la cola FIFO del instalador dueño del caso.

## Considered options

- **Step Functions Standard con `.waitForTaskToken`** por escalón: el botón "Tomar caso" haría `SendTaskSuccess` y el vencimiento sería el `TimeoutSeconds` del Task. Buena semántica de "esperar a una persona" y un grafo visible, pero el timeout de Step Functions es tiempo real: un mundo con el reloj en pausa (el de cada jurado) necesitaría un segundo mecanismo para vencer por el reloj de demo, "Forzar vencimiento" sería un `SendTaskFailure` artificial, y arrastra la lección del scaffolding (SST 4 serializa el timeout de un Task como `Timeout` en lugar de `TimeoutSeconds` y la máquina falla con `SCHEMA_VALIDATION_FAILED`, lo que obliga a un `transform`).
- **Step Functions solo como contenedor, con el vencimiento por temporizador**: dos mecanismos para lo mismo.
- **Temporizadores del reloj del mundo + Scheduler** (elegida): un solo mecanismo para inicio del día, vencimientos, envíos diferidos y reintentos, que "Avanzar al próximo evento" y "Forzar vencimiento" alcanzan igual que el tiempo real; probado localmente sin AWS (`LF`) y con el Scheduler real en `poc` (`SC-06/9`).

## Consequences

- Sin Step Functions en esta POC; si se agrega una, el `transform` `Timeout` → `TimeoutSeconds` del scaffolding viene con ella (`docs/architecture.md` §16).
- En un mundo en tiempo real, solo un temporizador ya vencido se encola directo; uno que vence en segundos igual tiene su schedule `at()` (las colas FIFO no admiten demora por mensaje), y el worker reevalúa `dueAtSim` y lo reprograma si todavía no venció. El de 60 s del modo demo entra por schedule y su precisión se mide en `SC-06/9` (tope 150 s reales).
- La consola dibuja la escalera desde `Case.ladder[]` (lo que un grafo de Step Functions habría mostrado).
- El rol de CI cerca el grupo de schedules por nombre; los principales que arman temporizadores tienen la capacidad `TIMERS`.
