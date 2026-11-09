import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ELEMENT_KINDS, buildClassIndex, builtinRegistry, type Discipline, type ModelState, type Registry } from "@permitzip/bim-kernel";
import { draftQuestionsEmail } from "@permitzip/bim-editor/contracts/bim/questions/draft-email";
import { inspectNetwork, queryElements, summarizeModel, validationIssues } from "@permitzip/bim-sync";
import { explain, failure, text } from "../answers";
import { READ_ONLY_TOOL } from "../annotations";
import type { ReadToolHost, RequirementsBinding } from "../host";
import { PROJECT_SCHEMAS, area, type CoreSchemas } from "../schemas";
import { notPlacedYet, questionsList, withDesignFacts } from "./design-reads";
import { agentImpactOfRemoving, agentWhy } from "./graph";

/**
 * The core reads: what is in the model, by kind, area and discipline; one
 * element's connected system; the open validation issues. Every answer
 * carries the revision it read, so an edit can pass base_revision.
 */

const DISCIPLINES = ["architecture", "structure", "mechanical", "plumbing", "electrical", "fire_protection"] as const satisfies readonly Discipline[];

/** Ids of the class's elements (its subclasses' too) under the registry, or the refusal naming classes close to what was asked. */
export function classMembers(registry: Registry, model: ModelState, classId: string): readonly string[] | string {
  const cls = registry.getClass(classId);
  if (!cls) {
    const tail = (classId.split(".").pop() ?? classId).toLowerCase();
    const stem = tail.slice(0, Math.max(4, tail.length - 2));
    const near = registry
      .listClasses()
      .map((c) => c.id)
      .filter((id) => id.toLowerCase().includes(stem))
      .slice(0, 8);
    return `No class ${classId}.${near.length > 0 ? ` Close: ${near.join(", ")}.` : ""} bim_schedule_fields (mutinybim-schedules) lists every class.`;
  }
  return buildClassIndex(registry, model)
    .elementsOf(cls.id)
    .map((el) => el.id);
}

const MODEL_OWN_REQUIREMENTS: RequirementsBinding = { note: null, withBound: (_model, ask) => ask() };

/** The summary and the element query: the reads every job starts with. */
export function registerBimSummaryReadTools(server: McpServer, host: ReadToolHost, options: { readonly schemas?: CoreSchemas } = {}): void {
  const target = (options.schemas ?? PROJECT_SCHEMAS).reads;
  server.registerTool(
    "bim_model_summary",
    {
      title: "Summarize a MutinyBIM model",
      annotations: READ_ONLY_TOOL,
      description:
        "Counts by element kind, the areas (level / zone / discipline) the model has, systems with their total airflow, open validation issues, the Not placed yet list (parts that exist before they are drawn, each with its circuit), open questions and assumptions, and the revision this was read at. Start here, then read one area at a time.",
      inputSchema: {
        ...target,
        ...area,
        questions: z.string().trim().min(1).max(60).optional().describe('"all": every question and assumption. An audience ("architect"): what is still worth asking them, and the email text to send (text only; nothing is sent or drafted in Front).'),
      },
    },
    async (args, extra) => {
      try {
        const ask = args.questions && args.questions.toLowerCase() !== "all" ? args.questions : null;
        return await host.withArea(extra, args, async (s) => {
          const projectName = (ask && host.reads?.projectLabel ? await host.reads.projectLabel(extra, args.project_id) : "") || "this project";
          const model = s.model();
          const questions = questionsList(model, args.questions?.toLowerCase() === "all" ? "all" : undefined);
          return text({
            ...summarizeModel(model),
            notPlacedYet: notPlacedYet(model),
            ...(questions.count > 0 || args.questions ? { questions } : {}),
            ...(ask ? { question_email: draftQuestionsEmail(model, { askOf: ask, projectName }) } : {}),
          });
        });
      } catch (err) {
        return explain(err, "bim_model_summary");
      }
    },
  );

  server.registerTool(
    "bim_query_elements",
    {
      title: "Find MutinyBIM elements",
      annotations: READ_ONLY_TOOL,
      description:
        "List elements by kind, class, area and discipline with the facts needed to plan an edit (sizes in inches, lengths and positions in feet, airflow in CFM). Returns the revision read and the total matched. Filter by level/zone on large models.",
      inputSchema: {
        ...target,
        ...area,
        kinds: z.array(z.enum(ELEMENT_KINDS)).max(ELEMENT_KINDS.length).optional(),
        class: z.string().min(1).max(120).optional().describe("A class id (built-in, add-on or firm, e.g. mep.receptacle): its elements and its subclasses'."),
        discipline: z.enum(DISCIPLINES).optional(),
        ids: z.array(z.string().min(1).max(200)).max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        why: z.boolean().optional().describe("Also why each listed element is here: the code requirements it serves, with citations (first 25)."),
        if_removed: z.array(z.string().min(1).max(200)).max(50).optional().describe("Element ids: what code requirements re-open, and the quantity changes, if they were taken out. Nothing changes."),
      },
    },
    async (args, extra) => {
      try {
        return await host.withArea(extra, args, async (s, level) => {
          const library = args.class ? await (host.reads?.classRegistry?.(extra, args.project_id) ?? Promise.resolve({ registry: builtinRegistry() })) : null;
          const study = args.why || args.if_removed ? await (host.reads?.requirements?.(extra, args.project_id) ?? Promise.resolve(MODEL_OWN_REQUIREMENTS)) : null;
          const model = s.model();
          let ids = args.ids;
          if (library && args.class) {
            const members = classMembers(library.registry, model, args.class);
            if (typeof members === "string") return failure(members);
            const of = new Set(members);
            ids = args.ids ? args.ids.filter((id) => of.has(id)) : [...members];
          }
          const found = withDesignFacts(queryElements(model, { kinds: args.kinds, level, zone: args.zone, discipline: args.discipline, ids, limit: args.limit }), model);
          const graph = study
            ? study.withBound(model, () => ({
                ...(args.why ? { why: agentWhy(model, found.rows.slice(0, 25).map((r) => r.id)) } : {}),
                ...(args.if_removed ? { if_removed: agentImpactOfRemoving(model, args.if_removed, `Take out ${args.if_removed.length} element${args.if_removed.length === 1 ? "" : "s"}`) } : {}),
                ...(study.note ? { code_study_note: study.note } : {}),
              }))
            : {};
          return text({ ...found, ...graph, ...(library && "warning" in library && library.warning ? { library_note: library.warning } : {}) });
        });
      } catch (err) {
        return explain(err, "bim_query_elements");
      }
    },
  );
}

/** One element's connected system and the open validation issues. */
export function registerBimNetworkReadTools(server: McpServer, host: ReadToolHost, options: { readonly schemas?: CoreSchemas } = {}): void {
  const target = (options.schemas ?? PROJECT_SCHEMAS).reads;
  server.registerTool(
    "bim_inspect_network",
    {
      title: "Inspect a connected system",
      annotations: READ_ONLY_TOOL,
      description:
        "For one element: what it connects to, and the path from it up to its equipment with airflow on each piece. Use before editing a branch, run or terminal.",
      inputSchema: { ...target, ...area, element_id: z.string().min(1).max(200) },
    },
    async (args, extra) => {
      try {
        return await host.withArea(extra, args, async (s) => {
          const found = inspectNetwork(s.model(), args.element_id);
          return found ? text(found) : failure(`No element ${args.element_id} in this model (or not in the area you loaded).`);
        });
      } catch (err) {
        return explain(err, "bim_inspect_network");
      }
    },
  );

  server.registerTool(
    "bim_validation_issues",
    {
      title: "List MutinyBIM validation issues",
      annotations: READ_ONLY_TOOL,
      description: "Open validation issues (disconnected connectors, undersized branches, …) with the elements involved and the revision read.",
      inputSchema: { ...target, ...area, limit: z.number().int().min(1).max(500).optional() },
    },
    async (args, extra) => {
      try {
        return await host.withArea(extra, args, async (s) => text(validationIssues(s.model(), args.limit)));
      } catch (err) {
        return explain(err, "bim_validation_issues");
      }
    },
  );
}
