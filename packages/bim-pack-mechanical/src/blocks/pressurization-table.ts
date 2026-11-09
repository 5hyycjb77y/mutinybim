import { to } from "@permitzip/bim-units";
import { AIR_ROLE_WORDS, makeupLoadOnUnit, pressurizationOf, pressurizationScopeZones, signedCfm, type PressurizationContributor, type PressurizationReport, type PressurizationScope, type PressurizationSet, type ZonePressurization } from "../balance/pressurization";
import { SENSIBLE_HEAT_SOURCE } from "../balance/makeup-air";
import type { BimElement, ElementId, ModelState, PressurizationTableSpec, RenderedBlock } from "@permitzip/bim-kernel";

/**
 * The live pressurization table (HVAC Demo 2, 16:43, drafted as text on 7303
 * today): one signed line per item that moves air in or out (KEF-1 −3,000,
 * MUA-1 +2,400, RTU-1 +320 …), each zone's net against its target, the
 * building's net, and the makeup-air tempering load. Returns a `RenderedBlock`
 * so k4's hash, freeze-at-issue and "changed since" work unchanged.
 */

type Elements = Readonly<Record<string, BimElement>>;

export const PRESSURIZATION_TABLE_TITLE = "BUILDING PRESSURIZATION";
export const PRESSURIZATION_TABLE_MAX_ROWS = 60;

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function contributorLine(c: PressurizationContributor, zoneNames: ReadonlyMap<ElementId, string>): string {
  const zones = c.zoneIds.length === 0 ? "no zone" : c.zoneIds.map((id) => zoneNames.get(id) ?? id).join(", ");
  const cfm = c.value === null ? "—" : signedCfm(c.side === "out" ? -to(c.value, "cfm") : to(c.value, "cfm"));
  return `${c.label} | ${AIR_ROLE_WORDS[c.role]} | ${zones} | ${cfm}${c.planned ? " (planned)" : ""}`;
}

function subtotalText(s: PressurizationSet): string {
  if (!s.subtotals) return "";
  return `exhaust ${WHOLE.format(to(s.subtotals.exhaust, "cfm"))}, makeup ${WHOLE.format(to(s.subtotals.makeupAir, "cfm"))}, outdoor air ${WHOLE.format(to(s.subtotals.outdoorAir, "cfm"))}; `;
}

export function pressurizationZoneText(z: ZonePressurization): string {
  const required = z.requiredExhaust === null ? "" : `; exhaust required ${WHOLE.format(to(z.requiredExhaust, "cfm"))} cfm${z.exhaustShort ? " (SHORT)" : ""}`;
  return `${z.name}: ${subtotalText(z)}${z.text}${required}`;
}

export function pressurizationBuildingText(b: PressurizationSet): string {
  return `Building: ${subtotalText(b)}${b.text}`;
}

/** The table as printed lines (deterministic for the same elements). */
export function pressurizationTableLines(elements: Elements, report: PressurizationReport, scope: PressurizationScope): string[] {
  if (report.empty) return [report.empty];
  const { zones, showBuilding } = pressurizationScopeZones(elements, report, scope);
  const zoneIds = new Set(zones.map((z) => z.zoneId));
  const zoneNames = new Map(report.zones.map((z) => [z.zoneId, z.name] as const));
  const rows = showBuilding ? report.contributors : report.contributors.filter((c) => c.zoneIds.some((id) => zoneIds.has(id)));
  if (rows.length === 0 && zones.length === 0) return [scope.kind === "zone" ? "This zone has nothing that moves air in or out yet." : "No zones on this level move air in or out yet."];
  const lines = ["Item | Air | Zone | cfm (+ in, − out)"];
  const shown = rows.slice(0, PRESSURIZATION_TABLE_MAX_ROWS);
  for (const c of shown) lines.push(contributorLine(c, zoneNames));
  if (rows.length > shown.length) lines.push(`… and ${rows.length - shown.length} more. Use a schedule of equipment for the whole list.`);
  for (const z of zones) lines.push(pressurizationZoneText(z));
  if (showBuilding) lines.push(pressurizationBuildingText(report.building));
  for (const h of report.heat) {
    if (!showBuilding && !rows.some((c) => c.partId === h.partId)) continue;
    const unit = h.servingUnits.length === 1 ? `, added to ${h.servingUnits[0]?.mark}` : h.servingUnits.length > 1 ? `, shared by ${h.servingUnits.map((u) => u.mark).join(" and ")}` : "";
    if (h.heat) lines.push(`${h.mark} ${h.tempering === "partial" ? "partially tempered" : "untempered"} makeup air: ${h.heat.arithmetic} ${h.heat.direction}${unit}`);
    else if (h.tempering !== null && h.missing) lines.push(`${h.mark}: ${h.missing}`);
  }
  if (report.heat.some((h) => h.heat)) lines.push(`Makeup air load: ${SENSIBLE_HEAT_SOURCE}.`);
  return lines;
}

function dependencies(elements: Elements, report: PressurizationReport, scope: PressurizationScope): ElementId[] {
  const out = new Set<ElementId>();
  if (scope.kind === "level") out.add(scope.levelId);
  if (scope.kind === "zone") out.add(scope.zoneId);
  const { zones, showBuilding } = pressurizationScopeZones(elements, report, scope);
  const zoneIds = new Set(zones.map((z) => z.zoneId));
  for (const z of zones) {
    out.add(z.zoneId);
    if (z.servedBy) out.add(z.servedBy.id);
  }
  for (const c of report.contributors) {
    if (!showBuilding && !c.zoneIds.some((id) => zoneIds.has(id))) continue;
    out.add(c.partId);
    const part = elements[c.partId];
    if (part?.kind === "part") out.add(part.typeId);
  }
  return [...out].sort();
}

/** The table as a block value: text, what couldn't be read, and every element it read. */
export function renderPressurizationTable(model: Pick<ModelState, "elements">, spec: PressurizationTableSpec): RenderedBlock {
  const report = pressurizationOf(model.elements);
  const unresolved = report.contributors.filter((c) => c.value === null).map((c) => c.label);
  return { text: pressurizationTableLines(model.elements, report, spec.scope).join("\n"), unresolved, dependsOn: dependencies(model.elements, report, spec.scope) };
}

/** "RTU-2 carries 31,104 Btu/h of makeup air heating (MUA-1)": the line a unit's properties print, or null. */
export function makeupLoadText(model: Pick<ModelState, "elements">, unitId: ElementId): string | null {
  const load = makeupLoadOnUnit(pressurizationOf(model.elements), unitId);
  if (!load) return null;
  return `${WHOLE.format(Math.round(to(load.load, "Btu/h")))} Btu/h of makeup air load (${load.lines.map((l) => `${l.mark}: ${l.heat?.arithmetic ?? ""}`).join("; ")})`;
}
