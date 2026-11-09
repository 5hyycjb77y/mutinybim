import { refuse, registerEditHook } from "../command-core";
import { decidingUndo, peerReads } from "../elements/feature";
import { isUnitCodeOnly, PARTS_UNIT_CODES_FEATURE, type ParamDef } from "../parts";
import { lineHostTopMm, PARTS_LINE_HOST_FEATURE } from "../spatial";
import type { BimElement, ElementId, ModelState } from "../types";

/**
 * Part writes gated on what peers read (units here; line hosts below).
 *
 * Part parameter units, expand then contract: every reader of this release
 * reads a unit code (`cfs`) as well as a v1 unit name (`gpm`); a part type
 * newly carrying a unit code is written only when the peers advertise
 * `parts:unit_codes`. A unit a type already carried passes, so a newer peer's
 * type round-trips; undo restores stored records and stands aside.
 */
function unitCodes(params: readonly ParamDef[]): Set<string> {
  const out = new Set<string>();
  for (const p of params) if (isUnitCodeOnly(p.unit)) out.add(`${p.name}:${p.unit ?? ""}`);
  return out;
}

function checkUnits(base: Readonly<Record<string, BimElement>>, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "part_type") continue;
    const now = unitCodes([...next.definition.typeParams, ...next.definition.instanceParams]);
    if (now.size === 0) continue;
    const prior = base[id];
    const before = prior?.kind === "part_type" ? unitCodes([...prior.definition.typeParams, ...prior.definition.instanceParams]) : new Set<string>();
    const added = [...now].find((u) => !before.has(u));
    if (added === undefined || peerReads(PARTS_UNIT_CODES_FEATURE)) continue;
    const [name, unit] = added.split(":");
    refuse("invalid_value", `${next.definition.familyName} ${next.definition.typeName}'s ${name} in ${unit} can't be saved yet: the model server this model is open on is an older version that reads only the original part unit names. Try again once the server is updated`, [next.id]);
  }
}

/**
 * A part standing on a line-placed element (a unit on a beam): the element
 * must exist and have a line, and the host is written only when the peers
 * advertise `parts:line_host`. A host a part already had passes.
 */
function checkLineHosts(base: ModelState, working: Readonly<Record<string, BimElement>>, touchedIds: readonly ElementId[]): void {
  if (decidingUndo()) return;
  for (const id of touchedIds) {
    const next = working[id];
    if (next?.kind !== "part" || next.host?.kind !== "element") continue;
    const prior = base.elements[id];
    const was = prior?.kind === "part" ? prior.host : undefined;
    if (was?.kind === "element" && was.elementId === next.host.elementId && was.stationMm === next.host.stationMm) continue;
    const name = next.mark || "The part";
    if (lineHostTopMm({ ...base, elements: working }, next.host.elementId, next.host.stationMm) === null) refuse("element_not_found", `${name} can't stand on ${next.host.elementId}: it isn't a beam, wall, grid or component with a line in this model`, [id]);
    if (!peerReads(PARTS_LINE_HOST_FEATURE)) refuse("invalid_value", `${name} can't be saved standing on a beam yet: the model server this model is open on is an older version that stores only slab and roof hosts. Try again once the server is updated`, [id]);
  }
}

registerEditHook("part-unit-codes", (base, working, touchedIds) => {
  checkUnits(base.elements, working, touchedIds);
  checkLineHosts(base, working, touchedIds);
});
