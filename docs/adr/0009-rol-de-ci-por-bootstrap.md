---
status: accepted
---

# El rol de deploy de CI y el rol de QA nacen de un template de CloudFormation aplicado una vez, fuera de SST

GitHub Actions asume un rol por OIDC para correr `sst deploy --stage poc`, así que ese rol tiene que existir antes del primer deploy, y la cuenta `craftech-demos` es compartida. Decidimos, como en el scaffolding, que el rol `aws-cds-hackathon-poc-cuadrilla-github-deploy`, sus políticas administradas, la boundary `…-ci-boundary`, el rol `…-qa-runner`, el key-value store del Router y la response headers policy nazcan de `infra/bootstrap/ci-role.yaml`, que el operador aplica una vez, y que SST no gestione ninguno.

## Considered options

- **Que SST cree el rol**: el primer deploy saldría de una laptop con credenciales de administrador y el rol podría ampliarse a sí mismo.
- **Reusar un rol compartido**: alcanzaría recursos de la otra POC.
- **Crearlo a mano**: no reproducible.

## Consequences

- Orden de deploy con un paso previo del operador (`docs/architecture.md` §15).
- Trust con `StringEquals` sobre el `sub` en sus dos formas, claims numéricos y `job_workflow_ref`; jobs sin `environment:`.
- Cercas por tag `sst:app`, nombre, path IAM y ARN; ninguna acción de receipt rules de SES; vector bucket cercado por `kb-<app>-*`. Las acciones de Transcribe con solo `*` (sin tipo de recurso en el Service Authorization Reference) son `CreateVocabulary`, `TagResource`, `UntagResource`, `ListTagsForResource` y `StartTranscriptionJob`. En el rol de CI y en la boundary van con `Resource *`: `CreateVocabulary`/`TagResource` con `aws:RequestTag/Project = aws-cds-hackathon-poc-cuadrilla`, `TagResource`/`UntagResource` con `ForAllValues:StringEquals aws:TagKeys` limitado a las claves de tags del app, y `ListTagsForResource` sin condición (el provider la llama justo después de `CreateVocabulary` y en cada refresh; si se cercara por ARN, el primer deploy fallaría con el vocabulario ya creado). `Get/Update/DeleteVocabulary` sí admiten ARN y van por `vocabulary/cuadrilla-poc-*`; el rol de CI lee el archivo del vocabulario (`s3:GetObject` de `Seed/transcribe/*`). `ci-role.test.ts` acepta con `*` exactamente esa lista y ninguna otra acción.
- Ningún rol de CI ni del app recibe `social-messaging:PutWhatsAppBusinessAccountEventDestinations` ni acciones de asociación de WABA; `SendWhatsAppMessage` y la media se cercan al parámetro `WhatsAppPhoneNumberArn` (vacío por defecto; se carga con el transporte vivo, P-01), nunca a `phone-number-id/*`.
- Límites: 51.200 bytes el template, 6.144 caracteres cada política; `ci-role.test.ts` los controla.
