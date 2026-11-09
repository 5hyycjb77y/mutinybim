/**
 * Everything a host plug-in needs from the model server, in one place, so a
 * plug-in imports this module and nothing else of the server or the engine.
 */
export * from "./contract";
export { asHostModule, assertModelServerHost, createHost, loadModelServerHostModule, type ModuleImporter } from "./load";
export { supabaseUrl } from "../config";
export { NO_MODEL_ACCESS, NO_SUCH_MODEL, MERGE_WORDS } from "@permitzip/bim-sync";
export type { ApprovalSnapshot, LineageGrantsAnswer, MergeApprovalSource, ModelAuthorizer, ModelCapability, ModelGrant, ProposalSnapshot } from "@permitzip/bim-sync";
export type { LineageActRecorder, LineageCaller, LineageGrantRecord } from "@permitzip/bim-sync/lineages";
export { lineageActKey } from "@permitzip/bim-sync/lineages";
export { LINEAGE_ACT_RECORD_KINDS, LINEAGE_SIGNOFF_KINDS, LineageError, readLineageActPayload, writeLineageActPayload } from "@permitzip/bim-kernel/lineages";
export type { RecordedLineageAct } from "@permitzip/bim-kernel/lineages";
export type { ApprovalRule, MergeApprovalRecord, Responsibility, ResponsibilityScope } from "@permitzip/bim-kernel";
export type { Sql } from "../pg-store";
