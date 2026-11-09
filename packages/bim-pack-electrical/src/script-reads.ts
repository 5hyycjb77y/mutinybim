import { z } from "zod";
import { NEC_EDITIONS, PERMITZIP_DESIGN_CRITERIA, resolveNecEdition, type NecEdition } from "@permitzip/bim-calc";
import { QUANTITIES, QUANTITY_KEYS, bagSummary, connectionTypeSummary, connectionTypes, type ModelState } from "@permitzip/bim-kernel";
import { circuitTemplateOf, circuitTemplates } from "./catalog/circuit-templates";
import { feederTypeText, feederTypes } from "./catalog/feeder-types";
import { necElectricalRules } from "./calc/aggregation-rules";
import { proposeFeederType } from "./calc/feeder-type";
import { electricalCheck } from "./connections/check";
import { ElectricalLoadEngine, vaPerAmp } from "./connections/engine";
import { distributionEquipment } from "./connections/panel";
import { planRebalance } from "./connections/rebalance";
import { CONNECTED_LOAD_ONLY } from "./connections/rules";
import { distributionOf } from "./connections/systems";
import { planCircuitTemplate } from "./connections/templates";
import { ELECTRICAL_TOOL_ARGS, type ElectricalPackRead } from "./agent-tools";

/**
 * The Electrical add-on's whole-panel answers as pack reads, so a script
 * reaches them with `ctx.read(id, input)` on its working copy, the same
 * numbers the Electrical tab and the electrical tools show: a panel's loads
 * and phase totals, the design check, the catalogue, a phase rebalance plan,
 * a room template's circuits, a feeder size. Reads never edit: a plan's
 * `command` is the edit, sent with `ctx.edit` when the script decides to.
 */

type Elements = ModelState["elements"];

/** A panel, switchboard or transformer by id or name (any case); null when there is none. */
export function findPanelId(elements: Elements, key: string): string | null {
  const k = key.trim().toLowerCase();
  return distributionEquipment(elements).find((d) => d.id === key || d.name.toLowerCase() === k)?.id ?? null;
}

/** A room by id or number (any case); null when there is none. */
export function findRoomId(elements: Elements, key: string): string | null {
  const direct = elements[key];
  if (direct?.kind === "room") return direct.id;
  const k = key.trim().toLowerCase();
  for (const el of Object.values(elements)) if (el.kind === "room" && el.number.trim().toLowerCase() === k) return el.id;
  return null;
}

const noPanel = (elements: Elements, key: string) => ({ refused: `No panel "${key}". Distribution equipment here: ${distributionEquipment(elements).map((d) => d.name).join(", ") || "none yet"}.` });

const edition = z.enum(NEC_EDITIONS).optional().describe("NEC edition for demand factors; absent: connected load only.");

function rulesFor(nec: (typeof NEC_EDITIONS)[number] | undefined) {
  if (!nec) return { rules: CONNECTED_LOAD_ONLY, edition: null };
  const resolved = resolveNecEdition({ necEdition: nec });
  if (!resolved.ok) return { refused: resolved.reason };
  return { rules: necElectricalRules(resolved.edition), edition: resolved.edition };
}

const LOADS_INPUT = z.object({ panel: z.string().min(1).max(200), nec_edition: edition });
const CHECK_INPUT = z.object({ nec_edition: edition });
const CATALOG_INPUT = z.object({ kind: z.enum(["all", "connection_types", "feeder_types", "templates"]).optional() });
const REBALANCE_INPUT = z.object({ panel: z.string().min(1).max(200), keep_circuits: z.array(z.string().min(1)).max(200).optional(), max_moves: z.number().int().min(1).max(84).optional() });
const TEMPLATE_INPUT = z.object({
  template: z.string().min(1).max(200),
  units: z.array(z.object({ panel: z.string().min(1).max(200), rooms: z.array(z.string().min(1)).min(1).max(100), label: z.string().max(120).optional() })).min(1).max(200),
});
const FEEDER_INPUT = z.object({
  panel: z.string().min(1).max(200),
  nec_edition: z.enum(NEC_EDITIONS),
  length_ft: ELECTRICAL_TOOL_ARGS.bim_electrical_catalog.length_ft,
  material: ELECTRICAL_TOOL_ARGS.bim_electrical_catalog.material,
  conduit: ELECTRICAL_TOOL_ARGS.bim_electrical_catalog.conduit,
});

const issuesIn = (error: z.ZodError) => ({ refused: `Those inputs don't fit: ${error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}` });

/** The connection types, feeder types and room templates the model holds. */
export function electricalCatalog(model: ModelState, kind: "all" | "connection_types" | "feeder_types" | "templates" = "all") {
  return {
    ...(kind === "all" || kind === "connection_types" ? { connection_types: connectionTypes(model).map((r) => ({ ...r.entry, summary: connectionTypeSummary(r.entry), ...(r.entry.quantities ? { loads: bagSummary(r.entry.quantities) } : {}) })), quantity_units: Object.fromEntries(QUANTITY_KEYS.map((k) => [k, QUANTITIES[k].unit])) } : {}),
    ...(kind === "all" || kind === "feeder_types" ? { feeder_types: feederTypes(model).map((r) => ({ ...r.entry, schedule: feederTypeText(r.entry) })) } : {}),
    ...(kind === "all" || kind === "templates" ? { room_templates: circuitTemplates(model).map((r) => r.entry) } : {}),
  };
}

export interface FeederProposalOptions {
  readonly lengthFt?: number;
  readonly material?: z.infer<typeof FEEDER_INPUT>["material"];
  readonly conduit?: z.infer<typeof FEEDER_INPUT>["conduit"];
}

/** The feeder type a panel's demand load needs (its record ready to save), or why not. */
export function feederProposal(model: ModelState, nec: NecEdition, panelId: string, options: FeederProposalOptions = {}) {
  const part = model.elements[panelId];
  const info = part?.kind === "part" ? distributionOf(model.elements, part) : null;
  if (!info) return { refused: `${panelId} is not a panel, switchboard or transformer.` };
  const report = new ElectricalLoadEngine(necElectricalRules(nec)).report(model, panelId);
  if (!report) return { refused: `${info.name} has no load report.` };
  const per = vaPerAmp(info.supply);
  const continuousA = report.demand.continuousVa / per;
  const noncontinuousA = Math.max(0, report.demand.demandVa - report.demand.continuousVa) / per;
  const sized = proposeFeederType(nec, PERMITZIP_DESIGN_CRITERIA, { system: info.supply, continuousA, noncontinuousA, ...(options.lengthFt ? { lengthFt: options.lengthFt } : {}), ...(options.material ? { material: options.material } : {}), ...(options.conduit ? { conduit: options.conduit } : {}) });
  return sized.entry
    ? { for: info.name, entry: sized.entry, schedule: feederTypeText(sized.entry), steps: sized.run.steps.map((st) => `${st.label}: ${st.detail}`), issues: sized.run.issues.map((i) => i.message) }
    : { for: info.name, refused: sized.refusal };
}

function loadsRead(model: ModelState, input: unknown) {
  const parsed = LOADS_INPUT.safeParse(input);
  if (!parsed.success) return issuesIn(parsed.error);
  const panelId = findPanelId(model.elements, parsed.data.panel);
  if (!panelId) return noPanel(model.elements, parsed.data.panel);
  const r = rulesFor(parsed.data.nec_edition);
  if ("refused" in r) return r;
  const report = new ElectricalLoadEngine(r.rules).report(model, panelId);
  return report ?? { refused: `${parsed.data.panel} has no load report.` };
}

function checkRead(model: ModelState, input: unknown) {
  const parsed = CHECK_INPUT.safeParse(input ?? {});
  if (!parsed.success) return issuesIn(parsed.error);
  const r = rulesFor(parsed.data.nec_edition);
  if ("refused" in r) return r;
  return { items: electricalCheck(new ElectricalLoadEngine(r.rules), model).map((i) => ({ severity: i.severity, says: i.message, elementIds: i.elementIds })) };
}

function catalogRead(model: ModelState, input: unknown) {
  const parsed = CATALOG_INPUT.safeParse(input ?? {});
  return parsed.success ? electricalCatalog(model, parsed.data.kind) : issuesIn(parsed.error);
}

function rebalanceRead(model: ModelState, input: unknown) {
  const parsed = REBALANCE_INPUT.safeParse(input);
  if (!parsed.success) return issuesIn(parsed.error);
  const panelId = findPanelId(model.elements, parsed.data.panel);
  if (!panelId) return noPanel(model.elements, parsed.data.panel);
  const plan = planRebalance(model.elements, panelId, { ...(parsed.data.keep_circuits ? { keep: parsed.data.keep_circuits } : {}), ...(parsed.data.max_moves ? { maxMoves: parsed.data.max_moves } : {}) });
  return plan ?? { refused: `${parsed.data.panel} has no slots to rebalance.` };
}

function templateRead(model: ModelState, input: unknown) {
  const parsed = TEMPLATE_INPUT.safeParse(input);
  if (!parsed.success) return issuesIn(parsed.error);
  const template = circuitTemplateOf(model.elements, parsed.data.template);
  if (!template) return { refused: `No room template "${parsed.data.template}". Templates here: ${circuitTemplates(model).map((t) => t.entry.name).join(", ") || "none yet"}.` };
  const units = [];
  for (const u of parsed.data.units) {
    const panelId = findPanelId(model.elements, u.panel);
    if (!panelId) return noPanel(model.elements, u.panel);
    const roomIds: string[] = [];
    for (const r of u.rooms) {
      const id = findRoomId(model.elements, r);
      if (!id) return { refused: `No room "${r}".` };
      roomIds.push(id);
    }
    units.push({ panelId, roomIds, ...(u.label ? { label: u.label } : {}) });
  }
  return planCircuitTemplate(model, template, units);
}

function feederRead(model: ModelState, input: unknown) {
  const parsed = FEEDER_INPUT.safeParse(input);
  if (!parsed.success) return issuesIn(parsed.error);
  const panelId = findPanelId(model.elements, parsed.data.panel);
  if (!panelId) return noPanel(model.elements, parsed.data.panel);
  const resolved = resolveNecEdition({ necEdition: parsed.data.nec_edition });
  if (!resolved.ok) return { refused: resolved.reason };
  const { length_ft, material, conduit } = parsed.data;
  return feederProposal(model, resolved.edition, panelId, { ...(length_ft ? { lengthFt: length_ft } : {}), ...(material ? { material } : {}), ...(conduit ? { conduit } : {}) });
}

export const ELECTRICAL_SCRIPT_READS: readonly ElectricalPackRead[] = [
  { id: "electrical.loads", label: "A panel's connected and demand loads, per phase", run: loadsRead },
  { id: "electrical.check", label: "The electrical design check", run: checkRead },
  { id: "electrical.catalog", label: "Connection types, feeder types and room templates", run: catalogRead },
  { id: "electrical.rebalance_plan", label: "Phase moves that balance a panel", run: rebalanceRead },
  { id: "electrical.circuit_template_plan", label: "A room template's circuits for the units given", run: templateRead },
  { id: "electrical.feeder_proposal", label: "The feeder a panel's demand load needs", run: feederRead },
];
