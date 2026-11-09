import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { matchLinkedStorey, modelLevels, planLevelSync, type Command, type Level, type ModelState, type SyncStorey } from "@permitzip/bim-kernel";
import { listLevels } from "@permitzip/bim-sync";
import type { LinkedModelStoreys } from "@permitzip/bim-editor/contracts/building-model/linked-levels-contract";
import { baseRevision, explain, failure, runEdit, target, text, withSession, type ResolveBimCaller } from "../runtime";
import { resolveLevelRef } from "@permitzip/bim-mcp";
import { editWithModel } from "../views/views";
import type { LinkedStoreysFor } from "./capabilities";

/**
 * Levels from the building, for agents: the same storeys, preview and sync
 * the Add level dialog's "Use the architect's levels" uses, and moving or
 * renaming a level. Adding one level at a typed elevation is bim_create_level.
 */

const MM_PER_FT = 304.8;
const ft = (mm: number) => Math.round((mm / MM_PER_FT) * 1000) / 1000;

/** Level ids a sync would add: one per linked model and storey, so a retried call adds the same level, not a second one. */
export function syncLevelId(referenceId: string, storeyId: string): string {
  return `lvl-${referenceId.slice(0, 8)}-${storeyId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function storeysFor(source: LinkedModelStoreys): SyncStorey[] {
  return source.storeys.map((s) => ({ storeyId: s.storeyId, name: s.name, elevationMm: s.elevationMm, levelId: syncLevelId(source.referenceId, s.storeyId) }));
}

/** The linked model to take levels from: the one asked for, else the first with storeys (architecture first). */
function pickSource(models: readonly LinkedModelStoreys[], id: string | undefined): LinkedModelStoreys | string {
  if (id) return models.find((m) => m.referenceId === id) ?? `There is no linked model ${id} on this project. bim_list_levels lists them.`;
  return models.find((m) => m.storeys.length > 0) ?? (models.length === 0 ? "This project has no linked model to take levels from. Link the architect's model first." : `None of the linked models has storeys: ${models.map((m) => `${m.label}: ${m.problem ?? "no storeys"}`).join("; ")}`);
}

/**
 * How our levels meet one linked model's storeys, by the rule plan drawings
 * use (`matchLinkedStorey`): a person's choice kept on the level, the same
 * name (ignoring case and spacing), the same height, or the one storey near
 * enough. A level with none, or with two near enough, gets a question in the
 * view's properties; a match only by case works but is worth renaming.
 */
export function levelCoverage(levels: readonly Level[], m: LinkedModelStoreys) {
  const byCase: string[] = [];
  const missing: string[] = [];
  const questions: string[] = [];
  for (const l of levels) {
    const chosen = l.linkedStoreys?.[m.referenceId];
    const match = matchLinkedStorey(m.storeys, { level: l.name, levelElevationMm: l.elevationMm, ...(chosen ? { chosen } : {}), linkLabel: m.label });
    if (!match.ok) {
      missing.push(l.name);
      questions.push(match.question);
      continue;
    }
    if (match.how === "name" && match.storey.name !== l.name) byCase.push(`${l.name} matches its ${match.storey.name} only ignoring case or spacing`);
  }
  const has = m.storeys.map((s) => s.name).join(", ") || "no levels";
  return {
    ...(byCase.length > 0 ? { level_names_differ: byCase } : {}),
    ...(missing.length > 0
      ? { levels_without_storey: missing, drawings_note: `Plans of ${missing.join(", ")} ask which level of ${m.label} to draw (it has ${has}): ${questions.join(" ")} The person picks it in the view's properties, or set_level_linked_storey keeps the choice on the level.` }
      : {}),
  };
}

/** Model levels and, for each linked model, what syncing its storeys would do. */
export function describeLevels(model: ModelState, linked: readonly LinkedModelStoreys[]) {
  const planes = new Map(listLevels(model).levels.map((l) => [l.id, l.mounting_planes]));
  const ours = modelLevels(model);
  return {
    revision: model.revision,
    levels: modelLevels(model)
      .sort((a, b) => a.elevationMm - b.elevationMm)
      .map((l) => {
        const own = planes.get(l.id);
        return { id: l.id, name: l.name, elevation_ft: ft(l.elevationMm), ...(l.source ? { from_linked_model: l.source.referenceId, storey: l.source.storeyName } : {}), ...(own ? { mounting_planes: own } : {}) };
      }),
    linked_models: linked.map((m) => {
      const plan = m.storeys.length > 0 ? planLevelSync(model, m.referenceId, storeysFor(m)) : null;
      return {
        linked_model_id: m.referenceId,
        label: m.label,
        discipline: m.discipline,
        ...(m.problem ? { problem: m.problem } : {}),
        in_step: plan ? !plan.changes : null,
        storeys: (plan?.rows ?? []).map((r) => ({
          storey: r.storeyName,
          elevation_ft: ft(r.elevationMm),
          sync_would: r.action === "add" ? `add level ${r.name}` : r.action === "unchanged" ? "nothing (in step)" : r.action === "match" ? `tie your level ${r.name} to it${r.before && Math.abs(r.before.elevationMm - r.elevationMm) >= 0.5 ? `, moving it from ${ft(r.before.elevationMm)} ft` : ""}` : `update level ${r.before?.name ?? r.name}${r.before && r.before.name !== r.name ? ` (renamed ${r.name})` : ""}${r.before && Math.abs(r.before.elevationMm - r.elevationMm) >= 0.5 ? ` from ${ft(r.before.elevationMm)} ft` : ""}`,
          level_id: r.levelId,
        })),
        ...(plan && plan.orphaned.length > 0 ? { no_longer_in_linked_model: plan.orphaned.map((o) => o.name) } : {}),
        ...(m.storeys.length > 0 ? levelCoverage(ours, m) : {}),
      };
    }),
  };
}

export function registerBimLevelTools(server: McpServer, caller: ResolveBimCaller, loadStoreys: LinkedStoreysFor): void {
  server.registerTool(
    "bim_list_levels",
    {
      title: "List levels and the architect's storeys",
      description:
        "The model's levels (name, elevation in feet, and the linked storey a level was made from), and for each linked model its storeys placed where the model shows them, with what bim_sync_linked_levels would do to each. Read this before adding, moving or syncing levels.",
      inputSchema: { ...target },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const linked = await loadStoreys(extra, args.project_id);
        return await withSession(who, args.model_id, undefined, async (s) => text(describeLevels(s.model(), linked)));
      } catch (err) {
        return explain(err, "bim_list_levels");
      }
    },
  );

  server.registerTool(
    "bim_sync_linked_levels",
    {
      title: "Use the architect's levels",
      description:
        "Make the model's levels match a linked model's storeys in one undoable change: a level for each storey not yet made, and the levels made from storeys updated where the architect moved or renamed them. A level a person already made for the same floor (same name or elevation) is tied to the storey and keeps its name. Nothing is deleted; running it again when nothing changed is refused with that reason. Defaults to the architectural model.",
      inputSchema: {
        ...target,
        ...baseRevision,
        linked_model_id: z.string().min(1).max(200).optional().describe("Which linked model (bim_list_levels lists them). Default: the first architectural model with storeys."),
      },
    },
    async (args, extra) => {
      let command: Command;
      try {
        await caller(extra, args.project_id, true);
        const source = pickSource(await loadStoreys(extra, args.project_id), args.linked_model_id);
        if (typeof source === "string") return failure(`Not saved: ${source}`);
        command = { type: "sync_levels", referenceId: source.referenceId, storeys: storeysFor(source) };
      } catch (err) {
        return explain(err, "bim_sync_linked_levels");
      }
      return runEdit(caller, "bim_sync_linked_levels", extra, args, command);
    },
  );

  server.registerTool(
    "bim_update_level",
    {
      title: "Move or rename a level",
      description:
        "Move a level to a new floor elevation (feet) and/or rename it. Everything on the level moves with it (parts and runs keep their height above it); plans, schedules and elements that name the level follow a rename. Refused if another level has the name.",
      inputSchema: {
        ...target,
        ...baseRevision,
        level_id: z.string().min(1).max(200).describe("Level id or name (bim_list_levels)."),
        name: z.string().trim().min(1).max(40).optional(),
        elevation_ft: z.number().min(-3000).max(3000).optional(),
      },
    },
    async (args, extra) => {
      if (args.name === undefined && args.elevation_ft === undefined) return failure("Not saved: give a new name, a new elevation_ft, or both.");
      return editWithModel(caller, "bim_update_level", extra, args, (model): Command | string => {
        const level = resolveLevelRef(model, args.level_id);
        if (!level.ok) return level.message;
        return {
          type: "update_level",
          levelId: level.id,
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.elevation_ft !== undefined ? { elevationMm: args.elevation_ft * MM_PER_FT } : {}),
        };
      });
    },
  );
}
