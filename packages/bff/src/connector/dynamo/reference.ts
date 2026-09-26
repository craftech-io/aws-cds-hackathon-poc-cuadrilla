// `Reference` repository: versioned catalogs the seed writes (`REF#<type>#<scope>` + key) and the
// product reads: templates, rubric, safety lexicon, manual index, KB threshold, evaluation set, texts
// of reject reasons, rate card and name checks.
import type { ZodType } from "zod";
import { GLOBAL_SCOPE, referencePartition } from "../keys";
import { EvalPhoto, EvalQuestion, KbThreshold, ManualIndex, NameCheck, RateCard, REFERENCE_ENTITIES, RejectReasonCopy, Rubric, SafetyLexicon, Template } from "../../domain/reference";
import type { ReferencePort } from "../ports-runtime";
import { getEntity, parseRows, upsertEntity, type RepoContext } from "./repo";

const TABLE = "Reference";

export function referenceRepo(ctx: RepoContext): ReferencePort {
  const { client } = ctx;
  const listScope = async <T>(schema: ZodType<T>, type: string, scope: string): Promise<T[]> =>
    parseRows(schema, await client.query(TABLE, { hashValue: referencePartition(type, scope) }), TABLE);

  return {
    getTemplate: (name) => getEntity(ctx, Template, "Template", { name }),
    listTemplates: () => listScope(Template, "TEMPLATE", "WHATSAPP"),
    getRubric: (version, item) => getEntity(ctx, Rubric, "Rubric", { rubricVersion: version, item }),
    listSafetyLexicon: (version) => listScope(SafetyLexicon, "SAFETY_LEXICON", version),
    listManualIndex: (version) => listScope(ManualIndex, "MANUALINDEX", version),
    getKbThreshold: (version) => getEntity(ctx, KbThreshold, "KbThreshold", { thresholdVersion: version }),
    listEvalQuestions: () => listScope(EvalQuestion, "EVAL", "QUESTIONS"),
    listEvalPhotos: () => listScope(EvalPhoto, "EVAL", "PHOTOS"),
    getRejectReasonCopy: (reason) => getEntity(ctx, RejectReasonCopy, "RejectReasonCopy", { reason, locale: "es-MX" }),
    listRateCard: () => listScope(RateCard, "RATECARD", GLOBAL_SCOPE),
    listNameChecks: () => listScope(NameCheck, "NAMECHECK", GLOBAL_SCOPE),
    put: (entity, value) => upsertEntity(ctx, REFERENCE_ENTITIES[entity] as ZodType, entity, value) as never,
  };
}
