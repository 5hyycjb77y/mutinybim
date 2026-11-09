import { DEFAULT_LINT_CONFIG, LintEngine, lintConfigSchema, type LintConfig } from "@permitzip/bim-lint";
import { acceptanceReasonProblem } from "./acceptance-reason";
import type { BimLintStores, BranchActions, LinkedSurfaceSources, LintAcceptance, LintEngines, LintRetraction, LintToolsHost, StatusPictures } from "./capabilities";

/**
 * The coordination services of a local server: lint settings and accepted
 * findings in memory, an engine built for each explicit check, no linked
 * models, no pictures and no branches (the local model server has none).
 */

type AuthExtra = { authInfo?: { extra?: Record<string, unknown> } };

function stringField(extra: unknown, key: string): string | null {
  if (typeof extra !== "object" || extra === null) return null;
  const value = (extra as AuthExtra).authInfo?.extra?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const who = (extra: unknown) => stringField(extra, "userId") ?? "local";
const thread = (extra: unknown) => stringField(extra, "agentConversationId") ?? "local-thread";

/** Lint settings and accepted findings held in memory for as long as the server runs. */
export function memoryLintStores(): BimLintStores {
  const settings = new Map<string, LintConfig>();
  const accepted = new Map<string, Map<string, LintAcceptance>>();
  const modelKey = (projectId: string, modelId: string) => `${projectId}|${modelId}`;
  const acceptedOn = (projectId: string, modelId: string) => {
    const key = modelKey(projectId, modelId);
    let rows = accepted.get(key);
    if (!rows) {
      rows = new Map();
      accepted.set(key, rows);
    }
    return rows;
  };
  const checkReason = (reason: string) => {
    const problem = acceptanceReasonProblem(reason);
    if (problem) throw new Error(problem);
  };
  return {
    async settings(extra, projectId, modelId) {
      const key = modelKey(projectId, modelId);
      return settings.get(`${key}|thread:${thread(extra)}`) ?? settings.get(`${key}|person:${who(extra)}`) ?? DEFAULT_LINT_CONFIG;
    },
    async saveSettings(extra, projectId, modelId, config, scope) {
      const key = `${modelKey(projectId, modelId)}|${scope === "thread" ? `thread:${thread(extra)}` : `person:${who(extra)}`}`;
      if (config === null) settings.delete(key);
      else settings.set(key, lintConfigSchema.parse(config));
    },
    async acceptedIds(_extra, projectId, modelId) {
      return new Set(acceptedOn(projectId, modelId).keys());
    },
    async acceptances(_extra, projectId, modelId) {
      return [...acceptedOn(projectId, modelId).values()].reverse();
    },
    async accept(extra, projectId, modelId, a) {
      const reason = a.reason.trim();
      checkReason(reason);
      const row: LintAcceptance = { findingId: a.findingId, rule: a.rule, reason, acceptedBy: who(extra), acceptedAt: new Date().toISOString() };
      acceptedOn(projectId, modelId).set(a.findingId, row);
      return row;
    },
    async retract(extra, projectId, modelId, r) {
      const reason = r.reason.trim();
      checkReason(reason);
      const rows = acceptedOn(projectId, modelId);
      const row = rows.get(r.findingId);
      if (!row) throw new Error(`No active acceptance of ${r.findingId} on this model: it was never accepted or was already retracted.`);
      rows.delete(r.findingId);
      const out: LintRetraction = { ...row, retractedBy: who(extra), retractedAt: new Date().toISOString(), retractReason: reason };
      return out;
    },
    async linked() {
      return { models: [], note: null, coverage: "none", expected: 0 };
    },
    async projectName() {
      return null;
    },
  };
}

/** A fresh engine for every explicit check; a local server keeps no edit log, so no recent edits and no automatic pictures. */
export const localLintEngines: LintEngines = {
  engineForCheck(_cacheKey, model, linked) {
    const engine = new LintEngine();
    engine.build(model, linked);
    return engine;
  },
  recentEdits() {
    return [];
  },
  autoPicture: { everyEdits: 5, everyMs: 60_000 },
};

/** A local server draws no status pictures; the answer lists none. */
export const noStatusPictures: StatusPictures = async () => [];

export function localLintTools(stores: BimLintStores = memoryLintStores()): LintToolsHost {
  return { stores, engines: localLintEngines, pictures: noStatusPictures };
}

/** A local server has no linked models: surfaces come from the model alone. */
export const noLinkedSurfaces: LinkedSurfaceSources = async () => ({ sources: [], note: null });

/** The local model server has no branches; asking for one refuses in plain words. */
export const noBranchActions: BranchActions = async () => ({
  async start() {
    return { status: "refused", message: "Branches need a hosted MutinyBIM model server; this local server edits Main only." };
  },
  async proposeMerge() {
    return { status: "refused", message: "Branches need a hosted MutinyBIM model server; this local server edits Main only." };
  },
});
