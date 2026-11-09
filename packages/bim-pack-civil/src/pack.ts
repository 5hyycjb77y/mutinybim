import { qty, to } from "@permitzip/bim-units";
import { CALC_POINT, CLASS_POINT, LINT_RULE_POINT, NETWORK_ADAPTER_POINT, PARAMETER_SET_POINT, SERVICE_POINT, contribute, defineCalc, definePack, type BimElement, type Pack, type RuleContext, type RuleDef } from "@permitzip/bim-pack/runtime";
import { PIPE_MATERIAL_POINT } from "@permitzip/bim-kernel";
import { MANNING_CAPACITY_EXAMPLE, manningCapacityInput, RATIONAL_RUNOFF_EXAMPLE, rationalRunoffInput, runManningCapacity, runRationalRunoff } from "./calcs";
import { inletOverloadFindings, INLET_OVERLOADED_RULE, slopeFindings, SLOPE_BELOW_MINIMUM_RULE, type CivilFinding } from "./checks";
import { CIVIL_CLASSES, CIVIL_PIPE_MATERIALS, CIVIL_STORM_SERVICE_ROW } from "./classes";
import { CIVIL_CLASS, CIVIL_PACK_ID, CIVIL_PARAM } from "./ids";
import { CIVIL_STORM_NETWORK, solveStormNetwork, type StormNetworkResult } from "./network";
import { CIVIL_PARAMETER_SETS } from "./parameters";

/**
 * The civil pack on the add-on contract: classes, the storm service, its
 * network to total, parameter sets, reinforced concrete pipe, two lint rules
 * and two calcs. Every id is `civil.<name>`. Nothing here touches the kernel
 * beyond its published points.
 *
 * Not contributed, with the reason in the notes: space-use rates for C (a
 * rate is per space use; C is a surface property and Q needs the storm's
 * intensity), derived-zone rules (a catchment is drawn, not derived).
 */

type Elements = Readonly<Record<string, BimElement>>;

interface Linted {
  readonly net: StormNetworkResult;
  /** Findings by the element they are about (`elementIds[0]`). */
  readonly findings: ReadonlyMap<string, readonly CivilFinding[]>;
}

/** One solve per model state the runner lints (its elements record is replaced on every edit). */
const solved = new WeakMap<Elements, Linted>();

function lintedOf(elements: Elements): Linted {
  const hit = solved.get(elements);
  if (hit) return hit;
  const net = solveStormNetwork(elements);
  const findings = new Map<string, CivilFinding[]>();
  for (const f of [...inletOverloadFindings(net), ...slopeFindings(net)]) {
    const id = f.elementIds[0];
    if (id === undefined) continue;
    const list = findings.get(id);
    if (list) list.push(f);
    else findings.set(id, [f]);
  }
  const linted = { net, findings };
  solved.set(elements, linted);
  return linted;
}

const ft = (mm: number): number => to(qty("length", mm, "mm"), "ft");

function emit(ctx: RuleContext, el: BimElement, f: CivilFinding, at: { readonly x: number; readonly y: number; readonly z: number }): void {
  ctx.emit({ rule: f.rule, severity: f.severity, elementIds: f.elementIds, at: { level: ctx.levelNameOf(el), x_ft: ft(at.x), y_ft: ft(at.y), z_ft: ft(at.z) }, message: f.message });
}

export const INLET_OVERLOADED: RuleDef = {
  id: INLET_OVERLOADED_RULE,
  version: 1,
  pack: CIVIL_PACK_ID,
  severity: "warning",
  title: "Storm inlet gets more runoff than it can take",
  scope: "element",
  kinds: ["part"],
  run(ctx, el) {
    if (el.kind !== "part" || el.classId !== CIVIL_CLASS.stormInlet) return;
    const { findings } = lintedOf(ctx.model.elements);
    const rim = el.values[CIVIL_PARAM.rimElevation];
    const at = { x: el.position.x, y: el.position.y, z: typeof rim === "number" ? rim : 0 };
    for (const f of findings.get(el.id) ?? []) if (f.rule === INLET_OVERLOADED_RULE) emit(ctx, el, f, at);
  },
};

export const SLOPE_BELOW_MINIMUM: RuleDef = {
  id: SLOPE_BELOW_MINIMUM_RULE,
  version: 1,
  pack: CIVIL_PACK_ID,
  severity: "warning",
  title: "Storm pipe flatter than its minimum slope",
  scope: "element",
  kinds: ["run_segment"],
  run(ctx, el) {
    if (el.kind !== "run_segment") return;
    const { findings } = lintedOf(ctx.model.elements);
    const at = { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2, z: (el.start.z + el.end.z) / 2 };
    for (const f of findings.get(el.id) ?? []) if (f.rule === SLOPE_BELOW_MINIMUM_RULE) emit(ctx, el, f, at);
  },
};

export const RATIONAL_RUNOFF_CALC = defineCalc({
  id: "civil.rational_runoff",
  version: "1.0.0",
  domain: "civil",
  title: "Rational-method peak runoff",
  summary: "Peak runoff Q = C·i·A in cfs from an area (acres or ft²), a runoff coefficient or surface type, and a design intensity in in/h. No time of concentration: the intensity is the one given.",
  codeFamily: null,
  needsModel: false,
  input: rationalRunoffInput,
  example: RATIONAL_RUNOFF_EXAMPLE,
  run: (input) => runRationalRunoff(input),
});

export const MANNING_CAPACITY_CALC = defineCalc({
  id: "civil.manning_full_capacity",
  version: "1.0.0",
  domain: "civil",
  title: "Storm pipe capacity flowing full (Manning)",
  summary: "Capacity and velocity of a round pipe flowing full from its diameter (in), slope (%) and Manning's n or material; optionally compares a flow in cfs.",
  codeFamily: null,
  needsModel: false,
  input: manningCapacityInput,
  example: MANNING_CAPACITY_EXAMPLE,
  run: (input) => runManningCapacity(input),
});

export const CIVIL_PACK: Pack = definePack(
  {
    id: CIVIL_PACK_ID,
    name: "Civil",
    version: "0.1.0",
    kernel: "^1.1.0",
    description: "Storm catchments, inlets, manholes, outfalls and alignments; rational-method runoff carried down a gravity network; inlet and slope checks.",
  },
  [
    contribute(CLASS_POINT, CIVIL_CLASSES),
    contribute(SERVICE_POINT, [CIVIL_STORM_SERVICE_ROW]),
    contribute(NETWORK_ADAPTER_POINT, [CIVIL_STORM_NETWORK]),
    contribute(PARAMETER_SET_POINT, CIVIL_PARAMETER_SETS),
    contribute(PIPE_MATERIAL_POINT, CIVIL_PIPE_MATERIALS),
    contribute(LINT_RULE_POINT, [INLET_OVERLOADED, SLOPE_BELOW_MINIMUM]),
    contribute(CALC_POINT, [RATIONAL_RUNOFF_CALC, MANNING_CAPACITY_CALC]),
  ],
);
