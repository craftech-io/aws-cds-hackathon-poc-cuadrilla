// `WorkOrders` repository, the proof of an installation: evidence photos (with the repeated-photo
// index `GSI4`, scoped to the world and its epoch), photo validations, troubleshooting steps (with the
// next sequence number of the order) and the certificate with its deliveries.
import { Certificate, Evidence, PhotoValidation, TroubleshootingStep } from "../../domain/work-orders";
import { EVID_PREFIX, STEP_PREFIX, VAL_PREFIX, evidenceHashKey, workOrderPartition } from "../keys";
import type { WorkOrdersPort } from "../ports-data";
import { createEntity, getEntity, listPrefix, parseRows, patchEntity, requireEntity, retryOnConflict, upsertEntity, withHistory, type RepoContext } from "./repo";

const TABLE = "WorkOrders";

type EvidencePart = Omit<
  WorkOrdersPort,
  | "getWorkOrder"
  | "requireWorkOrder"
  | "createWorkOrder"
  | "listInstallerDay"
  | "listIspDay"
  | "setStatus"
  | "updateWorkOrder"
  | "recordOnuReading"
  | "setOnHoldSafety"
  | "bumpSessionEpoch"
  | "listChecklist"
  | "getChecklistItem"
  | "putChecklistItem"
  | "updateChecklistItem"
>;

export function evidenceRepo(ctx: RepoContext): EvidencePart {
  const { client } = ctx;
  const listSteps = (workOrderId: string) => listPrefix(ctx, TABLE, TroubleshootingStep, workOrderPartition(workOrderId), STEP_PREFIX);

  return {
    createEvidence: (evidence) => createEntity(ctx, Evidence, "Evidence", evidence),
    getEvidence: (workOrderId, evidenceId) => getEntity(ctx, Evidence, "Evidence", { workOrderId, evidenceId }),
    listEvidence: (workOrderId) => listPrefix(ctx, TABLE, Evidence, workOrderPartition(workOrderId), EVID_PREFIX),
    async findEvidenceByHash(clockId, worldEpoch, sha256) {
      return parseRows(Evidence, await client.query(TABLE, { index: "GSI4", hashValue: evidenceHashKey(clockId, worldEpoch, sha256) }), TABLE);
    },

    createValidation: (validation) => createEntity(ctx, PhotoValidation, "PhotoValidation", validation),
    getValidation: (workOrderId, validationId) => getEntity(ctx, PhotoValidation, "PhotoValidation", { workOrderId, validationId }),
    async listValidations(workOrderId, item) {
      const validations = await listPrefix(ctx, TABLE, PhotoValidation, workOrderPartition(workOrderId), VAL_PREFIX);
      return item === undefined ? validations : validations.filter((validation) => validation.item === item);
    },

    // The next sequence is read and claimed with `ifNotExists`; a concurrent append retries.
    appendStep: (step) =>
      retryOnConflict(5, async () => {
        const last = await listPrefix(ctx, TABLE, TroubleshootingStep, workOrderPartition(step.workOrderId), STEP_PREFIX, { descending: true, limit: 1 });
        return createEntity(ctx, TroubleshootingStep, "TroubleshootingStep", { ...step, seq: (last[0]?.seq ?? 0) + 1 });
      }),
    listSteps,
    async updateStepOutcome(workOrderId, seq, outcome, transition) {
      const current = await requireEntity(ctx, TroubleshootingStep, "TroubleshootingStep", { workOrderId, seq }, `step ${seq} of ${workOrderId}`);
      const history = withHistory(ctx, current.history, "outcome", current.outcome, outcome, transition);
      return patchEntity(ctx, TroubleshootingStep, "TroubleshootingStep", current, { outcome, history });
    },

    getCertificate: (workOrderId) => getEntity(ctx, Certificate, "Certificate", { workOrderId }),
    async putCertificate(certificate) {
      const current = await getEntity(ctx, Certificate, "Certificate", certificate);
      return upsertEntity(ctx, Certificate, "Certificate", { ...certificate, deliveries: certificate.deliveries ?? current?.deliveries ?? [] });
    },
    setDelivery: (workOrderId, delivery) =>
      retryOnConflict(3, async () => {
        const current = await requireEntity(ctx, Certificate, "Certificate", { workOrderId }, `certificate of ${workOrderId}`);
        const others = current.deliveries.filter((existing) => existing.to !== delivery.to || existing.channel !== delivery.channel);
        return patchEntity(ctx, Certificate, "Certificate", current, { deliveries: [...others, delivery] });
      }),
  };
}
