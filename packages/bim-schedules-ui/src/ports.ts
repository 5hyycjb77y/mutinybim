/**
 * The slices of the library (Stream B, `@permitzip/bim-library`) and formula
 * (Stream C, `@permitzip/bim-formula`) contracts these surfaces use, as
 * structural types. B's `LibraryProvider` and C's `FormulaEngine` satisfy them
 * as-is; the UI never depends on their internals, and a host can hand in any
 * object of the same shape. Field names and meanings match B's `provider.ts`
 * and C's `types.ts` exactly.
 */

import type { AggregationRule, Kind, UnitCode } from "@permitzip/bim-units";

// ---------------------------------------------------------------- library (B)

export type LibraryScopeKind = "builtin" | "firm" | "project" | "file";
export type LibraryItemType = "unit_profile" | "class" | "field" | "formula" | "relationship" | "schedule_template" | "tag_type" | "discipline" | "element_type";

export interface LibraryScope {
  readonly id: string;
  readonly kind: LibraryScopeKind;
  readonly name: string;
}

export interface LibraryItemSummary {
  readonly id: string;
  readonly type: LibraryItemType;
  readonly key: string;
  readonly name: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly scope: string;
  readonly deprecated: boolean;
}

export interface LibraryQuery {
  readonly type?: LibraryItemType;
  readonly text?: string;
  readonly includeDeprecated?: boolean;
}

export interface ScopeCapabilities {
  readonly read: boolean;
  readonly publish: boolean;
  readonly reason?: string;
}

export interface LibraryProblem {
  readonly itemId?: string;
  readonly itemKey?: string;
  readonly line?: number;
  readonly message: string;
}

export type PublishResult =
  | { readonly ok: true; readonly summary: LibraryItemSummary }
  | {
      readonly ok: false;
      readonly code: "conflict" | "invalid" | "forbidden" | "read_only";
      readonly message: string;
      readonly problems?: readonly LibraryProblem[];
      readonly currentRevision?: number;
    };

export type OperandType = { readonly valueType: "quantity"; readonly kind: string; readonly unit: string } | { readonly valueType: "text" } | { readonly valueType: "boolean" };

/** B's `CalculationItem` (a library `formulas` entry). */
export interface CalculationItemBody {
  readonly id: string;
  readonly revision: number;
  readonly key: string;
  readonly name: string;
  readonly expression: string;
  readonly params?: readonly { readonly name: string; readonly type: OperandType }[];
  readonly result: OperandType;
  readonly appliesTo: readonly string[];
  readonly description?: string;
}

export interface FormulaLibraryItem {
  readonly type: "formula";
  readonly body: CalculationItemBody;
}

/** B's `SharedFieldItem` (a library `fields` entry): a parameter firms and projects add with no code change. */
export interface SharedFieldItemBody {
  readonly id: string;
  readonly revision: number;
  readonly key: string;
  readonly label: string;
  readonly appliesTo: readonly string[];
  readonly valueType: "quantity" | "text" | "boolean" | "choice";
  readonly kind?: string;
  readonly unit?: string;
  readonly choices?: readonly string[];
  readonly group?: string;
  readonly editable: boolean;
  readonly storage: { readonly kind: "parameter"; readonly scope: "instance" | "type"; readonly name: string } | { readonly kind: "provided" } | { readonly kind: "values" };
  readonly description?: string;
}

export interface FieldLibraryItem {
  readonly type: "field";
  readonly body: SharedFieldItemBody;
}

/** What these surfaces call on B's `LibraryProvider`. */
export interface LibraryProviderPort {
  scopes(): Promise<readonly LibraryScope[]>;
  list(scope: string, query?: LibraryQuery): Promise<readonly LibraryItemSummary[]>;
  /** Publish one item revision (a calculation from Save to firm library, a field from New field). */
  publish?(scope: string, item: FormulaLibraryItem | FieldLibraryItem, baseRevision: number): Promise<PublishResult>;
  capabilities(scope: string): Promise<ScopeCapabilities>;
}

// ---------------------------------------------------------------- formula (C)

export type FormulaType = { readonly type: "quantity"; readonly kind: Kind; readonly unit: UnitCode } | { readonly type: "text" } | { readonly type: "boolean" };

export interface FieldSignature {
  readonly type: FormulaType;
  readonly label?: string;
}

export interface RelationshipSignature {
  readonly label?: string;
  readonly target: FormulaSchema;
}

export interface FormulaSchema {
  field(path: string): FieldSignature | undefined;
  relationship(name: string): RelationshipSignature | undefined;
}

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface FormulaError {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export type FormulaCheck = { readonly ok: true; readonly formula: { readonly source: string; readonly type: FormulaType } } | { readonly ok: false; readonly errors: readonly FormulaError[] };

/** What the builder calls on C's `FormulaEngine`. */
export interface FormulaEnginePort {
  compile(source: string, schema: FormulaSchema, options?: { readonly expect?: FormulaType }): FormulaCheck;
}

// ---------------------------------------------------------------- registry (B's kernel registry, read side)

export interface CatalogClass {
  readonly id: string;
  readonly label: string;
  /** Registry discipline id (`mechanical`, `fire_protection`, …); the picker groups by it. */
  readonly discipline: string;
  /** The discipline in words, from the host's registry ("Fire alarm"); the builder falls back to the id's own words. */
  readonly disciplineLabel?: string;
}

export interface CatalogField {
  readonly path: string;
  readonly label: string;
  readonly valueType: "quantity" | "text" | "boolean" | "choice";
  readonly kind?: Kind;
  readonly unit?: UnitCode;
  readonly editable: boolean;
  readonly aggregation: AggregationRule;
  /** Why a total is refused for this field, e.g. served loads (§5b). */
  readonly totalRefusedReason?: string;
}

export interface CatalogRelationship {
  readonly id: string;
  readonly label: string;
  readonly targetClasses: readonly string[];
}

/** Classes, fields and relationships the builder offers (served by B's registry once merged). */
export interface ScheduleCatalog {
  classes(): readonly CatalogClass[];
  fieldsFor(classIds: readonly string[]): readonly CatalogField[];
  relationshipsFor(classIds: readonly string[]): readonly CatalogRelationship[];
}
