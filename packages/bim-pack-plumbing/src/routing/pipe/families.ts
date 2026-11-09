import {
  serviceOf,
  type DirectionRule,
  type FittingChoice,
  type FittingFamily,
  type FittingFamilyRow,
  type FittingFitContext,
  type FittingParamSpec,
  type FittingSlot,
  type FittingSlotDefault,
  type FittingType,
  type NumberParam,
  type PipeFamilyInfo,
  type PipeForm,
  type PipeMaterial,
  type PipeServiceOf,
  type RunSize,
} from "@permitzip/bim-kernel";

/**
 * Pipe fitting families as data: domestic water, drainage / waste / vent and
 * fuel gas, contributed to the kernel's `FITTING_FAMILY_POINT` (round 12 P12;
 * they were kernel data in `routing/pipe/families.ts` through round 11). Ids,
 * names, parameters and the order of rows are frozen: fittings store the id
 * and their parameters, and pickers list families in this order.
 *
 * Names are the generic trade names (1/4 bend, long sweep; combination wye &
 * 1/8 bend; drip leg), not any manufacturer's catalogue.
 *
 * Take-outs and laying lengths are generic proportions of the pipe's outside
 * diameter (or an engineer's own value in `takeout_mm`); they are what
 * routing cuts the straight pipe back by, so a leg too short for its real
 * fittings is refused like duct. Verify against the fittings submitted.
 *
 * Loss L/D values are the typical equivalent lengths in pipe diameters
 * published for each fitting shape; K = (L/D) x the pipe's turbulent
 * friction factor. They are labelled "verify for permit work".
 *
 * Drainage direction rules (which fitting may turn flow from horizontal to
 * vertical, vertical to horizontal, horizontal to horizontal) are general
 * practice, to be checked against the adopted plumbing code; a project
 * overrides any of them in its system design.
 */

const WATER_MATERIALS: readonly PipeMaterial[] = ["copper", "pex", "cpvc", "pp_r", "steel", "black_steel", "galvanized"];
const WATER_JOINTS: readonly string[] = ["sweat", "press", "threaded", "pex_crimp", "pex_expansion", "solvent_weld", "fusion"];
const DWV_MATERIALS: readonly PipeMaterial[] = ["pvc", "abs", "cast_iron", "galvanized"];
const DWV_JOINTS: readonly string[] = ["solvent_weld", "no_hub", "hub_gasket", "threaded"];
const GAS_STEEL: readonly PipeMaterial[] = ["black_steel", "steel"];
const ALL_MATERIALS: readonly PipeMaterial[] = ["copper", "pex", "cpvc", "pp_r", "pvc", "abs", "cast_iron", "steel", "black_steel", "galvanized", "csst", "pe"];
const ALL_JOINTS: readonly string[] = ["sweat", "press", "threaded", "no_hub", "hub_gasket", "solvent_weld", "pex_crimp", "pex_expansion", "fusion", "csst_mechanical"];

const ANY: DirectionRule = { hv: true, vh: true, hh: true };

function jointParam(joints: readonly string[]): FittingParamSpec {
  return { key: "joint", label: "Joint", kind: "choice", options: joints, default: joints[0] ?? "threaded" };
}

const takeoutParam: NumberParam = { key: "takeout_mm", label: "Take-out (0: generic proportion)", kind: "number", unit: "mm", default: 0, min: 0, max: 1500 };
const rOverDParam = (d: number): NumberParam => ({ key: "r_over_d", label: "Centreline radius / outside diameter", kind: "number", unit: "ratio", default: d, min: 0.5, max: 6 });

interface Spec {
  readonly id: string;
  readonly name: string;
  readonly trade: string;
  readonly types: readonly FittingType[];
  readonly info: PipeFamilyInfo;
  readonly angles?: FittingFamily["angles"];
  readonly loss: FittingFamily["loss"];
  readonly extra?: readonly FittingParamSpec[];
  readonly description: string;
}

function family(s: Spec): FittingFamily {
  const params: FittingParamSpec[] = [jointParam(s.info.joints)];
  if (s.info.form === "bend" && s.info.rOverD !== undefined) params.push(rOverDParam(s.info.rOverD));
  params.push(...(s.extra ?? []), takeoutParam);
  const isBranch = s.types.some((t) => t === "tee" || t === "wye");
  return {
    id: s.id,
    name: s.name,
    smacnaType: s.trade,
    domain: "pipe",
    fittingTypes: s.types,
    shapes: ["pipe"],
    ...(isBranch ? { mainShapes: ["pipe"] as const } : {}),
    ...(s.types.includes("transition") ? { shapeChange: "same" as const } : {}),
    ...(s.angles ? { angles: s.angles } : {}),
    params,
    geometry: "pipe_fitting",
    loss: s.loss,
    pipe: s.info,
    description: s.description,
  };
}

const water = (form: PipeForm, more: Partial<PipeFamilyInfo> = {}): PipeFamilyInfo => ({ services: ["water"], materials: WATER_MATERIALS, joints: WATER_JOINTS, form, ...more });
const dwv = (form: PipeForm, more: Partial<PipeFamilyInfo> = {}): PipeFamilyInfo => ({ services: ["drainage", "vent"], materials: DWV_MATERIALS, joints: DWV_JOINTS, form, ...more });
const gas = (form: PipeForm, more: Partial<PipeFamilyInfo> = {}): PipeFamilyInfo => ({ services: ["gas"], materials: GAS_STEEL, joints: ["threaded"], form, ...more });
const csst = (form: PipeForm, more: Partial<PipeFamilyInfo> = {}): PipeFamilyInfo => ({ services: ["gas"], materials: ["csst"], joints: ["csst_mechanical"], form, ...more });
const peGas = (form: PipeForm, more: Partial<PipeFamilyInfo> = {}): PipeFamilyInfo => ({ services: ["gas"], materials: ["pe"], joints: ["fusion"], form, ...more });

const nippleParam: NumberParam = { key: "nipple_mm", label: "Drip leg nipple length", kind: "number", unit: "mm", default: 76.2, min: 50, max: 600 };

/** A gas pressure regulator starts a pressure zone: everything downstream is at its outlet setting and sized on its own allowable drop. Pressures in in. w.c. (1 psi = 27.68 in. w.c.). */
export const REGULATOR_PARAMS: readonly FittingParamSpec[] = [
  { key: "role", label: "Regulator", kind: "choice", options: ["line", "service", "appliance"], default: "line" },
  { key: "outlet_in_wc", label: "Outlet pressure (in. w.c.; 2 psi = 55.4)", kind: "number", unit: "in_wc", default: 7, min: 1, max: 300 },
  { key: "zone_drop_in_wc", label: "Allowable drop downstream (in. w.c.; 1 psi = 27.7)", kind: "number", unit: "in_wc", default: 0.5, min: 0.05, max: 150 },
  { key: "vent", label: "Vent", kind: "choice", options: ["vent_limiter", "vent_to_outdoors", "none"], default: "vent_limiter" },
  { key: "capacity_mbh", label: "Rated capacity (MBH; 0: not given)", kind: "number", unit: "mbh", default: 0, min: 0, max: 100_000 },
];

export const PIPE_FITTING_FAMILIES: readonly FittingFamily[] = [
  // ------------------------------------------------------------ domestic water
  family({ id: "pipe.water.elbow_90", name: "90° elbow, short radius", trade: "90° elbow (short radius)", types: ["elbow"], angles: "90", loss: "pipe_k", info: water("bend", { rOverD: 1, lOverD: { body: 30 } }), description: "Standard 90° elbow." }),
  family({ id: "pipe.water.elbow_90_lr", name: "90° elbow, long radius", trade: "90° elbow (long radius)", types: ["elbow"], angles: "90", loss: "pipe_k", info: water("bend", { rOverD: 1.5, lOverD: { body: 20 } }), description: "Long-radius 90°: lower loss, more take-out." }),
  family({ id: "pipe.water.elbow_45", name: "45° elbow", trade: "45° elbow", types: ["elbow"], angles: "45", loss: "pipe_k", info: water("bend", { rOverD: 1, lOverD: { body: 16 } }), description: "Standard 45° elbow." }),
  family({ id: "pipe.water.elbow_22", name: "22½° elbow", trade: "22½° elbow (wrought copper)", types: ["elbow"], angles: "22.5", loss: "pipe_k", info: water("bend", { materials: ["copper"], joints: ["sweat", "press"], rOverD: 1, sizesIn: { min: 0.5, max: 4 }, lOverD: { body: 10 } }), description: "Wrought copper 22½° elbow, sweat or press, made 1/2\" to 4\". Other water pipe turns 45° and 90°." }),
  family({ id: "pipe.water.tee", name: "Tee", trade: "Tee (straight or reducing)", types: ["tee", "wye"], loss: "pipe_k", info: water("tee", { branch: { angleDeg: 90, sweep: false }, lOverD: { branch: 60, main: 20 } }), description: "Straight tee; reducing when the branch is smaller than the run." }),
  family({ id: "pipe.water.reducer", name: "Reducer", trade: "Reducing coupling", types: ["transition"], loss: "transition", info: water("reducer"), description: "Concentric reducing coupling between two sizes." }),
  family({ id: "pipe.water.cap", name: "Cap", trade: "Cap", types: ["cap"], loss: "cap", info: water("cap"), description: "Closes an open end." }),
  family({ id: "pipe.water.coupling", name: "Coupling", trade: "Coupling", types: ["accessory"], loss: "pipe_k", info: water("inline", { accessory: "coupling", layingOverOd: 0.2, lOverD: { body: 0 } }), description: "Joins two lengths of the same size." }),
  family({ id: "pipe.water.union", name: "Union", trade: "Union", types: ["accessory"], loss: "pipe_k", info: water("inline", { accessory: "union", layingOverOd: 1.4, lOverD: { body: 2 } }), description: "Lets equipment be disconnected." }),
  family({ id: "pipe.valve.ball", name: "Ball valve, full port", trade: "Ball valve (full port)", types: ["accessory"], loss: "pipe_k", info: { ...water("inline", { accessory: "valve", layingOverOd: 2.6, lOverD: { body: 3 } }), services: ["water", "gas"] }, description: "Quarter-turn shut-off." }),
  family({ id: "pipe.valve.gate", name: "Gate valve", trade: "Gate valve", types: ["accessory"], loss: "pipe_k", info: water("inline", { accessory: "valve", layingOverOd: 2.6, lOverD: { body: 8 } }), description: "Full-open isolation valve." }),
  family({ id: "pipe.valve.check", name: "Swing check valve", trade: "Check valve (swing)", types: ["accessory"], loss: "pipe_k", info: water("inline", { accessory: "valve", layingOverOd: 3.4, lOverD: { body: 100 } }), description: "Stops reverse flow." }),
  family({
    id: "pipe.valve.prv",
    name: "Pressure-reducing valve (placeholder)",
    trade: "Pressure-reducing valve",
    types: ["accessory"],
    loss: "pipe_k",
    info: water("inline", { accessory: "prv", layingOverOd: 4, lOverD: { body: 0 } }),
    description: "Placeholder: its outlet set pressure isn't modelled. Enter its loss as an engineer's override from the valve's data.",
  }),
  // ------------------------------------------------------------ drainage, waste and vent
  family({
    id: "dwv.quarter_bend",
    name: "1/4 bend",
    trade: "Quarter bend (90°, short radius)",
    types: ["elbow"],
    angles: "90",
    loss: "not_calculated",
    info: dwv("bend", { rOverD: 1, direction: { hv: true, vh: { maxIn: 2 }, hh: { maxIn: 2 } } }),
    description: "Tight 90° bend. Turns horizontal flow down; vertical-to-horizontal and horizontal-to-horizontal only on small fixture drains.",
  }),
  family({
    id: "dwv.quarter_bend_short_sweep",
    name: "1/4 bend, short sweep",
    trade: "Short sweep (90°)",
    types: ["elbow"],
    angles: "90",
    loss: "not_calculated",
    info: dwv("bend", { rOverD: 1.5, direction: { hv: true, vh: { minIn: 3 }, hh: { maxIn: 2 } } }),
    description: "90° sweep. Any size horizontal to vertical; vertical to horizontal from 3\" up.",
  }),
  family({
    id: "dwv.quarter_bend_long_sweep",
    name: "1/4 bend, long sweep",
    trade: "Long sweep (90°)",
    types: ["elbow"],
    angles: "90",
    loss: "not_calculated",
    info: dwv("bend", { rOverD: 3, direction: ANY }),
    description: "Long-radius 90° sweep: the turn for the base of a stack and for horizontal-to-horizontal changes.",
  }),
  family({
    id: "dwv.closet_bend",
    name: "Closet bend",
    trade: "Closet bend",
    types: ["elbow"],
    angles: "90",
    loss: "not_calculated",
    info: dwv("bend", { rOverD: 1, sizesIn: { min: 3, max: 4 }, direction: { hv: true, vh: true, hh: false } }),
    description: "90° bend under a water closet flange, 3\" or 4\".",
  }),
  family({ id: "dwv.eighth_bend", name: "1/8 bend", trade: "Eighth bend (45°)", types: ["elbow"], angles: "45", loss: "not_calculated", info: dwv("bend", { rOverD: 1.5, direction: ANY }), description: "45° bend; any change of direction." }),
  family({ id: "dwv.sixth_bend", name: "1/6 bend", trade: "Sixth bend (60°)", types: ["elbow"], angles: "60", loss: "not_calculated", info: dwv("bend", { rOverD: 1.5, direction: ANY }), description: "60° bend; any change of direction." }),
  family({ id: "dwv.sixteenth_bend", name: "1/16 bend", trade: "Sixteenth bend (22½°)", types: ["elbow"], angles: "22.5", loss: "not_calculated", info: dwv("bend", { rOverD: 1.5, direction: ANY }), description: "22½° bend; any change of direction." }),
  family({
    id: "dwv.sanitary_tee",
    name: "Sanitary tee",
    trade: "Sanitary tee",
    types: ["tee", "wye"],
    loss: "not_calculated",
    info: dwv("tee", { branch: { angleDeg: 90, sweep: true }, direction: { hv: true, vh: false, hh: false } }),
    description: "Branch sweeps down into the run. Only where horizontal flow enters a vertical stack.",
  }),
  family({
    id: "dwv.wye",
    name: "Wye (45°)",
    trade: "Wye",
    types: ["tee", "wye"],
    loss: "not_calculated",
    info: dwv("tee", { branch: { angleDeg: 45, sweep: false }, direction: ANY }),
    description: "Branch enters at 45° in the direction of flow.",
  }),
  family({
    id: "dwv.combo_wye_eighth",
    name: "Combination wye & 1/8 bend",
    trade: "Combination wye and eighth bend",
    types: ["tee", "wye"],
    loss: "not_calculated",
    info: dwv("tee", { branch: { angleDeg: 90, sweep: true }, direction: ANY }),
    description: "A wye with a 1/8 bend on the branch: the branch leaves square, the flow joins at 45°. Any change of direction.",
  }),
  family({
    id: "dwv.vent_tee",
    name: "Vent tee",
    trade: "Vent tee",
    types: ["tee", "wye"],
    loss: "not_calculated",
    info: dwv("tee", { branch: { angleDeg: 90, sweep: false }, ventOnly: true }),
    description: "Square tee for dry vent piping; no sweep, so not for drainage.",
  }),
  family({ id: "dwv.reducer", name: "Reducer / increaser", trade: "Reducer (increaser)", types: ["transition"], loss: "not_calculated", info: dwv("reducer"), description: "Changes size; drains only get larger downstream." }),
  family({ id: "dwv.cap", name: "Test cap / plug", trade: "Test cap", types: ["cap"], loss: "not_calculated", info: dwv("cap"), description: "Closes an open end." }),
  family({ id: "dwv.cleanout_tee", name: "Cleanout (tee + plug)", trade: "Cleanout tee with plug", types: ["accessory"], loss: "not_calculated", info: dwv("inline", { accessory: "cleanout", layingOverOd: 2 }), description: "Tee-pattern cleanout with a threaded plug." }),
  family({ id: "dwv.cleanout_wye", name: "Cleanout (wye + plug)", trade: "Cleanout wye with plug", types: ["accessory"], loss: "not_calculated", info: dwv("inline", { accessory: "cleanout", layingOverOd: 2.6, placement: "horizontal" }), description: "Wye-pattern cleanout for horizontal drains." }),
  family({ id: "dwv.test_tee", name: "Test tee", trade: "Test tee", types: ["accessory"], loss: "not_calculated", info: dwv("inline", { accessory: "test_tee", layingOverOd: 2, placement: "vertical" }), description: "Cleanout tee in a stack, used to plug the stack for a water test." }),
  family({ id: "dwv.p_trap", name: "P-trap", trade: "P-trap", types: ["accessory"], loss: "not_calculated", info: { ...dwv("trap", { accessory: "trap", layingOverOd: 3, placement: "horizontal" }), services: ["drainage"] }, description: "Trap on a fixture's trap arm; keeps a water seal." }),
  family({ id: "dwv.coupling", name: "Coupling", trade: "Coupling (no-hub band or solvent coupling)", types: ["accessory"], loss: "not_calculated", info: dwv("inline", { accessory: "coupling", layingOverOd: 0.7 }), description: "Joins two lengths." }),
  // ------------------------------------------------------------ fuel gas
  family({ id: "pipe.gas.elbow_90", name: "90° elbow, threaded", trade: "90° elbow (threaded malleable iron)", types: ["elbow"], angles: "90", loss: "pipe_k", info: gas("bend", { rOverD: 0.8, lOverD: { body: 30 } }), description: "Threaded 90°." }),
  family({ id: "pipe.gas.elbow_45", name: "45° elbow, threaded", trade: "45° elbow (threaded malleable iron)", types: ["elbow"], angles: "45", loss: "pipe_k", info: gas("bend", { rOverD: 0.8, lOverD: { body: 16 } }), description: "Threaded 45°." }),
  family({ id: "pipe.gas.tee", name: "Tee, threaded", trade: "Tee (threaded malleable iron)", types: ["tee", "wye"], loss: "pipe_k", info: gas("tee", { branch: { angleDeg: 90, sweep: false }, lOverD: { branch: 60, main: 20 } }), description: "Threaded tee, straight or reducing." }),
  family({ id: "pipe.gas.reducer", name: "Reducing coupling / bushing", trade: "Reducing coupling", types: ["transition"], loss: "transition", info: { ...gas("reducer"), materials: [...GAS_STEEL, "csst"], joints: ["threaded", "csst_mechanical"] }, description: "Changes size." }),
  family({ id: "pipe.gas.cap", name: "Cap, threaded", trade: "Cap", types: ["cap"], loss: "cap", info: { ...gas("cap"), materials: [...GAS_STEEL, "csst"], joints: ["threaded", "csst_mechanical"] }, description: "Closes an open end." }),
  family({ id: "pipe.gas.union", name: "Union, ground joint", trade: "Union", types: ["accessory"], loss: "pipe_k", info: gas("inline", { accessory: "union", layingOverOd: 1.6, lOverD: { body: 2 } }), description: "Lets an appliance be disconnected." }),
  family({ id: "pipe.gas.cock", name: "Gas cock / shut-off", trade: "Gas cock (plug valve)", types: ["accessory"], loss: "pipe_k", info: { ...gas("inline", { accessory: "gas_cock", layingOverOd: 2.4, lOverD: { body: 18 } }), materials: [...GAS_STEEL, "csst"], joints: ["threaded", "csst_mechanical"] }, description: "Appliance or zone shut-off." }),
  family({
    id: "pipe.gas.drip_leg",
    name: "Drip leg (tee + nipple + cap)",
    trade: "Drip leg / sediment trap",
    types: ["accessory"],
    loss: "pipe_k",
    extra: [nippleParam],
    info: gas("drip_leg", { accessory: "drip_leg", layingOverOd: 2, lOverD: { body: 20 }, placement: "vertical" }),
    description: "Tee on the drop to an appliance, with a capped nipple below it to catch sediment.",
  }),
  family({
    id: "pipe.gas.regulator",
    name: "Gas pressure regulator",
    trade: "Pressure regulator (service, line or appliance)",
    types: ["accessory"],
    loss: "not_calculated",
    extra: REGULATOR_PARAMS,
    info: { ...gas("inline", { accessory: "regulator", layingOverOd: 4 }), materials: [...GAS_STEEL, "csst"], joints: ["threaded", "csst_mechanical"] },
    description: "Steps the pressure down (2 psi to 11 in. w.c. at a cook line, or at one appliance); the pipe downstream is a new pressure zone sized at the outlet setting. Indoors it needs a vent limiter or a vent to outdoors.",
  }),
  family({ id: "pipe.gas.csst_bend_90", name: "CSST bend, 90°", trade: "CSST field bend", types: ["elbow"], angles: "90", loss: "pipe_k", info: csst("bend", { rOverD: 3, lOverD: { body: 20 } }), description: "CSST bends in the field; no fitting. Keep at least the manufacturer's minimum bend radius." }),
  family({ id: "pipe.gas.csst_bend_45", name: "CSST bend, 45°", trade: "CSST field bend", types: ["elbow"], angles: "45", loss: "pipe_k", info: csst("bend", { rOverD: 3, lOverD: { body: 12 } }), description: "CSST field bend, 45°." }),
  family({ id: "pipe.gas.csst_tee", name: "CSST tee", trade: "CSST tee fitting", types: ["tee", "wye"], loss: "pipe_k", info: csst("tee", { branch: { angleDeg: 90, sweep: false }, lOverD: { branch: 60, main: 20 } }), description: "CSST mechanical tee." }),
  family({ id: "pipe.gas.csst_fitting", name: "CSST fitting", trade: "CSST termination / coupling", types: ["accessory"], loss: "pipe_k", info: csst("inline", { accessory: "coupling", layingOverOd: 1.6, lOverD: { body: 4 } }), description: "CSST mechanical fitting (coupling or termination)." }),
  family({ id: "pipe.gas.pe_elbow_90", name: "PE elbow, 90°, fusion", trade: "PE fusion elbow", types: ["elbow"], angles: "90", loss: "pipe_k", info: peGas("bend", { rOverD: 1, lOverD: { body: 30 } }), description: "Polyethylene gas elbow, butt or socket fusion." }),
  family({ id: "pipe.gas.pe_elbow_45", name: "PE elbow, 45°, fusion", trade: "PE fusion elbow", types: ["elbow"], angles: "45", loss: "pipe_k", info: peGas("bend", { rOverD: 1, lOverD: { body: 16 } }), description: "Polyethylene gas 45°, fusion." }),
  family({ id: "pipe.gas.pe_tee", name: "PE tee, fusion", trade: "PE fusion tee", types: ["tee", "wye"], loss: "pipe_k", info: peGas("tee", { branch: { angleDeg: 90, sweep: false }, lOverD: { branch: 60, main: 20 } }), description: "Polyethylene gas tee, straight or reducing." }),
  family({ id: "pipe.gas.pe_reducer", name: "PE reducer, fusion", trade: "PE fusion reducer", types: ["transition"], loss: "transition", info: peGas("reducer"), description: "Changes PE size." }),
  family({ id: "pipe.gas.pe_cap", name: "PE cap, fusion", trade: "PE end cap", types: ["cap"], loss: "cap", info: peGas("cap"), description: "Closes an open PE end." }),
  // ------------------------------------------------------------ generic (pipe routed before the library had families)
  ...(["elbow", "transition", "tee", "wye", "cap"] as const).map(
    (t): FittingFamily =>
      family({
        id: `pipe.${t}`,
        name: t === "transition" ? "Reducer" : t === "wye" ? "Combination wye" : t === "tee" ? "Tee" : t === "cap" ? "Cap" : "Elbow",
        trade: "Generic pipe fitting",
        types: [t],
        ...(t === "elbow" ? { angles: "45_90" as const } : {}),
        loss: t === "transition" ? "transition" : t === "cap" ? "cap" : "pipe_k",
        info: {
          services: ["water", "drainage", "vent", "gas"],
          materials: ALL_MATERIALS,
          joints: ALL_JOINTS,
          form: t === "elbow" ? "bend" : t === "transition" ? "reducer" : t === "cap" ? "cap" : "tee",
          ...(t === "elbow" ? { rOverD: 1, lOverD: { body: 30 } } : {}),
          ...(t === "tee" || t === "wye" ? { branch: { angleDeg: 90, sweep: t === "wye" }, lOverD: { branch: 60, main: 20 } } : {}),
        },
        description: "Generic pipe fitting from before the pipe library; swap it for a typed fitting.",
      }),
  ),
];

// ------------------------------------------------------------------ slot defaults

/** Candidates per service and slot, in preference order; the first made in the pipe's material wins (round 11's table, frozen). */
export const PIPE_DEFAULT_CANDIDATES: Readonly<Record<PipeServiceOf, Partial<Record<FittingSlot, readonly string[]>>>> = {
  water: { pipe_elbow_90: ["pipe.water.elbow_90"], pipe_elbow_45: ["pipe.water.elbow_45"], pipe_tee: ["pipe.water.tee"], pipe_reducer: ["pipe.water.reducer"], pipe_cap: ["pipe.water.cap"] },
  gas: {
    pipe_elbow_90: ["pipe.gas.elbow_90", "pipe.gas.csst_bend_90", "pipe.gas.pe_elbow_90"],
    pipe_elbow_45: ["pipe.gas.elbow_45", "pipe.gas.csst_bend_45", "pipe.gas.pe_elbow_45"],
    pipe_tee: ["pipe.gas.tee", "pipe.gas.csst_tee", "pipe.gas.pe_tee"],
    pipe_reducer: ["pipe.gas.reducer", "pipe.gas.pe_reducer"],
    pipe_cap: ["pipe.gas.cap", "pipe.gas.pe_cap"],
  },
  drainage: {
    drain_turn_hv: ["dwv.quarter_bend_short_sweep"],
    drain_turn_vh: ["dwv.quarter_bend_long_sweep"],
    drain_turn_hh: ["dwv.quarter_bend_long_sweep"],
    drain_turn_45: ["dwv.eighth_bend"],
    drain_branch_hv: ["dwv.sanitary_tee"],
    drain_branch_hh: ["dwv.combo_wye_eighth"],
    pipe_reducer: ["dwv.reducer"],
    pipe_cap: ["dwv.cap"],
  },
  vent: {
    drain_turn_hv: ["dwv.quarter_bend"],
    drain_turn_vh: ["dwv.quarter_bend"],
    drain_turn_hh: ["dwv.quarter_bend"],
    drain_turn_45: ["dwv.eighth_bend"],
    drain_branch_hv: ["dwv.vent_tee"],
    drain_branch_hh: ["dwv.vent_tee"],
    pipe_elbow_90: ["dwv.quarter_bend"],
    pipe_elbow_45: ["dwv.eighth_bend"],
    pipe_tee: ["dwv.vent_tee"],
    pipe_reducer: ["dwv.reducer"],
    pipe_cap: ["dwv.cap"],
  },
};

/** The generic family per slot, used when no service default is made in the pipe's material (scope `pipe`, the run domain). */
export const PIPE_GENERIC_DEFAULTS: Readonly<Partial<Record<FittingSlot, string>>> = {
  pipe_elbow_90: "pipe.elbow",
  pipe_elbow_45: "pipe.elbow",
  drain_turn_hv: "pipe.elbow",
  drain_turn_vh: "pipe.elbow",
  drain_turn_hh: "pipe.elbow",
  drain_turn_45: "pipe.elbow",
  pipe_tee: "pipe.tee",
  drain_branch_hv: "pipe.wye",
  drain_branch_hh: "pipe.wye",
  pipe_reducer: "pipe.transition",
  pipe_cap: "pipe.cap",
};

const FAMILY_BY_ID: ReadonlyMap<string, FittingFamily> = new Map(PIPE_FITTING_FAMILIES.map((f) => [f.id, f]));

/**
 * The candidate table as slot-default rows, keyed by the family they name:
 * the first candidate under the service's scope, and, for a material the
 * first candidate isn't made in, the first candidate that is under
 * `<service>/<material>`. The kernel's reader (`pipeDefaultChoice`) gives the
 * same choice the round 11 table did for every service, slot and material.
 */
function slotDefaults(): ReadonlyMap<string, FittingSlotDefault[]> {
  const out = new Map<string, FittingSlotDefault[]>();
  const add = (familyId: string, scope: string, slot: FittingSlot): void => {
    const choice: FittingChoice = { family: familyId };
    const list = out.get(familyId) ?? [];
    list.push({ scope, slot, choice });
    out.set(familyId, list);
  };
  for (const [service, slots] of Object.entries(PIPE_DEFAULT_CANDIDATES) as Array<[PipeServiceOf, Partial<Record<FittingSlot, readonly string[]>>]>) {
    for (const [slot, candidates] of Object.entries(slots) as Array<[FittingSlot, readonly string[]]>) {
      const first = candidates[0];
      if (first === undefined) continue;
      add(first, service, slot);
      const covered = new Set<PipeMaterial>(FAMILY_BY_ID.get(first)?.pipe?.materials ?? []);
      for (const id of candidates.slice(1)) {
        for (const m of FAMILY_BY_ID.get(id)?.pipe?.materials ?? []) {
          if (covered.has(m)) continue;
          covered.add(m);
          add(id, `${service}/${m}`, slot);
        }
      }
    }
  }
  for (const [slot, id] of Object.entries(PIPE_GENERIC_DEFAULTS) as Array<[FittingSlot, string]>) add(id, "pipe", slot);
  return out;
}

// ------------------------------------------------------------------ fit rules and labels

function inchesOf(size: Extract<RunSize, { shape: "pipe" }>): number {
  return Math.round((size.nominalMm / 25.4) * 1000) / 1000;
}

const SERVICE_WORD: Readonly<Record<PipeServiceOf, string>> = { water: "water", drainage: "drainage", vent: "vent", gas: "fuel gas" };

/** Why a pipe family can't be this fitting (material, size, service, a 45° wye on a square branch), or null. Round 11's kernel rule, word for word. */
export function pipeFamilyFit(family: FittingFamily, f: FittingFitContext): string | null {
  const info = family.pipe;
  if (!info) return null;
  if (f.systemKind) {
    const service = serviceOf(f.systemKind);
    if (service && !info.services.includes(service)) return `${family.name} is a ${info.services.map((s) => SERVICE_WORD[s]).join(" / ")} fitting; this system carries ${SERVICE_WORD[service]}`;
    if (info.ventOnly && service === "drainage") return `A ${family.name.toLowerCase()} has no sweep, so it can't take drainage; use a sanitary tee or a combination wye & 1/8 bend`;
  }
  for (const s of f.sizes) {
    if (s.shape !== "pipe") continue;
    if (!info.materials.includes(s.material)) return `${family.name} isn't made for ${s.material.replace(/_/g, " ")} pipe`;
    const inches = inchesOf(s);
    if (info.sizesIn?.min !== undefined && inches < info.sizesIn.min - 1e-6) return `${family.name} is made ${info.sizesIn.min}" and larger; this is ${inches}"`;
    if (info.sizesIn?.max !== undefined && inches > info.sizesIn.max + 1e-6) return `${family.name} is made up to ${info.sizesIn.max}"; this is ${inches}"`;
  }
  if ((f.fittingType === "tee" || f.fittingType === "wye") && info.branch && Math.abs(info.branch.angleDeg - 90) > 1) {
    return `A ${family.name.toLowerCase()} takes its branch at ${info.branch.angleDeg}°; this branch leaves square to the run, so use a combination wye & 1/8 bend`;
  }
  return null;
}

/** "Reducing tee" when the branch is smaller than the run, for the plain and threaded tees. */
export function pipeTeeLabel(family: FittingFamily, sizes: readonly RunSize[], main: RunSize | undefined): string {
  const branch = sizes[0];
  const reducing = family.pipe?.form === "tee" && branch?.shape === "pipe" && main?.shape === "pipe" && branch.nominalMm < main.nominalMm - 0.5;
  if (reducing && family.name === "Tee") return "Reducing tee";
  if (reducing && family.name === "Tee, threaded") return "Reducing tee, threaded";
  return family.name;
}

const DEFAULTS_BY_FAMILY = slotDefaults();

/** Every pipe family as a `FITTING_FAMILY_POINT` row, in round 11's order. */
export const PIPE_FITTING_FAMILY_ROWS: readonly FittingFamilyRow[] = PIPE_FITTING_FAMILIES.map((f): FittingFamilyRow => {
  const defaults = DEFAULTS_BY_FAMILY.get(f.id);
  return { family: f, ...(defaults ? { defaults } : {}), mismatch: pipeFamilyFit, ...(f.name === "Tee" || f.name === "Tee, threaded" ? { label: pipeTeeLabel } : {}) };
});
