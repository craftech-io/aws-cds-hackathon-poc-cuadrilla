// Stub created by WP-02 (docs/build-plan.md): the standard SNS topic
// aws-cds-hackathon-poc-cuadrilla-wa-inbound (the only event destination of the app's own WABA), its
// resource policy, InboundWhatsApp and the End User Messaging Social IAM over `whatsappPhoneArn()`.
// Owned by WP-24, which replaces this file. Until then it creates no resource, so sst.config.ts can
// import every module of docs/build-plan.md §1 in its final order. The ARN helper lives in
// infra/iam-capabilities.ts (pure, tested there) and is re-exported here, where its users look.

export { whatsappPhoneArn } from "./iam-capabilities";
