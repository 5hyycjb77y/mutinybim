import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { lintConfigSchema, LintDeadline, RULESETS, SNAPSHOT_MODES, blockFinding, type Finding, type LintConfig, type LintEngine } from "@permitzip/bim-lint";
import { elementsOfKind, type ModelState } from "@permitzip/bim-kernel";
import { summarizeModel } from "@permitzip/bim-sync";
import { withPinnedPacks } from "@permitzip/bim-editor/contracts/building-model/installed-packs";
import { acceptanceReasonProblem } from "./acceptance-reason";
import type { LinkedForLint, LintEngines, LintToolsHost } from "./capabilities";
import { explain, failure, target, text, withSession, type ResolveBimCaller } from "../runtime";
import { resolveAreaLevel } from "@permitzip/bim-mcp";

/**
 * Coordination lint tools. The `lint` block on every saved edit is the
 * everyday read; these set it up once per session, read everything in a
 * scope, take a status picture, and accept a finding with a reason or
 * retract an acceptance (the same ones people make in Manage › Coordination).
 */

const CHECK_BUDGET_MS = 4000;
/**
 * An explicit check waits this long for linked models still being indexed
 * (one IFC takes seconds), well inside the BIM tools' 120 s call limit. The
 * lint on a saved edit never waits.
 */
export const LINKED_WAIT_MS = 25_000;
const PAGE = 25;

/** The linked-model part of a check's answer: words for the message, fields for the agent, and whether coverage is short. */
export function linkedCoverage(linked: LinkedForLint, included: boolean): { readonly words: string; readonly short: boolean; readonly fields: Record<string, unknown> } {
  if (!included) return { words: "linked models excluded", short: false, fields: {} };
  const loaded = linked.models.length;
  const fields = { linked_coverage: linked.coverage, linked_models: { loaded, expected: linked.expected } };
  const of = `${loaded} of ${linked.expected ?? "the"} linked model(s)`;
  switch (linked.coverage) {
    case "complete":
      return { words: `with ${loaded} linked model(s)`, short: false, fields };
    case "none":
      return { words: "with no linked models on this project", short: false, fields };
    case "indexing":
      return { words: `linked coverage INCOMPLETE: ${of} still being indexed; re-run bim_lint_check in a minute before calling anything clash-free`, short: true, fields };
    case "incomplete":
      return { words: `linked coverage INCOMPLETE: ${of} in the check${linked.note ? ` (${linked.note})` : ""}`, short: true, fields };
  }
}

const settingsInput = {
  ruleset: z.enum(RULESETS).optional(),
  tolerance_in: z.number().min(0).max(12).optional(),
  soft_clearance_in: z.number().min(0).max(24).optional(),
  structure_clearance_in: z.number().min(0).max(24).optional(),
  scope_radius_ft: z.number().min(1).max(200).optional(),
  include_linked: z.boolean().optional(),
  max_findings: z.number().int().min(1).max(8).optional(),
  snapshot: z.enum(SNAPSHOT_MODES).optional(),
  disabled_rules: z.array(z.string().min(1).max(60)).max(40).optional(),
};

/**
 * Our element ids a finding id names (`rule:a|b|linked:G`, see findingId).
 * A shortened id (`…#hash`) loses its tail, so its last, cut part is dropped.
 */
export function findingIdElementIds(findingId: string): string[] {
  const colon = findingId.indexOf(":");
  if (colon <= 0) return [];
  const shortened = /#[0-9a-f]{1,8}$/.test(findingId);
  const body = shortened ? findingId.slice(colon + 1, findingId.lastIndexOf("#")) : findingId.slice(colon + 1);
  const parts = body.split("|");
  if (shortened) parts.pop();
  return parts.filter((p) => p.length > 0 && !p.startsWith("linked:"));
}

export type FindingLookup = { readonly status: "found"; readonly finding: Finding } | { readonly status: "missing" } | { readonly status: "unconfirmed" };

/**
 * Whether `findingId` is one of the model's findings now, under any ruleset
 * and with or without linked models (an id from any bim_lint_check counts).
 * Accepted findings count too, so a re-accept can change the reason. The
 * elements it names are checked first; the whole model only if that misses.
 * "unconfirmed" when the whole-model check ran out of time.
 */
export function lookupCurrentFinding(engine: LintEngine, model: ModelState, base: LintConfig, findingId: string, budgetMs = CHECK_BUDGET_MS): FindingLookup {
  const configs: LintConfig[] = [true, false].map((linked) => ({ ...base, ruleset: "issue", disabled_rules: [], include_linked: linked }));
  const none: ReadonlySet<string> = new Set();
  const ids = findingIdElementIds(findingId).filter((id) => model.elements[id] !== undefined);
  if (ids.length > 0) {
    for (const config of configs) {
      const hit = withPinnedPacks(model, () => engine.check({ config, accepted: none, includeAccepted: true, ids })).find((f) => f.id === findingId);
      if (hit) return { status: "found", finding: hit };
    }
  }
  const deadline = performance.now() + budgetMs;
  try {
    for (const config of configs) {
      const hit = withPinnedPacks(model, () => engine.check({ config, accepted: none, includeAccepted: true, deadline })).find((f) => f.id === findingId);
      if (hit) return { status: "found", finding: hit };
    }
  } catch (err) {
    if (!(err instanceof LintDeadline)) throw err;
    return { status: "unconfirmed" };
  }
  return { status: "missing" };
}

function summary(findings: readonly Finding[]) {
  const byRule: Record<string, number> = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return { errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warning").length, by_rule: byRule };
}

/** What the snapshot setting does for this thread, in words. */
async function snapshotNote(mode: LintConfig["snapshot"], seesImages: () => Promise<boolean>, every: LintEngines["autoPicture"]): Promise<string> {
  if (mode === "after_edit") return "a picture after every saved edit";
  if (mode === "on_request") return "pictures only from bim_status_snapshot";
  if (mode === "off") return "no pictures";
  return (await seesImages())
    ? `a picture every ${every.everyEdits} saved edits or ${every.everyMs / 1000} s`
    : "no automatic pictures: this thread's model doesn't read images (bim_status_snapshot still draws them)";
}

/** Validate without saving; the agent runs this before showing the Approve card. */
const checkOnly = z.boolean().optional().describe("true: check only, save nothing.");

export function registerBimLintTools(server: McpServer, caller: ResolveBimCaller, host: LintToolsHost) {
  const { stores, engines } = host;
  const engineForCheck = engines.engineForCheck.bind(engines);
  server.registerTool(
    "bim_lint_configure",
    {
      title: "Set up the coordination lint",
      description:
        "Once per session: how each saved edit's `lint` block checks (defaults: tolerance 0.5 in., clearances 1 in. services / 2 in. structure, radius 10 ft; snapshot after_edit adds a picture). Saved per thread (for=me: your model default). Returns settings and rules not available.",
      inputSchema: { ...target, ...settingsInput, for: z.enum(["thread", "me"]).optional(), reset: z.boolean().optional() },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const current = await stores.settings(extra, args.project_id, args.model_id);
        const { project_id: projectId, model_id: modelId, for: scope, reset, ...changes } = args;
        const next: LintConfig | null = reset ? null : lintConfigSchema.parse({ ...current, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) });
        await stores.saveSettings(extra, projectId, modelId, next, scope === "me" ? "person" : "thread");
        const effective = next ?? (await stores.settings(extra, projectId, modelId));
        const availability = await withSession(who, modelId, undefined, async (s) => {
          const linked = await stores.linked(extra, projectId);
          const engine = engineForCheck(`${projectId}:${modelId}`, s.model(), linked.models);
          return { rules: withPinnedPacks(s.model(), () => engine.availability(effective)), linkedNote: linked.note };
        });
        const pictures = await snapshotNote(effective.snapshot, () => stores.seesImages?.(extra, projectId) ?? Promise.resolve(false), engines.autoPicture);
        return text({
          status: "saved",
          message: `Lint set for ${scope === "me" ? "you on this model" : "this thread"}: ${effective.ruleset}, ${effective.tolerance_in} in. tolerance, ${effective.soft_clearance_in} in. clearance, ${effective.scope_radius_ft} ft around each edit, linked models ${effective.include_linked ? "included" : "excluded"}, ${pictures}.`,
          settings: effective,
          not_available: availability.rules.filter((r) => !r.available).map((r) => ({ rule: r.rule, why: r.reason })),
          ...(availability.linkedNote ? { linked: availability.linkedNote } : {}),
        });
      } catch (err) {
        return explain(err, "bim_lint_configure");
      }
    },
  );

  server.registerTool(
    "bim_lint_check",
    {
      title: "Check the model for clashes and coordination issues",
      description:
        "Every finding on the model, a level, or around ids, with the ruleset and tolerance used. Required (include_linked) before calling anything clash-free; ruleset issue before issuing. 25 a page.",
      inputSchema: {
        ...target,
        ids: z.array(z.string().min(1).max(200)).max(200).optional(),
        level: z.string().min(1).max(80).optional().describe("Level name or id."),
        ruleset: z.enum(RULESETS).optional(),
        include_linked: z.boolean().optional(),
        include_accepted: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const settings = stores.settings(extra, args.project_id, args.model_id);
        // An explicit check with linked models waits for them (bounded); the lint on a saved edit never does.
        const withLinked = settings.then((c) => args.include_linked ?? c.include_linked);
        const [config, accepted, linked] = await Promise.all([settings, stores.acceptedIds(extra, args.project_id, args.model_id), withLinked.then((wait) => stores.linked(extra, args.project_id, wait ? { waitMs: LINKED_WAIT_MS } : {}))]);
        const cfg: LintConfig = { ...config, ...(args.ruleset ? { ruleset: args.ruleset } : {}), ...(args.include_linked !== undefined ? { include_linked: args.include_linked } : {}) };
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const level = args.level === undefined ? null : resolveAreaLevel(model, args.level);
          if (level && !level.ok) return failure(level.message);
          const levelName = level?.name;
          const engine = engineForCheck(`${args.project_id}:${args.model_id}`, model, linked.models);
          let findings: Finding[];
          let partial = false;
          try {
            findings = withPinnedPacks(model, () => engine.check({ config: cfg, accepted, includeAccepted: args.include_accepted ?? false, deadline: performance.now() + CHECK_BUDGET_MS, ...(levelName ? { level: levelName } : {}), ...(args.ids ? { ids: args.ids } : {}) }));
          } catch (err) {
            if (!(err instanceof LintDeadline)) throw err;
            partial = true;
            findings = withPinnedPacks(model, () => engine.check({ config: cfg, accepted, includeAccepted: args.include_accepted ?? false, ids: args.ids ?? [], ...(levelName ? { level: levelName } : {}) }));
          }
          const offset = args.offset ?? 0;
          const page = findings.slice(offset, offset + PAGE);
          const scope = args.ids ? `around ${args.ids.length} element(s)` : levelName ? `on ${levelName}` : "on the whole model";
          const coverage = linkedCoverage(linked, cfg.include_linked);
          return text({
            status: partial || coverage.short ? "partial" : "checked",
            message: `${findings.length === 0 ? "No findings" : `${summary(findings).errors} errors, ${summary(findings).warnings} warnings`} ${scope} at Rev ${model.revision}, ruleset ${cfg.ruleset}, ${cfg.tolerance_in} in. tolerance, ${coverage.words}.${partial ? " The whole-model check ran past its time; narrow it by level or ids." : ""}`,
            revision: model.revision,
            ruleset: cfg.ruleset,
            tolerance_in: cfg.tolerance_in,
            include_linked: cfg.include_linked,
            ...coverage.fields,
            total: findings.length,
            ...summary(findings),
            accepted_hidden: args.include_accepted ? 0 : accepted.size,
            findings: page.map((f) => ({ id: f.id, ...blockFinding(f), at: f.at })),
            ...(findings.length > offset + PAGE ? { next_offset: offset + PAGE } : {}),
            not_available: withPinnedPacks(model, () => engine.availability(cfg)).filter((r) => !r.available).map((r) => r.rule),
            ...(linked.note ? { linked: linked.note } : {}),
          });
        });
      } catch (err) {
        return explain(err, "bim_lint_check");
      }
    },
  );

  server.registerTool(
    "bim_status_snapshot",
    {
      title: "Status with pictures",
      description:
        "End of a batch: counts, findings by rule, this thread's last edits, up to 3 small pictures (last-edited plan, sheet, a 3D view, or those named). Say what you see.",
      inputSchema: { ...target, views: z.array(z.string().min(1).max(200)).max(3).optional(), sheets: z.array(z.string().min(1).max(200)).max(3).optional(), max_images: z.number().int().min(0).max(3).optional() },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const settings = stores.settings(extra, args.project_id, args.model_id);
        const [config, accepted, linked] = await Promise.all([settings, stores.acceptedIds(extra, args.project_id, args.model_id), settings.then((c) => stores.linked(extra, args.project_id, c.include_linked ? { waitMs: LINKED_WAIT_MS } : {}))]);
        const coverage = linkedCoverage(linked, config.include_linked);
        const edits = engines.recentEdits(extra, args.model_id);
        const out = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const engine = engineForCheck(`${args.project_id}:${args.model_id}`, model, linked.models);
          let findings: Finding[] = [];
          let partial = false;
          try {
            findings = withPinnedPacks(model, () => engine.check({ config, accepted, deadline: performance.now() + CHECK_BUDGET_MS }));
          } catch (err) {
            if (!(err instanceof LintDeadline)) throw err;
            partial = true;
          }
          const resolveIds = (names: readonly string[] | undefined, kind: "view" | "sheet") => {
            // One indexed read per kind (elementsOfKind) instead of a full
            // model scan per name — the no-full-model-scan guard's contract.
            const candidates = elementsOfKind(model.elements, kind);
            return (names ?? []).map((n) => candidates.find((e) => e.id === n || (e.kind === "view" ? e.name === n : e.number === n || e.title === n))?.id ?? n);
          };
          const pictures = await host.pictures(model, edits.flatMap((e) => e.changed), args.max_images ?? 3, { views: resolveIds(args.views, "view"), sheets: resolveIds(args.sheets, "sheet") });
          return { model, findings, partial, pictures };
        });
        const sum = summary(out.findings);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "read",
                revision: out.model.revision,
                counts: summarizeModel(out.model),
                findings: out.partial
                  ? { status: "partial", message: "The whole-model check ran past its time; use bim_lint_check by level", ...coverage.fields }
                  : { ...sum, ruleset: config.ruleset, tolerance_in: config.tolerance_in, accepted_hidden: accepted.size, ...coverage.fields, ...(coverage.short ? { status: "partial", message: `Counts ${coverage.words}.` } : {}) },
                last_edits: edits.slice(-10).map((e) => ({ tool: e.tool, rev: e.revision, changed: e.changed.slice(0, 8), at: e.at })),
                pictures: out.pictures.map((p) => p.meta),
              },
              null,
              2,
            ),
          },
        ];
        for (const p of out.pictures) if (p.image) content.push({ type: "image", data: p.image.toString("base64"), mimeType: "image/png" });
        return { content };
      } catch (err) {
        return explain(err, "bim_status_snapshot");
      }
    },
  );

  server.registerTool(
    "bim_lint_accept_finding",
    {
      title: "Accept a coordination finding",
      description: "Accept a finding with the person's reason (hidden for everyone until its elements change). Only when the person says so. finding_id must be an id from bim_lint_check now; any other id is refused.",
      inputSchema: { ...target, finding_id: z.string().min(1).max(200), reason: z.string().trim().min(3).max(500), check_only: checkOnly },
    },
    async (args, extra) => {
      try {
        const reasonProblem = acceptanceReasonProblem(args.reason);
        if (reasonProblem) return text({ status: "refused", code: "lint_reason_missing", message: `Not accepted: ${reasonProblem} Nothing changed.` });
        const who = await caller(extra, args.project_id, true);
        // The lookup checks with and without linked models, so it waits for them like an explicit check.
        const [config, linked] = await Promise.all([stores.settings(extra, args.project_id, args.model_id), stores.linked(extra, args.project_id, { waitMs: LINKED_WAIT_MS })]);
        const looked = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const engine = engineForCheck(`${args.project_id}:${args.model_id}`, model, linked.models);
          return { revision: model.revision, lookup: lookupCurrentFinding(engine, model, config, args.finding_id) };
        });
        if (looked.lookup.status === "missing") {
          return text({
            status: "refused",
            code: "lint_finding_not_current",
            message: `Not accepted: ${args.finding_id} isn't a finding on this model at Rev ${looked.revision}. Run bim_lint_check and accept an id from its findings. Nothing changed.`,
          });
        }
        if (looked.lookup.status === "unconfirmed") {
          return text({
            status: "refused",
            code: "lint_finding_unconfirmed",
            message: `Not accepted: the check for ${args.finding_id} ran out of time on this model. Run bim_lint_check by level or around its elements and accept an id from those findings. Nothing changed.`,
          });
        }
        const finding = looked.lookup.finding;
        if (args.check_only === true) {
          return text({ status: "checked", message: `${finding.id} is a current finding (${finding.message}); it can be accepted. Nothing saved.` });
        }
        const saved = await stores.accept(extra, args.project_id, args.model_id, { findingId: finding.id, rule: finding.rule, reason: args.reason });
        return text({ status: "saved", message: `Accepted ${finding.id} (${finding.message}): ${saved.reason}`, acceptance: saved });
      } catch (err) {
        return explain(err, "bim_lint_accept_finding");
      }
    },
  );

  server.registerTool(
    "bim_lint_retract_acceptance",
    {
      title: "Retract an accepted coordination finding",
      description: "Undo an acceptance (one made by mistake, or no longer true) with the person's reason: the finding shows again; who accepted, who retracted and why are kept. Only when the person says so.",
      inputSchema: { ...target, finding_id: z.string().min(1).max(200), reason: z.string().trim().min(3).max(500), check_only: checkOnly },
    },
    async (args, extra) => {
      try {
        const reasonProblem = acceptanceReasonProblem(args.reason);
        if (reasonProblem) return text({ status: "refused", code: "lint_reason_missing", message: `Not retracted: ${reasonProblem} Nothing changed.` });
        await caller(extra, args.project_id, true);
        const active = await stores.acceptances(extra, args.project_id, args.model_id);
        if (!active.some((a) => a.findingId === args.finding_id)) {
          const listed = active.slice(0, 10).map((a) => a.findingId);
          return text({
            status: "refused",
            code: "lint_acceptance_not_found",
            message: `Not retracted: ${args.finding_id} has no active acceptance on this model. ${listed.length > 0 ? `Accepted now: ${listed.join(", ")}${active.length > listed.length ? ` and ${active.length - listed.length} more` : ""}.` : "Nothing is accepted on this model."} Nothing changed.`,
          });
        }
        if (args.check_only === true) {
          return text({ status: "checked", message: `${args.finding_id} has an active acceptance; it can be retracted. Nothing saved.` });
        }
        const retracted = await stores.retract(extra, args.project_id, args.model_id, { findingId: args.finding_id, reason: args.reason });
        return text({ status: "saved", message: `Retracted the acceptance of ${retracted.findingId} (accepted ${retracted.acceptedAt}: "${retracted.reason}"): ${retracted.retractReason}. It shows again for people and agents.`, retraction: retracted });
      } catch (err) {
        return explain(err, "bim_lint_retract_acceptance");
      }
    },
  );
}

