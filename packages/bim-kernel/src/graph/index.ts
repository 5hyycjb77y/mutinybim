/**
 * The requirements graph engine (contract 1.4.0). Types and the source
 * contract are exported from `graph/types.ts` and `graph/source.ts`; this is
 * the engine, its queries, the local source and the graph commands.
 */
export { bindRequirementsSnapshot, boundSnapshots, unbindRequirementsSnapshot } from "./snapshots";
export { registerBuiltinRequirementsSource, builtinRequirementsSources } from "./builtin-sources";
export { compileSnapshot, type CompiledSnapshot } from "./compile";
export {
  anchorOfRequirementId,
  graphStats,
  parseRequirementId,
  requirementById,
  requirementsAt,
  requirementsOf,
  requirementsSources,
  type GraphStats,
  type SourceBinding,
} from "./engine";
export { anchorKeyOf, type AnchorRef as RequirementAnchorRef } from "./inputs";
export { anchorKindTable, BUILTIN_ANCHOR_KIND_ROWS, GRAPH_ANCHOR_POINT, GRAPH_OWN_ANCHOR_KINDS, type AnchorKindTable, type GraphAnchorKindRow } from "./anchors";
export { dependsOn, why, type DependsOnTarget, type ProposedEdit } from "./queries";
export { editPreviewFingerprint, previewEdit, type EditPreview, type EditPreviewChecked, type EditPreviewItem, type EditPreviewRefused, type PreviewEditOptions } from "./preview-edit";
export { checkRequirementsSnapshot, checkRequirementsSourceRow, checkRules, checkRuleWords, looksVerbatim, verbatimSignals, type RuleFinding, type VerbatimSignals } from "./conformance";
export {
  determinationsWritable,
  isDeterminationRecord,
  isObservationRecord,
  isRequirementStateRecord,
  observationsWritable,
  readObservationBody,
  isRuleRecordElement,
  readDeterminationBody,
  readRequirementStateBody,
  readRuleRecord,
  requirementStatesWritable,
  rulesWritable,
  DETERMINATION_RECORD_STEP,
  REQUIREMENT_STATE_RECORD_STEP,
  RULE_RECORD_STEP,
  type ReadResult,
} from "./records";
export {
  exportRuleToLibraryItem,
  importRuleFromLibraryItem,
  localRuleElementId,
  localRuleRecord,
  localRules,
  sameRule,
  LOCAL_SOURCE_DESCRIPTOR,
  LOCAL_SOURCE_ID,
  LOCAL_SOURCE_ROW,
  RULE_LIBRARY_ITEM_TYPE,
  type ImportedRule,
  type RuleLibraryItem,
  type RuleLibraryItemBody,
} from "./sources/local";
export { executeGraphCommand, graphCommandSchema, graphCommandSchemas, isGraphCommand, requirementStateElementId, type GraphCommand } from "./commands";
