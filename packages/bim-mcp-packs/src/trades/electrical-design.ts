import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { schemaOnce, schemaOnce2 } from "../support/edit-schemas";
import { resolveNecEdition, type NecEditionYear } from "@permitzip/bim-calc";
import { necElectricalRules, CONNECTED_LOAD_ONLY, ElectricalLoadEngine, distributionEquipment, distributionOf, electricalCatalog, electricalCheck, feederProposal, findPanelId, findRoomId, planCircuitTemplate, planRebalance, DESIGN_EDIT_ARGS, COMMAND_FAMILY_COPY, ELECTRICAL_TOOL_ARGS, ELECTRICAL_TOOL_GROUPS, circuitTemplateOf, circuitTemplates } from "@permitzip/bim-pack-electrical";
import { type Command, type ModelState } from "@permitzip/bim-kernel";
import { baseRevision as shortBaseRevision, tradeBaseRevision as baseRevision, explain, failure, runEdit, target as shortTarget, tradeTarget as target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import { commandFamilies, commandFamily } from "../parts/describe-commands";
import type { ProjectAdoptionLookup } from "../calc/capabilities";
import { noAdoptedElectricalCode } from "../calc/local";
import { BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES, type BimElectricalDesignEditToolName } from "../support/tool-names";
import { registerPackTools, type HostedPackTool } from "../calc/pack-tools";

/**
 * Electrical design records and whole-panel actions for agents: the
 * project's connection types, feeder types and room templates (the
 * catalog), rebalancing a panel's phases, and applying a room template to
 * units the person names. Every edit is the same kernel command the Building
 * Model's Electrical tab sends. Room templates take the person's rooms and
 * the panel they name for each unit; nothing here groups devices by where
 * they are or picks a panel (a product design rule).
 */

/** Arguments of each design edit (declared by the Electrical add-on). */
export { DESIGN_EDIT_ARGS };

const findPanel = findPanelId;
const findRoom = findRoomId;

const bad = (tool: string, issues: readonly z.core.$ZodIssue[]) => `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;

const isDesignTool = (tool: string): tool is keyof typeof DESIGN_EDIT_ARGS => Object.hasOwn(DESIGN_EDIT_ARGS, tool);

/** The design edits' short-form arguments: the add-on names the field, its words and its variants; the full schema is the add-on's too. */
const SHORT_FORMS = COMMAND_FAMILY_COPY.flatMap((f) => {
  const tool = isDesignTool(f.tool) ? f.tool : undefined;
  const full: unknown = tool ? (DESIGN_EDIT_ARGS[tool] as z.ZodRawShape)[f.field] : undefined;
  const schema: unknown = full instanceof z.ZodOptional ? full.unwrap() : undefined;
  return tool && full instanceof z.ZodOptional && schema instanceof z.ZodType && f.discriminator && f.variants ? [{ ...f, tool, full, schema }] : [];
});

const exactFields = (f: (typeof SHORT_FORMS)[number]) => `Exact fields: bim_describe_commands({ tool: "${f.tool}", field: "${f.field}", variant: "<${f.discriminator}>" }).`;

for (const f of SHORT_FORMS) commandFamily({ tool: f.tool, field: f.field, label: f.label, schema: f.schema, ...(f.discriminator ? { discriminator: f.discriminator } : {}) });

/**
 * What a design edit advertises where it differs from its full schema.
 * designCommand parses with DESIGN_EDIT_ARGS either way; a misfit names the
 * field.
 */
// Built on first use, so the shared target and revision shapes have loaded.
const advertisedDesignArgs = (): Partial<Record<string, z.ZodRawShape>> =>
  Object.fromEntries(
    SHORT_FORMS.map((f) => [
      f.tool,
      {
        ...shortTarget,
        ...shortBaseRevision,
        ...DESIGN_EDIT_ARGS[f.tool],
        [f.field]: z
          .object({ [f.discriminator ?? "type"]: z.enum(f.variants ?? [""]) })
          .catchall(z.unknown())
          .optional()
          .describe(`${f.full.description ?? ""} ${exactFields(f)}`),
      },
    ]),
  );

/** The short form's pointer to the exact fields, when a misfit is in a short-form field. */
function shortFormHint(tool: string, issues: readonly z.core.$ZodIssue[]): string {
  const f = SHORT_FORMS.find((x) => x.tool === tool && issues.some((i) => i.path[0] === x.field));
  return f && commandFamilies(tool).length > 0 ? `. ${exactFields(f)}` : "";
}

export interface DesignEdit {
  readonly command: Command;
  /** What the person approves, beyond the command: the moves, the circuits per unit. */
  readonly plan?: unknown;
}

/** The kernel command a design edit sends (built from the model at the revision read), or why not. */
export function designCommand(tool: BimElectricalDesignEditToolName, raw: unknown, model: ModelState): DesignEdit | string {
  const elements = model.elements;
  switch (tool) {
    case "bim_rebalance_panel": {
      const parsed = schemaOnce(DESIGN_EDIT_ARGS.bim_rebalance_panel).safeParse(raw);
      if (!parsed.success) return bad(tool, parsed.error.issues);
      const panelId = findPanel(elements, parsed.data.panel);
      if (!panelId) return `No panel "${parsed.data.panel}". Distribution equipment here: ${distributionEquipment(elements).map((d) => d.name).join(", ") || "none yet"}.`;
      const plan = planRebalance(elements, panelId, { ...(parsed.data.keep_circuits ? { keep: parsed.data.keep_circuits } : {}), ...(parsed.data.max_moves ? { maxMoves: parsed.data.max_moves } : {}) });
      if (!plan) return `${parsed.data.panel} has no slots to rebalance.`;
      if (!plan.command) return `Not saved: ${plan.message}`;
      return { command: plan.command, plan: { message: plan.message, before: plan.before, after: plan.after, moves: plan.moves.map((m) => ({ circuit_id: m.linkId, from: m.from, to: m.to, description: m.description, va: m.va, phases: `${m.fromPhases.join("")} → ${m.toPhases.join("")}` })) } };
    }
    case "bim_save_electrical_type": {
      const parsed = schemaOnce(DESIGN_EDIT_ARGS.bim_save_electrical_type).safeParse(raw);
      if (!parsed.success) return `${bad(tool, parsed.error.issues)}${shortFormHint(tool, parsed.error.issues)}`;
      const a = parsed.data;
      if (a.delete && a.entry) return "Give entry to save or delete to remove, not both.";
      if (a.delete) return { command: { type: "delete_catalog_entry", entryType: a.delete.type, name: a.delete.name } };
      if (!a.entry) return "Give the record to save (entry), or delete.";
      return { command: { type: "save_catalog_entry", entry: a.entry, ...(a.replaces ? { replaces: a.replaces } : {}) } };
    }
    case "bim_apply_circuit_template": {
      const parsed = schemaOnce(DESIGN_EDIT_ARGS.bim_apply_circuit_template).safeParse(raw);
      if (!parsed.success) return bad(tool, parsed.error.issues);
      const template = circuitTemplateOf(elements, parsed.data.template);
      if (!template) return `No room template "${parsed.data.template}". Templates here: ${circuitTemplates(model).map((t) => t.entry.name).join(", ") || "none yet (save one with bim_save_electrical_type)"}.`;
      const units = [];
      for (const u of parsed.data.units) {
        const panelId = findPanel(elements, u.panel);
        if (!panelId) return `No panel "${u.panel}". Ask the person which panel serves that unit; never pick one yourself.`;
        const roomIds: string[] = [];
        for (const r of u.rooms) {
          const id = findRoom(elements, r);
          if (!id) return `No room "${r}" (give a room id or number from bim_query_elements kind room).`;
          roomIds.push(id);
        }
        units.push({ panelId, roomIds, ...(u.label ? { label: u.label } : {}) });
      }
      const plan = planCircuitTemplate(model, template, units);
      const summary = {
        message: plan.message,
        units: plan.units.map((u) => ({
          unit: u.label,
          panel: u.panelName,
          circuits: u.circuits.map((c) => ({ rooms: c.rooms, circuit: c.name, devices: c.memberIds.length, description: c.description, ...(c.refusal ? { refused: c.refusal } : {}) })),
          ...(u.unmatchedRooms.length > 0 ? { rooms_no_rule_matched: u.unmatchedRooms } : {}),
          ...(u.skipped.length > 0 ? { left_alone: u.skipped } : {}),
        })),
      };
      if (!plan.command) return `Not saved: ${plan.message} ${JSON.stringify(summary.units)}`;
      return { command: plan.command, plan: summary };
    }
  }
}

async function editionFor(extra: Extra, projectId: string, nec: NecEditionYear | undefined, projectAdoption: ProjectAdoptionLookup) {
  const adoption = nec ? null : await projectAdoption(extra, projectId);
  return resolveNecEdition({ necEdition: nec, projectAdoption: adoption });
}

const catalogOut = electricalCatalog;

export function registerBimElectricalDesignTools(server: McpServer, caller: ResolveBimCaller, options: { projectAdoption?: ProjectAdoptionLookup } = {}) {
  const projectAdoption = options.projectAdoption ?? noAdoptedElectricalCode;

  const catalog: HostedPackTool = (copy) =>
    server.registerTool("bim_electrical_catalog", { ...copy, inputSchema: { ...target, ...ELECTRICAL_TOOL_ARGS.bim_electrical_catalog } }, async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const needsCode = args.size_feeder_for !== undefined || args.check === true;
        const edition = needsCode ? await editionFor(extra, args.project_id, args.nec_edition, projectAdoption) : null;
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const out: Record<string, unknown> = { revision: model.revision, ...catalogOut(model, args.kind ?? "all") };
          const rules = edition?.ok ? necElectricalRules(edition.edition) : CONNECTED_LOAD_ONLY;
          if (args.check) out.check = electricalCheck(new ElectricalLoadEngine(rules), model).map((i) => ({ severity: i.severity, says: i.message, select: i.elementIds.slice(0, 50) }));
          if (args.size_feeder_for) {
            const panelId = findPanel(model.elements, args.size_feeder_for);
            const part = panelId ? model.elements[panelId] : undefined;
            const info = part?.kind === "part" ? distributionOf(model.elements, part) : null;
            if (!panelId || !info) return failure(`No panel "${args.size_feeder_for}".`);
            if (!edition?.ok) return failure(`Not sized: ${edition?.ok === false ? edition.reason : "no NEC edition"} Give nec_edition or record the project's adopted code.`);
            const sized = feederProposal(model, edition.edition, panelId, { ...(args.length_ft ? { lengthFt: args.length_ft } : {}), ...(args.material ? { material: args.material } : {}), ...(args.conduit ? { conduit: args.conduit } : {}) });
            if (!("for" in sized)) return failure(sized.refused);
            out.feeder_proposal = "entry" in sized ? { ...sized, to_save: { tool: "bim_save_electrical_type", arguments: { entry: sized.entry } } } : sized;
          }
          return text(out);
        });
      } catch (err) {
        return explain(err, "bim_electrical_catalog");
      }
    });

  const designEdit =
    (tool: BimElectricalDesignEditToolName): HostedPackTool =>
    (copy) =>
      server.registerTool(tool, { ...copy, inputSchema: advertisedDesignArgs()[tool] ?? { ...target, ...baseRevision, ...DESIGN_EDIT_ARGS[tool] } }, async (raw: Record<string, unknown>, extra: Extra) => {
      const where = schemaOnce2(target, baseRevision).safeParse(raw);
      if (!where.success) return failure(`Those arguments don't fit ${tool}: ${where.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const args = where.data;
      let model: ModelState;
      try {
        const who = await caller(extra, args.project_id, false);
        model = await withSession(who, args.model_id, undefined, async (s) => s.model());
      } catch (err) {
        return explain(err, tool);
      }
      const built = designCommand(tool, raw, model);
      if (typeof built === "string") return failure(built);
      return runEdit(caller, tool, extra, { ...args, base_revision: args.base_revision ?? model.revision }, built.command);
    });

  // Each needs the project's adopted NEC edition or builds its command from the open model: hosted here.
  registerPackTools(server, caller, "electrical", {
    only: ELECTRICAL_TOOL_GROUPS.design,
    hosted: { bim_electrical_catalog: catalog, ...Object.fromEntries(BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES.map((tool) => [tool, designEdit(tool)])) },
  });
}

