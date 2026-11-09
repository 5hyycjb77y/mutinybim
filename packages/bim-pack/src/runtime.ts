/**
 * `@permitzip/bim-pack/runtime`: what an add-on (pack) needs at run time — the
 * versioned contract (`definePack`, `contribute`, manifests, pack sets,
 * scopes), every extension point this release reads from every layer and the
 * types their items need. The package root adds the pack author's tools (the
 * test harness, the conformance suite and the point listing), which a host
 * loading add-ons never runs; first-party add-ons import this entry so those
 * tools stay off the Building Model's first download (`ui.first_chunk.kb`).
 */

// The contract.
export { PACK_CONTRACT_VERSION, RESERVED_PACK_NAMESPACES, PackDefinitionError, contribute, defineExtensionPoint, definePack, satisfies, type Contribution, type ErasedContribution, type ExtensionPoint, type Pack, type PackManifest, type PackRequirement, BUILTIN_PACK_SET, PackSet, PackSetError, resolvePackPins, type PackPin, type PackSetOptions, type PointContributor, activePackSet, bindModelPacks, modelPackSet, unbindModelPacks, withModelPacks, withPackSet, type FirstPartyPackId, AGENT_TOOL_POINT, agentToolNameProblem, type AgentToolDescriptor, type AgentToolTarget, type JsonSchemaObject, PACK_READ_POINT, type PackReadDef, COMMAND_BUILDER_POINT, FIRST_PARTY_TOOL_PREFIX, HOST_RESERVED_TOOL_INPUT_KEYS, isPackRefusal, reservedToolInputProblem, type BuiltCommand, type CommandBuilderDef, type PackRefusal, FIRST_PARTY_PACK_IDS, FIRST_PARTY_MANIFESTS, ELECTRICAL_MANIFEST, PLUMBING_GAS_MANIFEST, MECHANICAL_MANIFEST, FIRE_PROTECTION_MANIFEST, firstPartyStoredOwner, firstPartyPackName, installFirstPartyPacks, installedFirstPartyPacks, keepsBareIds, packNotLoadedMessage } from "@permitzip/bim-kernel/packs";

// Round 6 (contract 1.3.0): the points our trades plug in at, so any trade can.
export { COMMAND_POINT, type PackCommand, type PackCommandDef, type KernelCommand, OUTDOOR_AIR_READER_POINT, type VentilationReader, PRESSURE_TARGET_POINT, type PressureTargetRow, type PressureTargetSource, DRAWN_SOURCE_POINT, type DrawnSourceRow, type DrawnSourceCheck, NETWORK_COUPLING_POINT, type NetworkCouplingDef, type CouplingCarry, FIELD_PROVIDER_POINT, FIELD_PROVIDER_DEFAULT_RANK, type FieldProviderRow, type FieldProvider, DIAGRAM_GRAPH_POINT, type DiagramGraphDef, type DiagramGraph, type DiagramNode, BLOCK_HOP_POINT, BLOCK_DEPENDENCY_POINT, type BlockHopDef, type BlockDependencyDef, FORM_SCHEDULE_POINT, type FormScheduleDef, FIELD_RESOLVER_POINT, type FieldResolverDef, type FieldPathInfo, type ResolvedField, type FieldOptions, TAG_STYLE_PRESET_POINT, type TagStylePresetRow, type TagStylePreset, TAG_FIELD_ALIAS_POINT, type TagFieldAliasRow, POSITION_POLICY_POINT, type PositionPolicyDef, BLOCK_TABLE_POINT, type BlockTableDef, type EvaluatedForm, type FormScheduleDefinition, type ExecuteResult, type CommandContext } from "@permitzip/bim-kernel";
export { PART_TYPE_POINT, type BuiltinPartTypeRow, type LibraryEntry, type PackCommandTypes, type TypedPackCommand } from "@permitzip/bim-kernel";
export { PREVIEW_CALC_POINT, SOURCE_SUPPLY_POINT, type SourceSupply, type SourceSupplyRow } from "@permitzip/bim-calc";

// Kernel points and the types their items need.
export {
  CLASS_POINT,
  SERVICE_POINT,
  NETWORK_ADAPTER_POINT,
  DERIVED_ZONE_RULE_POINT,
  ZONE_PURPOSE_POINT,
  FACET_POINT,
  SYMBOL_POINT,
  PARAMETER_SET_POINT,
  PIPE_MATERIAL_POINT,
  type PipeMaterialRow,
  KNOWN_NETWORK_ADAPTER_IDS,
  KNOWN_AGGREGATION_DIRECTIONS,
  KNOWN_NETWORK_LINKS,
  adapterForService,
  networkForService,
  serviceNetworkTotals,
  quantityRecordMonoid,
  networkTotals,
  sumMonoid,
  IncrementalTotals,
  solveNetwork,
  type NetworkAdapter,
  type Monoid,
  type NetworkAggregation,
  type NetworkQuantities,
  type NetworkWalkContext,
  type AggregationDirection,
  type NetworkLinkKind,
  type ServiceNetworkTotals,
  type NetworkSolveContext,
  type NetworkSolveProblem,
  SPACES_PARAMETER_RATES_FEATURE,
  evaluateParameterRates,
  gravityNetworkOf,
  PUMPED_SEGMENT_KEY,
  registerRevisionCarry,
  PARTS_PACK_VALUES_FEATURE,
  PARTS_UNIT_CODES_FEATURE,
  PARTS_LINE_HOST_FEATURE,
  PARTITION_DISCIPLINES_FEATURE,
  DISCIPLINE_POINT,
  DISCIPLINES_REGISTRY_FEATURE,
  type DisciplineDef,
  type DisciplineDisplay,
  type DisciplineGroup,
  type DisciplineIfcHint,
  disciplineLabel,
  disciplineCovers,
  RESPONSIBILITY_FEATURE,
  type Responsibility,
  type ResponsibilityScope,
  type ResponsibleParty,
  type ApprovalRule,
  type GravityModelOptions,
  type GravityModelNetwork,
  type RevisionCarry,
  type KnownDiscipline,
  type PackParameter,
  type PackParameterSet,
  type PackClass,
  type ObjectClass,
  type ClassDiscipline,
  type Recognition,
  type ServiceRow,
  type ServiceDef,
  type NetworkAdapterItem,
  type TradeAdapter,
  type SourceInfo,
  type MemberCandidate,
  type ServiceRole,
  type DerivedZoneRuleDef,
  type DerivedZoneRegion,
  type DerivedZoneContext,
  type ZonePurposeDef,
  type FacetDef,
  type SymbolDef,
  type BimElement,
  type ModelState,
  type PartInstance,
} from "@permitzip/bim-kernel";

// Contract 1.7.0 (round 9): add-on-owned element kinds, connector end types, IFC import rules.
export { ELEMENT_KIND_POINT, type ElementKindItem, type ElementKindValue, type ElementKindIssue, readKindValue, writeKindValue, kindValue, headlineKindValue, registerKindLiftSteps } from "@permitzip/bim-kernel";
export { CONNECTOR_END_TYPE_POINT, type ConnectorEndTypeItem, type ConnectorEndTypeVia, type EndTypeJoin, connectorEndTypeTable, type ConnectorIntegrityIssue, type PartImportReport } from "@permitzip/bim-kernel";
export { IFC_IMPORT_RULE_POINT, type ImportRuleDef, type ImportRuleContext, type ImportProduct } from "@permitzip/bim-kernel";

// Contract 1.8.0 (round 10).
// P10: pipe products (kernel.pipe_product v1) and the stored-joint reader.
export { PIPE_PRODUCT_POINT, type PipeProduct, type PipeProductSize, type PipeHub, pipeProductTable, liftPipeJoints, PIPES_ADDON_PRODUCTS_FEATURE } from "@permitzip/bim-kernel";
// K10: element kind row faces (shape, connector ends, anchor, upgrade, nature).
export { type KindNature, type ElementKindShapeFace, type KindShapeField, type ConnectorEndsFace, type ConnectorEndDecl, type KindUpgradeFace, KINDS_ADDON_SHAPES_FEATURE, kindShapeAccepts, connectorEndsTable } from "@permitzip/bim-kernel";
// T10: agent tool packs (kernel.agent_tool_pack v1); the catalogue is on the package root.
export { ADDON_TOOL_PACK_PREFIX, AGENT_TOOL_PACK_POINT, agentToolPackOf, agentToolPackRowProblems, agentToolPackSetProblems, type AgentToolPackDescriptor } from "@permitzip/bim-kernel/packs";
// C10: jurisdiction id, checking context, finding disposition, rule versions.
export { type JurisdictionId, parseJurisdiction, type CheckingContext, type FindingDisposition, type RuleVersionRef, type CodeOfRecord, type CarriedForward, SIGNOFFS_CHECKING_CONTEXT_FEATURE, SIGNOFFS_DISPOSITIONS_FEATURE } from "@permitzip/bim-kernel";
// S10: kept validation state (K9's).
export { type ValidationState } from "@permitzip/bim-kernel";
// V10: key-log checkpoints.
export { type KeyLogCheckpoint, type UnsignedKeyLogCheckpoint, type CheckpointKey, KEY_LOG_CHECKPOINT_DOMAIN, CHECKPOINT_ALG, keyLogCheckpointFields, keyLogCheckpointBytes, checkpointKeyId, signKeyLogCheckpoint, verifyKeyLogCheckpoint, historyExtendsCheckpoint, type CheckpointVerdict, type HistoryAgainstCheckpoint } from "@permitzip/bim-kernel";
// Q10: forward to a person, answers made stale by an edit.
export { type QuestionForward, questionForwards, questionAddresseePeople, QUESTION_FORWARD_PERSON_FEATURE, answersMadeStaleByEdit, type AnswerMadeStale } from "@permitzip/bim-kernel";

// Lint.
export { LINT_RULE_POINT, type RuleContext, type RuleDef, type RuleScope, type Finding, type Severity } from "@permitzip/bim-lint";

// Calcs and code editions.
export { CALC_POINT, CODE_EDITION_POINT, defineCalc, isCalcUnit, type CalcUnit, type CalcValue, type RunRequest, type RunResult, type CalcContext, type CalcOutput, type CalcPlugin, type CodeEdition, type CodeFamilyDef, type CodeRequest, type CodeResolution, type RegisteredCalc } from "@permitzip/bim-calc";

// Library.
export { SPACE_USE_POINT, SPACE_USE_RATE_POINT, SPACE_USE_RATE_VALUE_POINT, type SpaceUseRateTarget, type SpaceUseRateValue, type SpaceUseRow } from "@permitzip/bim-library";

// Points an add-on declares for others (the conformance suite reads them).
export { declaredPoint, type KnownPoint } from "./known-point";

// Element and placement helpers (geometric placements, stations, typed-element reads).
export * from "@permitzip/bim-kernel/placement";
export * from "@permitzip/bim-kernel/elements";

export { CONNECTION_QUANTITY_CHECK_POINT, PIPE_RUN_CHECK_POINT, SERVES_RULE_POINT, STARTER_CONNECTION_TYPE_POINT, SYSTEM_LABEL_POINT, type ConnectionQuantityCheckDef, type PipeRunCheckDef, type ServesRuleDef, type SystemLabelDef } from "@permitzip/bim-kernel";
// Contract 1.9.0 (round 11 wave 1): one record registry (K11), copies (L11), the problem list (F11), stages and confidence (G11).
export { type PackCommandClaim, claimedCommandCase, type HostedPlacementFace, type KindRecordRead, kindRowOf, KERNEL_KIND_ROWS } from "@permitzip/bim-kernel";
export { type FindingRef, dispositionFromLintAcceptance } from "@permitzip/bim-kernel";
export { GRAPH_ANCHOR_POINT } from "@permitzip/bim-kernel";
// Contract 1.10.0 (round 12 wave 0): catalog record types, diagram layouts, view graphics, source candidates and
// translate faces, kind row faces, rating kinds, route constraints, fitting families, mirrored typicals, assembly stubs.
export { CATALOG_ENTRY_POINT, type CatalogEntryTypeRow, type CatalogEntrySection, catalogEntryRow, catalogEntryRows } from "@permitzip/bim-kernel";
export { DIAGRAM_LAYOUT_POINT, type DiagramLayoutRow, type DiagramLayoutContext, type DiagramLayoutResult, type DiagramLayoutNode, diagramLayoutRow } from "@permitzip/bim-kernel";
export { VIEW_GRAPHICS_POINT, type ViewGraphicsRow, type ViewGraphicsContext, viewGraphicsRows } from "@permitzip/bim-kernel";
export { sourcesFor, translateThroughNetworks, connectToSource, type ConnectFace, type ConnectPlan, type SourcesForFace, type SourceEndRef, type SourceCandidate, type SourceCandidates, type SourceRefusal, type TranslateFace, type TranslateContext, type TranslateAuthoredWrite } from "@permitzip/bim-kernel";
export { type KindSymbolFace, type KindSymbol, type KindTagTextFace, type KindPickShapeFace, type KindPickShape } from "@permitzip/bim-kernel";
export { FITTING_FAMILY_POINT, type FittingFamilyRow, type FittingSlotDefault, packFittingFamily, packFittingFamilies, packFittingDefault } from "@permitzip/bim-kernel";
export { TYPICALS_MIRROR_FEATURE } from "@permitzip/bim-kernel";
// Contract 1.11.0 (round 13 wave 0).
export { type KindPlanGraphicsFace, type PlanGraphic, type PlanPen, type PlanGraphicsContext } from "@permitzip/bim-kernel";
export { DATUM_POINT, type DatumRow, type DatumSnapLine, datumRow, datumSnapLines } from "@permitzip/bim-kernel";
export { LINE_JOIN_POINT, type LineJoinRow, type JoinStyle, type EndCleanup, JOIN_STYLES, DISALLOW_JOIN_KEYS, lineJoinRow, endCleanupsOf } from "@permitzip/bim-kernel";
export { HOST_VOID_POINT, type HostVoidRow, type HostVoid, hostVoidRow, voidsOf } from "@permitzip/bim-kernel";
export { BOUNDING_ELEMENT_POINT, type BoundingElementRow, type BoundarySegment, ROOM_BOUNDING_INSTANCE_KEY, boundingElementRow, boundsRooms, boundarySegmentsOnLevel } from "@permitzip/bim-kernel";
export { SPACES_NESTED_FEATURE, NESTING_DISPLAYS, type NestingDisplay, type NestedRecord, type NestedRow, parentOf, childrenOf, ancestorsOf, nestingRefusal, nestedRows } from "@permitzip/bim-kernel";
export { SPACES_SEPARATORS_FEATURE, isSpaceSeparator, separatorsOnLevel, type SpaceSeparator, type BoundaryRef } from "@permitzip/bim-kernel";
export { SPACES_BOUNDED_FEATURE, BOUNDARY_QUANTITY_KEYS, type BoundaryFact, type BoundaryOpening, type BoundarySide, type BoundaryQuantityKey, spaceBoundaryFacts } from "@permitzip/bim-kernel";
export { IFC_RELATION_POINT, IFC_RELATION_ENTITIES, type IfcRelationRow, type IfcRelationSpec, type IfcRelationEntity, type IfcSyntheticObject, ifcRelationRowsFor } from "@permitzip/bim-kernel";
export { CONNECTOR_FACE_POINT, ROUTING_TAP_FACES_FEATURE, SIDE_FACE_IDS, type ConnectorFaceRow, type ConnectorFaceDef, type TapPlacement, connectorFacesOf, faceOfSide, pointOnFace, hostedFaceOf, placementPoint } from "@permitzip/bim-kernel";
export { CONNECTION_FIELD_POINT, type ConnectionFieldRow, type ConnectionFieldValue, connectionFieldRow, connectionFieldValue } from "@permitzip/bim-kernel";
export { GRAVITY_OUTFALL_POINT, type GravityOutfallRow, type GravityOutfall, outfallOf, walkToOutfall } from "@permitzip/bim-kernel";
export { modelIdsOf, diagramEntriesOf } from "@permitzip/bim-kernel";
export { CLASS_PLAN_GRAPHICS_POINT, type ClassPlanGraphicsRow } from "@permitzip/bim-kernel";
export { LINKED_PLAN_DISPLAY_POINT, linkedPlanDisplay, linkedPlanPlacement, type LinkedPlanDisplayRow, type LinkedPlanDisplay, type LinkedPlanRule, type LinkedPlanRange, type LinkedPlanPlacement } from "@permitzip/bim-kernel";
export { LINKED_REFERENCE_POINT, linkedReferenceRules, type LinkedReferenceRow, type LinkedReferenceRule, type LinkedReferenceRules, type LinkedEnvelopeRole } from "@permitzip/bim-kernel";
export { CLASS_SOLIDS_POINT, SOLID_LOOKS, type ClassSolidsRow, type ClassSolidPart, type ClassSolidsFace, type SolidLook } from "@permitzip/bim-kernel";
export { LOOKUP_TABLE_ITEM_TYPE, lookupTableSchema, type LookupTable, lookupTableProblems, lookupTable } from "@permitzip/bim-kernel/policy";
// Contract 1.12.0 (round 14 wave 0).
export { LIBRARY_ROWS_POINT, LIBRARY_ROW_SECTIONS, LIBRARY_ADDON_ROWS_FEATURE, type LibraryRow, type LibraryRowSection, type AddonLibraryRows, libraryRowsOf } from "@permitzip/bim-kernel";
export { layoutRowFor, ratedSegmentsNear, ROUTING_TAP_OFFSET_FEATURE, ROUTING_INSERT_PART_FEATURE, type InsertPartOnRun, insertPartOnRun } from "@permitzip/bim-kernel";
// Contract 1.13.0 (round 15 wave 0): connect into, the solid program, sheet sets, schedule steps and the round's peer features.
export { ROUTING_CONNECT_INTO_FEATURE, CONNECT_INTO_NOT_BUILT, planConnectInto, type ConnectInto, type ConnectIntoSource, type ConnectIntoPlan, type ConnectIntoAnswer, type ConnectIntoSourcePlan, type ConnectIntoSourceRefusal, type ConnectIntoFitting } from "@permitzip/bim-kernel";
export { GEOMETRY_SOLID_PROGRAM_2_FEATURE, PART_MODEL_SCHEMA_2, PART_SYMBOL_VIEWS, IMPORTED_BODY_FORMATS, partModelSchema2, anyPartModelSchema, partModelSchemaVersion, type PartModel2, type AnyPartModel, type PartFeature2, type PartProfile, type PartSymbol, type ImportedBodyRef } from "@permitzip/bim-kernel";
export { DOCUMENTS_SHEET_SETS_FEATURE, SCHEDULES_EDIT_STEPS_FEATURE, WALLS_TOP_CONSTRAINT_FEATURE, PARTS_CLASS_SOLIDS_FEATURE, type ScheduleEditStep } from "@permitzip/bim-kernel";
export { STARTER_ELEMENT_TYPE_POINT, type StarterElementTypeRow } from "@permitzip/bim-kernel";
export { SURFACE_FACE_POINT, SURFACE_FACE_ROLES, WALLS_SURFACE_BINDING_FEATURE, surfaceFaceRow, type SurfaceFaceRow, type SurfaceFaceRole, type FacePair } from "@permitzip/bim-kernel";
