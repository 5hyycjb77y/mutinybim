/**
 * `@permitzip/bim-pack`: the one import a MutinyBIM add-on (pack) uses.
 *
 * The versioned contract (`definePack`, `contribute`, manifests, pack sets,
 * scopes), every extension point this release reads from every layer, the
 * types their items need, and the conformance suite a pack passes before a
 * host loads it. Internal contract, versioned (PACK-CONTRACT.md); not a public
 * promise until MutinyBIM is open-sourced.
 */

export * from "./runtime";

// The agent tool pack catalogue (T10), read by hosts that serve the tools, not by add-ons.
export { bimPackCatalogue, type BimToolPack } from "@permitzip/bim-plugin";

// Pack test harness: the real engines inside a set's scope.
export { packFieldRegistry, runPackCalc, runPackLint, runPackNetwork, type PackLintOptions } from "./harness";

// Conformance and listing.
export { runPackConformance, type ConformanceOptions, type ConformanceResult } from "./conformance";
export { KNOWN_POINTS, knownPoint } from "./points";
export { describePacks, type PackPointCount, type PackSummary } from "./describe";

// Contract 1.9.0 (round 11): copies, the problem list, stages and value bases. On the root, not
// `./runtime`: no first-party add-on contributes to them, and they are off the first download.
export { LINEAGE_ROLE_POINT, lineageRoleProblems, type Lineage, type LineageAct, type LineageCheckpoint, type LineageBundle, type LineageDifference, type LineageCapability, readBranchAsLineage, lineageChain, compareLineages } from "@permitzip/bim-kernel/lineages";
export { FINDING_SOURCE_POINT, findingSourceRowProblems, type AgentOrientation } from "@permitzip/bim-kernel/findings";
export { LIFECYCLE_STAGE_POINT, STAGE_SET_POINT, stageProblems, copyStageSet, type LifecycleStageDef, type GateBody, type GateElement, type GateTotals, type GateMoney, GATES_RECORDS_FEATURE } from "@permitzip/bim-kernel/lifecycle";
export { BASIS_POINT, basisRowProblems, type ValueBasis, readBasis, VALUES_BASIS_FEATURE } from "@permitzip/bim-kernel/basis";

// Contract 1.10.0 (round 12 wave 0): calculation sheets, design limits and picture intake. On the root, not
// `./runtime`, and on kernel subpaths, so they stay off the Building Model's first download.
export { CALC_SHEET_POINT, type CalcSheetTemplateRow, type CalcSheetBuildRequest, type CalcSheetSpec, type CalcSheetInput, type CalcInputBinding, type CalcSheetLookup, type CalcLookupMatch, type CalcSheetStep, type CalcSheetCheck, type CalcSheetCitation, type CalcTable, type CalcTableSource, type GoverningCell, type CalcCheckResult, type CalcSheetEvaluation, type CalcSheetContext, calcSheetRowProblems, calcSheetSpecProblems, calcSheetTemplate, calcSheetTemplates, evaluateCalcSheet, placeCalcSheet, CalcSheetSession, renderCalcSheet, calcSheetSnapshot, calcSheetPins, calcSheetValueHash, headingNumber, CALC_GOVERNING_WORDS } from "@permitzip/bim-kernel/calc-sheets";
export { DESIGN_LIMIT_DEFAULT_POINT, type DesignLimit, type DesignLimitAppliesTo, type DesignLimitBand, type DesignLimitCitation, type DesignLimitLayer, type DesignLimitSelector, type DesignLimitSeverity, type DesignLimitSources, type ResolvedDesignLimit, designLimitSchema, designLimitProblems, designLimitsFor, outsideBand, DESIGN_LIMIT_MEASURE_POINT, type DesignLimitMeasureRow, type DesignLimitMeasurement, designLimitMeasureProblems, designLimitFindingSource, designLimitRows, bandWords, checkDesignLimit } from "@permitzip/bim-kernel/policy";
export { INTAKE_COLUMN_POINT, type IntakeColumnRow, type TableReader, type TableReadInput, type TableReadResult, type TableReadCell, type TableReadPage, type CellBox, type IntakeProposal, type IntakePlannedRow, type IntakeRowCell, type IntakeMappingOptions, intakeColumnRowProblems, intakeHeadingKey, intakeColumns, proposeIntakeRows, intakePlanCommands, intakeNumber, DEFAULT_INTAKE_THRESHOLD, type IntakePlanCommand, type IntakePlanOptions } from "@permitzip/bim-kernel/intake";

// Contract 1.10.0 (round 12): rating kinds and route constraints, typical-to graphics and assembly stubs.
// On the root and on kernel subpaths, off the Building Model's first download until an add-on uses them.
export { RATING_KIND_POINT, type RatingKindRow, ratingKindRow, ratingOf, formatRating, ROUTE_CONSTRAINT_POINT, type RouteConstraintRow, type CrossingRule, type ClearanceRule, type RouteSpan, type RouteConstraintHit, routeConstraintsFor, checkRouteSpan } from "@permitzip/bim-kernel/rated-routes";
export { type AssemblyStub, assemblyStubs } from "@permitzip/bim-kernel/typicals";
