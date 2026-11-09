import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { schemaOnce, schemaOnce2 } from "../support/edit-schemas";
import { resolveNecEdition, type NecEdition, type NecEditionYear } from "@permitzip/bim-calc";
import { necElectricalRules, nextStandardRating, CONNECTED_LOAD_ONLY, ElectricalLoadEngine, PHASE_NAMES, describeCircuit, distributionEquipment, electricalConnections, isCircuitableLoad, panelSchedule, planDedicatedCircuits, type DedicatedCircuitsPlan, type ElectricalNodeReport, type ElectricalRules, type LinkLoad, CIRCUIT_EDIT_ARGS, ELECTRICAL_TOOL_ARGS, ELECTRICAL_TOOL_GROUPS, OCCUPANCIES, conductorArgs, faultCurrentOut } from "@permitzip/bim-pack-electrical";
import { plannedPartGroups, type Command, type ModelState } from "@permitzip/bim-kernel";
import { tradeBaseRevision as baseRevision, explain, failure, runEdit, tradeTarget as target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import type { ProjectAdoptionLookup } from "../calc/capabilities";
import { noAdoptedElectricalCode } from "../calc/local";
import { BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES, BIM_ELECTRICAL_EDIT_TOOL_NAMES, type BimElectricalDesignEditToolName, type BimElectricalEditToolName } from "../support/tool-names";
import { registerPackTools, type HostedPackTool } from "../calc/pack-tools";
import { designCommand, registerBimElectricalDesignTools } from "./electrical-design";
import { registerBimElectricalProposeTools } from "./electrical-propose";

/**
 * Electrical distribution for agents: panel totals (connected, NEC demand,
 * per phase), true capacity with the limiting reason, findings, and the
 * circuits and feeders themselves. Circuit membership is exactly the elements
 * the person named (or confirmed from a proposal); nothing here groups
 * devices into circuits by where they are or picks a panel for them
 * (a product design rule).
 */

const r1 = (v: number) => Math.round(v * 10) / 10;

async function rulesFor(extra: Extra, projectId: string, args: { nec_edition?: NecEditionYear; state?: string; occupancy: (typeof OCCUPANCIES)[number] }, projectAdoption: ProjectAdoptionLookup): Promise<{ rules: ElectricalRules; code: string; nec: NecEdition | null }> {
  const adoption = args.nec_edition ? null : await projectAdoption(extra, projectId);
  const resolved = resolveNecEdition({ necEdition: args.nec_edition, projectAdoption: adoption, state: args.state });
  if (!resolved.ok) return { rules: CONNECTED_LOAD_ONLY, code: `No NEC edition: ${resolved.reason} These totals are connected loads only, not a code calculation.`, nec: null };
  return { rules: necElectricalRules(resolved.edition, { occupancy: args.occupancy }), code: `NEC ${resolved.edition.edition}${resolved.step ? ` (${resolved.step.detail})` : args.nec_edition ? " (asked for)" : ""}`, nec: resolved.edition };
}

/** How one-circuit-each sizes breakers: the project's load rules, and its NEC edition's standard ratings (none: the panel default). */
export interface DedicatedCircuitRules {
  readonly engine: ElectricalLoadEngine;
  readonly nec: NecEdition | null;
}

/** Not placed yet items with an electrical load and no circuit yet: what the Building Model's "Circuit all" puts on circuits. */
export function plannedLoadsWaitingForCircuit(model: Pick<ModelState, "elements">): string[] {
  const els = model.elements;
  return plannedPartGroups(els).flatMap((g) =>
    g.rows.flatMap((row) => {
      const part = els[row.id];
      return part?.kind === "part" && isCircuitableLoad(els, part) && !electricalConnections(els, row.id).some((c) => c.circuit) ? [row.id] : [];
    }),
  );
}

/**
 * bim_create_circuit with one_circuit_each: the Building Model's Not placed
 * yet › Circuit / Circuit all and Equipment list › Put them on circuits
 * (planDedicatedCircuits). Each item on its own circuit in the slots that best
 * balance the panel's phases, the breaker the next standard size for its load;
 * planned items need not be drawn. One batch, one undo step; items that can't
 * go on this panel are named with the reason and the rest still go.
 */
export function dedicatedCircuitsCommand(model: ModelState, modelId: string, args: { source_id: string; members: readonly { element_id: string }[] }, rules: DedicatedCircuitRules): { command: Command; plan: DedicatedCircuitsPlan } | string {
  const key = args.source_id.trim().toLowerCase();
  const panels = distributionEquipment(model.elements).filter((d) => d.kind === "panelboard" || d.kind === "switchboard");
  const panel = panels.find((d) => d.id === args.source_id || d.name.toLowerCase() === key);
  if (!panel) {
    return panels.length === 0
      ? "Not saved: there is no panel yet. Plan the main panel first (bim_place_service_layout with plan_only: true, distribution name MDP), then put these on its circuits."
      : `Not saved: no panel or switchboard "${args.source_id}". Panels here: ${panels.map((p) => p.name).join(", ")}.`;
  }
  const ids = args.members.length > 0 ? args.members.map((m) => m.element_id) : plannedLoadsWaitingForCircuit(model);
  if (ids.length === 0) return "Not saved: nothing in Not placed yet is waiting for a circuit (every item with an electrical load is on one). Name the members to circuit placed items.";
  const nec = rules.nec;
  const plan = planDedicatedCircuits(model, ids, panel.id, {
    linkIdFor: (partId) => circuitIdFor(modelId, panel.id, undefined, [{ element_id: partId }]),
    engine: rules.engine,
    ...(nec ? { breakerFor: (a: number) => nextStandardRating(nec, a) } : {}),
  });
  if (!plan.command) return `Not saved: none of them can go on ${panel.name}. ${plan.refused.map((r) => r.reason).join(" ")}`;
  return { command: plan.command, plan };
}

/** What one-circuit-each made, said the way the Circuit dialog lists it. */
export function dedicatedCircuitsBody(plan: DedicatedCircuitsPlan, rules: DedicatedCircuitRules) {
  return {
    circuits: plan.circuits.map((c) => ({ item: c.name, element_id: c.partId, circuit: c.circuitName, circuit_id: c.linkId, poles: c.poles, va: r1(c.va), breaker_a: c.breakerA ?? "panel default", ...(c.planned ? { placement: "not placed yet" } : {}) })),
    ...(plan.refused.length > 0 ? { not_circuited: plan.refused.map((r) => ({ item: r.name, element_id: r.partId, reason: r.reason })) } : {}),
    breakers: rules.nec ? `Next standard size for each load (NEC ${rules.nec.edition}).` : "Panel default (20 A unless the item gives a maximum): no NEC edition for this project, so breakers were not sized.",
  };
}

function circuitOut(l: LinkLoad) {
  return {
    circuit_id: l.linkId,
    name: l.name,
    role: l.role,
    ...(l.description ? { description: l.description } : {}),
    positions: l.positions,
    phases: l.phases.map((p) => PHASE_NAMES[p] ?? "A"),
    breaker_a: l.ratingA,
    ...(l.conductors ? { conductors: l.conductors } : {}),
    ...(l.lengthFt !== null ? { length_ft: l.lengthFt } : {}),
    ...(l.feederType ? { feeder_type: l.feederType } : {}),
    connected_va: r1(l.inventory.va),
    ...(l.typicalCount ? { typical_count: l.typicalCount } : {}),
    ...(l.feeds ? { feeds: l.feeds } : { members: l.members.map((m) => ({ element_id: m.elementId, name: m.name, va: r1(m.va), load_class: m.loadClass, continuous: m.continuous, load_from: m.from })) }),
    ...(l.refusals.length > 0 ? { problems: l.refusals.map((x) => x.message) } : {}),
  };
}

function nodeOut(r: ElectricalNodeReport, withCircuits: boolean) {
  return {
    id: r.nodeId,
    name: r.name,
    kind: r.kind,
    system: r.system,
    supply_from: r.supplyFrom ? { text: r.supplyFrom.text, source_id: r.supplyFrom.sourceId, feeder_id: r.supplyFrom.linkId, positions: r.supplyFrom.positions, breaker_a: r.supplyFrom.ratingA } : null,
    connected_va: r1(r.connectedVa),
    connected_a: r1(r.connectedA),
    demand_va: r1(r.demand.demandVa),
    demand_a: r1(r.demandA),
    sizing_va: r1(r.demand.sizingVa),
    sizing_a: r1(r.sizingA),
    minimum_device_a: r.demand.minimumDeviceA,
    per_phase: r.perPhase.map((p) => ({ phase: p.phase, va: r1(p.va), a: r1(p.amps) })),
    demand_by_class: r.demand.lines.map((l) => ({ class: l.key, units: l.units, connected_va: r1(l.connectedVa), demand_va: r1(l.demandVa), basis: l.basis, cite: l.cite })),
    capacity: { limit_a: r.capacity.limitA === null ? null : r1(r.capacity.limitA), limited_by: r.capacity.limitedBy?.kind ?? null, headroom_a: r.capacity.headroomA === null ? null : r1(r.capacity.headroomA), reason: r.capacity.reason, cite: r.capacity.limitedBy?.cite ?? [] },
    findings: r.findings.map((f) => ({ kind: f.kind, severity: f.severity, message: f.message, element_ids: f.elementIds })),
    ...(r.demand.notes.length > 0 ? { notes: r.demand.notes } : {}),
    ...(withCircuits ? { circuits: r.links.map(circuitOut) } : { circuit_count: r.links.length }),
  };
}

/** What a whole-building or one-panel report says, as the tool returns it. */
export function describeElectrical(model: ModelState, rules: ElectricalRules, code: string, panel: string | undefined, withCircuits: boolean | undefined) {
  const engine = new ElectricalLoadEngine(rules);
  const ids = engine.distribution(model);
  const wanted = panel ? ids.filter((id) => id === panel || engine.report(model, id)?.name.toLowerCase() === panel.toLowerCase()) : ids;
  if (panel && wanted.length === 0) return { error: `No panel, switchboard or transformer "${panel}" in this model. Distribution equipment here: ${ids.map((id) => engine.report(model, id)?.name ?? id).join(", ") || "none (place a panel with a voltage first)"}.` };
  const reports = wanted.flatMap((id) => {
    const r = engine.report(model, id);
    return r ? [r] : [];
  });
  return {
    revision: model.revision,
    code,
    rules_placeholder: rules.placeholder,
    nodes: reports.map((r) => ({ ...nodeOut(r, withCircuits ?? Boolean(panel)), ...faultCurrentOut(model, r.nodeId) })),
  };
}

/** A sender-chosen circuit id, the same for the same request, so a retried call is refused as already made instead of making a second circuit. */
export function circuitIdFor(modelId: string, sourceId: string, positions: readonly number[] | undefined, members: readonly { element_id: string; connector?: string }[]): string {
  const key = JSON.stringify([modelId, sourceId, positions ?? null, members.map((m) => [m.element_id, m.connector ?? null])]);
  return `ckt-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function conductorsOf(c: z.infer<typeof conductorArgs> | undefined) {
  return c ? { sets: c.sets, phaseSize: c.phase_size, ...(c.neutral_size ? { neutralSize: c.neutral_size } : {}), ...(c.ground_size ? { groundSize: c.ground_size } : {}), material: c.material } : undefined;
}

/** Arguments of each circuit edit, shared by the edit tools and bim_preview_circuit_edit (declared by the Electrical add-on). */
export { CIRCUIT_EDIT_ARGS };

export type CircuitEditTool = BimElectricalEditToolName;
const CIRCUIT_EDIT_TOOLS = BIM_ELECTRICAL_EDIT_TOOL_NAMES;
const argsOf = <T extends CircuitEditTool>(tool: T) => schemaOnce(CIRCUIT_EDIT_ARGS[tool]);

const membersOf = (members: readonly { element_id: string; connector?: string }[]) => members.map((m) => ({ elementId: m.element_id, ...(m.connector ? { connector: m.connector } : {}) }));

/**
 * The kernel command a circuit edit sends, or why it can't be built. The
 * Building Model's Electrical tab sends these same commands.
 */
export function circuitCommand(tool: CircuitEditTool, raw: unknown, modelId: string, model: ModelState | null, dedicated?: DedicatedCircuitRules): Command | string {
  const bad = (issues: readonly z.core.$ZodIssue[]) => `Those arguments don't fit ${tool}: ${issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
  switch (tool) {
    case "bim_create_circuit": {
      const parsed = argsOf("bim_create_circuit").safeParse(raw);
      if (!parsed.success) return bad(parsed.error.issues);
      const args = parsed.data;
      if (args.one_circuit_each) {
        const oneCircuitOnly = [args.positions, args.breaker_a, args.frame_a, args.circuit_id, args.load_class, args.conductors, args.length_ft, args.feeder_type, args.description].some((v) => v !== undefined);
        if (oneCircuitOnly) return "Not saved: one_circuit_each picks each item's slots and breaker and names the circuit after it; leave out positions, breaker_a, frame_a, circuit_id, load_class, conductors, length_ft, feeder_type and description (change one circuit afterwards with bim_edit_circuit).";
        if (!model || !dedicated) return "Not built: one_circuit_each reads the model first.";
        const built = dedicatedCircuitsCommand(model, modelId, args, dedicated);
        return typeof built === "string" ? built : built.command;
      }
      const electrical = {
        ...(args.breaker_a !== undefined ? { ratingA: args.breaker_a } : {}),
        ...(args.frame_a !== undefined ? { frameA: args.frame_a } : {}),
        ...(args.load_class ? { loadClass: args.load_class } : {}),
        ...(args.conductors ? { conductors: conductorsOf(args.conductors) } : {}),
        ...(args.length_ft !== undefined ? { lengthFt: args.length_ft } : {}),
        ...(args.feeder_type ? { feederType: args.feeder_type } : {}),
      };
      return {
        type: "create_service_link",
        linkId: args.circuit_id ?? circuitIdFor(modelId, args.source_id, args.positions, args.members),
        sourceId: args.source_id,
        ...(args.positions ? { positions: args.positions } : {}),
        members: membersOf(args.members),
        ...(args.description ? { description: args.description } : {}),
        ...(Object.keys(electrical).length > 0 ? { electrical } : {}),
      };
    }
    case "bim_edit_circuit": {
      const parsed = argsOf("bim_edit_circuit").safeParse(raw);
      if (!parsed.success) return bad(parsed.error.issues);
      const args = parsed.data;
      const electrical = {
        ...(args.breaker_a !== undefined ? { ratingA: args.breaker_a } : {}),
        ...(args.frame_a !== undefined ? { frameA: args.frame_a } : {}),
        ...(args.load_class !== undefined ? { loadClass: args.load_class } : {}),
        ...(args.conductors !== undefined ? { conductors: args.conductors === null ? null : conductorsOf(args.conductors) } : {}),
        ...(args.length_ft !== undefined ? { lengthFt: args.length_ft } : {}),
        ...(args.feeder_type !== undefined ? { feederType: args.feeder_type } : {}),
      };
      const changes = Object.keys(electrical).length > 0 || args.source_id || args.positions || args.description !== undefined;
      if (!changes) return "Not saved: say what to change (source_id, positions, description, breaker_a, conductors, …).";
      return {
        type: "edit_service_link",
        linkId: args.circuit_id,
        ...(args.source_id ? { sourceId: args.source_id } : {}),
        ...(args.positions ? { positions: args.positions } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(Object.keys(electrical).length > 0 ? { electrical } : {}),
      };
    }
    case "bim_add_to_circuit": {
      const parsed = argsOf("bim_add_to_circuit").safeParse(raw);
      if (!parsed.success) return bad(parsed.error.issues);
      const args = parsed.data;
      return { type: "add_link_members", linkId: args.circuit_id, members: membersOf(args.members) };
    }
    case "bim_remove_from_circuit": {
      const parsed = argsOf("bim_remove_from_circuit").safeParse(raw);
      if (!parsed.success) return bad(parsed.error.issues);
      const args = parsed.data;
      return { type: "remove_link_members", linkId: args.circuit_id, elementIds: args.element_ids };
    }
    case "bim_feed_panel": {
      const parsed = argsOf("bim_feed_panel").safeParse(raw);
      if (!parsed.success) return bad(parsed.error.issues);
      const args = parsed.data;
      if (!model) return "Not built: feeding a panel reads the model first.";
      const fed = panelSchedule(model.elements, args.panel_id);
      if (!fed) return `${args.panel_id} is not a panel, switchboard or transformer in this model. Ids are in bim_electrical_report.`;
      const electrical = { ...(args.breaker_a !== undefined ? { ratingA: args.breaker_a } : {}), ...(args.feeder_type ? { feederType: args.feeder_type } : {}) };
      const extras = { ...(args.positions ? { positions: args.positions } : {}), ...(Object.keys(electrical).length > 0 ? { electrical } : {}) };
      return fed.fedBy
        ? { type: "edit_service_link", linkId: fed.fedBy.linkId, sourceId: args.source_id, ...extras }
        : { type: "create_service_link", linkId: circuitIdFor(modelId, args.source_id, args.positions, [{ element_id: args.panel_id }]).replace(/^ckt-/, "fdr-"), sourceId: args.source_id, members: [{ elementId: args.panel_id }], ...extras };
    }
  }
}

const DESIGN_TOOLS: ReadonlySet<string> = new Set(BIM_ELECTRICAL_DESIGN_EDIT_TOOL_NAMES);
const isDesignTool = (tool: string): tool is BimElectricalDesignEditToolName => DESIGN_TOOLS.has(tool);

export function registerBimElectricalTools(server: McpServer, caller: ResolveBimCaller, options: { projectAdoption?: ProjectAdoptionLookup } = {}) {
  const projectAdoption = options.projectAdoption ?? noAdoptedElectricalCode;
  registerBimElectricalDesignTools(server, caller, options);
  registerBimElectricalProposeTools(server, caller, options);

  const report: HostedPackTool = (copy) =>
    server.registerTool("bim_electrical_report", { ...copy, inputSchema: { ...target, ...ELECTRICAL_TOOL_ARGS.bim_electrical_report } }, async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const { rules, code } = await rulesFor(extra, args.project_id, args, projectAdoption);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const out = describeElectrical(s.model(), rules, code, args.panel, args.include_circuits);
          return out.error !== undefined ? failure(out.error) : text(out);
        });
      } catch (err) {
        return explain(err, "bim_electrical_report");
      }
    });

  const circuitEdit =
    (tool: CircuitEditTool): HostedPackTool =>
    (copy) =>
      server.registerTool(tool, { ...copy, inputSchema: { ...target, ...baseRevision, ...CIRCUIT_EDIT_ARGS[tool] } }, async (raw: Record<string, unknown>, extra: Extra) => {
        const where = schemaOnce2(target, baseRevision).safeParse(raw);
        if (!where.success) return failure(`Those arguments don't fit ${tool}: ${where.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        const args = where.data;
        const oneEach = tool === "bim_create_circuit" && raw.one_circuit_each === true;
        let model: ModelState | null = null;
        let dedicated: DedicatedCircuitRules | undefined;
        if (tool === "bim_feed_panel" || oneEach) {
          try {
            const who = await caller(extra, args.project_id, false);
            if (oneEach) {
              const { rules, nec } = await rulesFor(extra, args.project_id, { occupancy: "other" }, projectAdoption);
              dedicated = { engine: new ElectricalLoadEngine(rules), nec };
            }
            model = await withSession(who, args.model_id, undefined, async (s) => s.model());
          } catch (err) {
            return explain(err, tool);
          }
        }
        const command = circuitCommand(tool, raw, args.model_id, model, dedicated);
        if (typeof command === "string") return failure(command);
        const at = { ...args, ...(model && args.base_revision === undefined ? { base_revision: model.revision } : {}) };
        if (oneEach && model && dedicated) {
          const built = dedicatedCircuitsCommand(model, args.model_id, argsOf("bim_create_circuit").parse(raw), dedicated);
          const body = typeof built === "string" ? null : dedicatedCircuitsBody(built.plan, dedicated);
          return runEdit(caller, tool, extra, at, command, undefined, body);
        }
        return runEdit(caller, tool, extra, at, command);
      });

  const preview: HostedPackTool = (copy) =>
    server.registerTool("bim_preview_circuit_edit", { ...copy, inputSchema: { ...target, ...ELECTRICAL_TOOL_ARGS.bim_preview_circuit_edit } }, async (input, extra) => {
      try {
        const who = await caller(extra, input.project_id, false);
        let dedicated: DedicatedCircuitRules | undefined;
        if (input.tool === "bim_create_circuit" && input.args.one_circuit_each === true) {
          const { rules, nec } = await rulesFor(extra, input.project_id, { occupancy: "other" }, projectAdoption);
          dedicated = { engine: new ElectricalLoadEngine(rules), nec };
        }
        return await withSession(who, input.model_id, undefined, async (s) => {
          const model = s.model();
          if (dedicated) {
            const parsed = argsOf("bim_create_circuit").safeParse(input.args);
            const built = parsed.success ? dedicatedCircuitsCommand(model, input.model_id, parsed.data, dedicated) : null;
            const command = circuitCommand("bim_create_circuit", input.args, input.model_id, model, dedicated);
            if (typeof command === "string" || !built || typeof built === "string") return text({ status: "would_refuse", revision: model.revision, message: typeof command === "string" ? command : String(built) });
            return text({ ...s.preview(command), ...dedicatedCircuitsBody(built.plan, dedicated) });
          }
          if (isDesignTool(input.tool)) {
            const built = designCommand(input.tool, input.args, model);
            if (typeof built === "string") return text({ status: "would_refuse", revision: model.revision, message: built });
            return text({ ...s.preview(built.command), ...(built.plan ? { plan: built.plan } : {}) });
          }
          const command = circuitCommand(input.tool, input.args, input.model_id, model);
          if (typeof command === "string") return text({ status: "would_refuse", revision: model.revision, message: command });
          const id = "linkId" in command ? command.linkId : null;
          const now = id ? model.elements[id] : undefined;
          return text({ ...s.preview(command), command, ...(now?.kind === "service_link" ? { circuit_now: describeCircuit(model.elements, now) } : {}) });
        });
      } catch (err) {
        return explain(err, "bim_preview_circuit_edit");
      }
    });

  // Needs the project's adopted NEC edition, the edit spine's one-circuit-each plan, or a session preview: hosted here.
  // bim_propose_links_from_text and bim_read_panel are the add-on's own reads, run by the host.
  registerPackTools(server, caller, "electrical", {
    only: ELECTRICAL_TOOL_GROUPS.circuits,
    shapes: ELECTRICAL_TOOL_ARGS,
    hosted: {
      bim_electrical_report: report,
      ...Object.fromEntries(CIRCUIT_EDIT_TOOLS.map((tool) => [tool, circuitEdit(tool)])),
      bim_preview_circuit_edit: preview,
    },
  });
}
