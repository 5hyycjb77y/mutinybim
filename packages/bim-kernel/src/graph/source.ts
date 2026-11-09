import { defineExtensionPoint } from "../packs/contract";
import type { ModelState } from "../types";
import { builtinRequirementsSources } from "./builtin-sources";
import type { DeterminationElement, RequirementId, RuleRecord, RuleVerificationStatus } from "./types";

/**
 * `kernel.requirements_source` v1 (contract 1.4.0, REQUIREMENTS-GRAPH §4): a
 * provider supplies rules for a model. The bundled `local` source (rules
 * stored with the model), an add-on's source (trusted code in the process),
 * or a host connector (PermitZIP's code studies, another firm's library).
 *
 * The kernel's reads are synchronous, so a remote provider never answers a
 * read: the host fetches its rules, then binds an immutable snapshot to the
 * model (`bindRequirementsSnapshot` in graph/snapshots.ts), the way pack sets
 * are bound. Write-back runs in the host and never blocks the kernel.
 */

export interface RequirementsSourceCapabilities {
  readonly rules: true;
  /** Accepts determinations recorded in the model. */
  readonly determinationsWriteBack?: boolean;
  /** Accepts an override offered back from the model. */
  readonly overridesWriteBack?: boolean;
  /** Can mark a rule verified. */
  readonly verification?: boolean;
}

export interface RequirementsSourceDescriptor {
  /** `local`, an add-on's `<pack>.<name>`, or a host connector's id (`permitzip.code_study`). */
  readonly id: string;
  /** "PermitZIP code studies". */
  readonly label: string;
  /** The provider's own semver. */
  readonly version: string;
  /** The range of this contract it was written for ("^1.0.0"). */
  readonly contract: string;
  readonly capabilities: RequirementsSourceCapabilities;
  /** Where its rules come from. */
  readonly visibility: "model" | "firm" | "public" | (string & {});
}

/** One immutable set of a source's rules bound to a model. */
export interface RequirementsSnapshot {
  readonly source: RequirementsSourceDescriptor;
  /** Changes whenever the rules change (the code study revision, a hash). */
  readonly revision: string;
  readonly rules: readonly RuleRecord[];
  /** ISO 8601, when the host fetched it. */
  readonly fetchedAt?: string;
}

export type WriteBackResult = { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly reason: string };

export interface DeterminationWriteBack {
  readonly modelId: string;
  readonly modelRevision: number;
  readonly record: DeterminationElement;
}

export interface OverrideWriteBack {
  readonly modelId: string;
  readonly modelRevision: number;
  readonly requirementId: RequirementId;
  /** The rule's back-pointer to the source's own row. */
  readonly sourceRef?: { readonly provider: string; readonly ref: string };
  readonly anchorId: string | null;
  readonly value: number | string | boolean;
  readonly unit?: string;
  readonly reason: string;
}

export interface VerificationWriteBack {
  readonly ruleId: string;
  readonly sourceRef?: { readonly provider: string; readonly ref: string };
  readonly status: RuleVerificationStatus;
  readonly reason: string;
}

/** What a host offers back to a source. Every method is optional; the kernel never waits on one. */
export interface RequirementsSourceWriteBack {
  recordDetermination?(input: DeterminationWriteBack): Promise<WriteBackResult>;
  overrideRequirement?(input: OverrideWriteBack): Promise<WriteBackResult>;
  verifyRule?(input: VerificationWriteBack): Promise<WriteBackResult>;
}

/**
 * An in-process source an add-on contributes (trusted code): its rules read
 * synchronously from the model. A pack's ids are `<pack>.<name>`.
 */
export interface RequirementsSourceRow {
  readonly descriptor: RequirementsSourceDescriptor;
  rules(model: ModelState): readonly RuleRecord[];
}

/** Requirements sources (v1). The built-in row is `local`; packs add theirs. */
export const REQUIREMENTS_SOURCE_POINT = defineExtensionPoint<RequirementsSourceRow>({
  id: "kernel.requirements_source",
  version: 1,
  label: "Requirements sources",
  idOf: (row) => row.descriptor.id,
  builtins: builtinRequirementsSources,
});

/** The contract version of `kernel.requirements_source` this kernel implements. */
export const REQUIREMENTS_SOURCE_CONTRACT = "1.0.0";

/**
 * Which sources govern a discipline on a model, highest first (model
 * settings, like add-on pins). `discipline: "*"` applies to every discipline
 * without its own row. A pinned source this host lacks is named, and its
 * requirements show read-only from the last snapshot.
 */
export interface RequirementsSourcePin {
  readonly discipline: string;
  readonly sources: readonly string[];
}
