/**
 * One run of the electrical aggregation workload, in one process: the tier's
 * full-building model plus a building-sized distribution on it (an MDP, a
 * board per floor, per zone a 480 V panel and a transformer to a 208 V panel,
 * 427 loads per zone), with the NEC 2023 rules.
 *
 * - electrical.aggregate.cold: a fresh engine reports every panel, board and
 *   transformer (connected, NEC demand, per phase, capacity chain, findings).
 * - electrical.report.after_edit: after one load changes (committed through
 *   executeCommand, outside the timing), the same engine reports the MDP and
 *   the edited panel. Recomputes only the edited panel's path to the top.
 * - electrical.report_all.after_edit: every node's report after one edit, the
 *   engine told what changed (`advance`), as the model server and clients are.
 * - electrical.circuit.edit: a receptacle put back on its branch circuit
 *   (add_link_members), predicted on the full head as Add to circuit does.
 * - electrical.panel_view.after_edit: what the panel view redraws after that
 *   edit (the panel's slots and circuits, its totals, the panel list).
 * - electrical.panel_list: the panel list alone (a scan of every element).
 *
 * - diagram.one_line.evaluate.150: a live one-line over a 155-node distribution
 *   (7 floors x 7 zones), derived from the connection graph from scratch: graph,
 *   field text, layout, drawing items (DIAGRAMS.md).
 * - diagram.one_line.after_edit.150: the same diagram after one panel's bus
 *   rating changes, the whole diagram derived again (never patched).
 * - diagram.plumbing_riser.* / diagram.plumbing_isometric.*: a 200-fixture
 *   sanitary riser and isometric (plumbing-risers.ts).
 *
 * WS-C circuiting, on a distribution of 10 floors x 10 zones (311 panels,
 * boards and transformers, 42,700 loads) laid on the same full-building
 * model, whatever the tier:
 *
 * - electrical.circuit.add_balanced: one receptacle put on a 208 V panel with
 *   no slots given (the kernel picks the free slots that best balance its
 *   phases), through executeCommand.
 * - electrical.rebalance.plan: the deterministic rebalance plan of one panel.
 * - electrical.check.all: the Electrical tab's check list over the whole model
 *   with a warm engine (every node's findings, loads on no circuit, missing
 *   connection types).
 *
 * - electrical.schedules.cold.300 / .after_edit.300: 300 panel schedules (a
 *   dedicated 10-floor x 15-zone distribution on the tier's model) evaluated
 *   and laid out as they print, from a fresh engine and again after one
 *   receptacle load edit.
 *
 * Invariants: nodes recomputed after one edit (its path: panel, transformer,
 * board, MDP), fresh-vs-incremental mismatches (must be 0), panel
 * schedules that could not show their panel (must be 0), diagram
 * evaluations that differ for the same model (must be 0), and rebalance
 * plans that differ between two runs on the same model (must be 0).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/electrical.ts --tier=250k --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts.
 */
import { necEdition, receptaclePlacementRules } from "@permitzip/bim-calc";
import { necElectricalRules, distributionEquipment, distributionOf, electricalCheck, ElectricalLoadEngine, panelSchedule, planRebalance, syntheticDistribution, proposeReceptacles, receptacleRoomGeometries } from "@permitzip/bim-pack-electrical";
import { builtinFormTemplate, builtinPartType, buildViewScene, type Command, type ElementId, elementValues, evaluateDiagram, executeCommand, type FormScheduleDefinition, formTable, freezeElements, type ModelState, planCommit, type ViewElement, unit001Architecture } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { emit, gc, memoryMB, timeSync, type Sample } from "./lib";
import { plumbingRiserSamples } from "./plumbing-risers";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const COLD_SAMPLES = 3;

const rules = necElectricalRules("2023");

function reportAll(engine: ElectricalLoadEngine, model: ModelState): string {
  const parts: string[] = [];
  for (const id of engine.distribution(model)) {
    const r = engine.report(model, id);
    if (!r) throw new Error(`[perf/electrical] no report for ${id}`);
    parts.push(`${id}:${r.connectedVa.toFixed(3)}:${r.demand.demandVa.toFixed(3)}:${r.demand.sizingVa.toFixed(3)}:${r.perPhase.map((p) => p.va.toFixed(3)).join("/")}:${r.capacity.limitA?.toFixed(3) ?? "-"}:${r.findings.length}`);
  }
  return parts.join("\n");
}

let commitSeq = 0;
function commit(model: ModelState, command: Command, engine: ElectricalLoadEngine): ModelState {
  commitSeq += 1;
  const d = planCommit(model, [], { idempotencyKey: `perf-electrical-${commitSeq}`, baseRevision: model.revision, actor: { id: "perf", name: "Perf", kind: "human" }, command });
  if (!d.ok) throw new Error(`[perf/electrical] ${command.type} refused: ${d.error.message}`);
  engine.advance(d.model, [...d.changeset.elements.map((el) => el.id), ...(d.changeset.removedIds ?? [])]);
  return d.model;
}

/** A live one-line over a ~150-node distribution (7 floors x 7 zones: MDP, 7 boards, 49 x (480 V panel, transformer, 208 V panel)). */
function diagramSamples(samples: number): { evaluate: number[]; afterEdit: number[]; nodes: number; elements: number; nondeterministic: number } {
  const syn = syntheticDistribution({ floors: 7, zonesPerFloor: 7, prefix: "dg" });
  const view = { id: "v-one-line", props: { diagram: { kind: "one_line" as const } } } as Pick<ViewElement, "id" | "props">;
  let model: ModelState = { modelId: "diagram-perf", revision: 0 as ModelState["revision"], elements: freezeElements({ ...syn.elements }), connections: [], settings: createFullBimModel({ ...opts, floors: 1, zonesPerFloor: 1 }).settings };
  const evaluate: number[] = [];
  const afterEdit: number[] = [];
  let nodes = 0;
  let nondeterministic = 0;
  let firstBytes = "";
  for (let i = 0; i < samples; i++) {
    // A fresh element map each sample: no evaluation cache to hit.
    const fresh = { ...model.elements };
    const t = timeSync(() => evaluateDiagram(fresh, view));
    evaluate.push(t.ms);
    nodes = t.value?.equipment.length ?? 0;
    const bytes = JSON.stringify(t.value?.items ?? []);
    if (!firstBytes) firstBytes = bytes;
    else if (bytes !== firstBytes) nondeterministic += 1;
  }
  const panels = Object.keys(model.elements).filter((id) => /^dg-h\d+-\d+$/.test(id)).sort();
  for (let i = 0; i < samples; i++) {
    const target = panels[i % Math.max(1, panels.length)];
    if (!target) break;
    const edited = executeCommand(model, { type: "set_parameters", id: target, scope: "type", values: { bus_rating: 225 + 25 * ((i % 4) + 1) } });
    if (!edited.ok) throw new Error(`[perf/electrical] diagram edit refused: ${edited.error.message}`);
    model = edited.model;
    const head = model;
    afterEdit.push(timeSync(() => evaluateDiagram(head.elements, view)).ms);
  }
  return { evaluate, afterEdit, nodes, elements: Object.keys(model.elements).length, nondeterministic };
}

function main(): void {
  const base = createFullBimModel(opts);
  const syn = syntheticDistribution({ floors: opts.floors, zonesPerFloor: opts.zonesPerFloor });
  // The model server keeps elements in the kernel's store (what every commit produces); a plain spread would not be.
  let model: ModelState = { ...base, elements: freezeElements({ ...base.elements, ...syn.elements }) };
  const totalElements = Object.keys(model.elements).length;
  const networkElements = syn.counts.loads + syn.counts.distribution;
  gc();

  const cold: number[] = [];
  let first = "";
  for (let i = 0; i < COLD_SAMPLES; i++) {
    const fresh = new ElectricalLoadEngine(rules);
    const t = timeSync(() => reportAll(fresh, model));
    cold.push(t.ms);
    if (!first) first = t.value;
    else if (t.value !== first) throw new Error("[perf/electrical] cold reports differ between fresh engines");
  }

  const engine = new ElectricalLoadEngine(rules);
  reportAll(engine, model);
  const afterEdit: number[] = [];
  const allAfterEdit: number[] = [];
  let worstRecomputed = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const f = (i % opts.floors) + 1;
    const z = (Math.floor(i / opts.floors) % opts.zonesPerFloor) + 1;
    const device = `e-l${f}-${z}-r${(i % 30) + 1}-1`;
    const panel = `e-l${f}-${z}` as ElementId;
    const edited = executeCommand(model, { type: "set_parameters", id: device, scope: "instance", values: { load_va: 180 + 10 * (i + 1) } });
    if (!edited.ok) throw new Error(`[perf/electrical] edit refused: ${edited.error.message}`);
    model = edited.model;
    engine.advance(model, edited.changedIds);
    const before = engine.stats.computed;
    const head = model;
    afterEdit.push(
      timeSync(() => {
        const top = engine.report(head, syn.mdpId);
        const own = engine.report(head, panel);
        if (!top || !own) throw new Error("[perf/electrical] report lost after an edit");
        return top.demand.sizingVa + own.connectedVa;
      }).ms,
    );
    worstRecomputed = Math.max(worstRecomputed, engine.stats.computed - before);
    allAfterEdit.push(timeSync(() => reportAll(engine, head)).ms);
  }
  const mismatches = reportAll(engine, model) === reportAll(new ElectricalLoadEngine(rules), model) ? 0 : 1;
  const schedules = panelSchedules(base);
  const diagram = diagramSamples(samplesPerRun);
  const piping = plumbingRiserSamples(samplesPerRun);

  // Circuiting and the panel view (E3): take a receptacle off its circuit and put it back, as Add to circuit /
  // Edit circuit commit, then redraw what the panel view shows for that panel (its slots and circuits, the
  // panel list, the engine's totals for the panel).
  const circuitEdit: number[] = [];
  const panelView: number[] = [];
  const panelList: number[] = [];
  const scanPredicted: number[] = [];
  const scanConfirmed: number[] = [];
  let panelRows = 0;
  // The first link edit after load builds the kernel's link indexes (~80 ms at 250k); it is reported on its own
  // so the warm metric measures the steady edit.
  const firstCircuitEdit: number[] = [];
  {
    const panel = `e-l${opts.floors}-${opts.zonesPerFloor}`;
    const circuit = `${panel}-c1`;
    const device = `${panel}-r1-1`;
    model = commit(model, { type: "remove_link_members", linkId: circuit, elementIds: [device] }, engine);
    const before = model;
    const addBack: Command = { type: "add_link_members", linkId: circuit, members: [{ elementId: device, connector: "power" }] };
    const first = timeSync(() => executeCommand(before, addBack));
    if (!first.value.ok) throw new Error(`[perf/electrical] add to circuit refused: ${first.value.error.message}`);
    firstCircuitEdit.push(first.ms);
    model = commit(model, addBack, engine);
  }
  for (let i = 0; i < samplesPerRun; i++) {
    const f = (i % opts.floors) + 1;
    const z = (Math.floor(i / opts.floors) % opts.zonesPerFloor) + 1;
    const panel = `e-l${f}-${z}` as ElementId;
    const circuit = `${panel}-c1`;
    const device = `${panel}-r1-1`;
    // Confirmed states come from planCommit, the server's commit path (a sealed store sharing the head's indexes).
    model = commit(model, { type: "remove_link_members", linkId: circuit, elementIds: [device] }, engine);
    const before = model;
    const addBack: Command = { type: "add_link_members", linkId: circuit, members: [{ elementId: device, connector: "power" }] };
    const added = timeSync(() => executeCommand(before, addBack));
    if (!added.value.ok) throw new Error(`[perf/electrical] add to circuit refused: ${added.value.error.message}`);
    circuitEdit.push(added.ms);
    const predicted = added.value.model;
    if (i === 0) {
      for (let k = 0; k < 5; k++) {
        scanPredicted.push(timeSync(() => elementValues(predicted.elements).length).ms);
        scanConfirmed.push(timeSync(() => elementValues(before.elements).length).ms);
      }
    }
    model = commit(model, addBack, engine);
    const head = model;
    panelView.push(
      timeSync(() => {
        const schedule = panelSchedule(head.elements, panel);
        const report = engine.report(head, panel);
        const all = distributionEquipment(head.elements);
        if (!schedule || !report) throw new Error("[perf/electrical] panel view lost after a circuit edit");
        panelRows = schedule.slots.length + all.length;
        return report.connectedVa;
      }).ms,
    );
    panelList.push(timeSync(() => distributionEquipment(head.elements).length).ms);
  }

  // ---------------------------------------------------------------- WS-C circuiting at 300 panels
  const WSC = { floors: 10, zonesPerFloor: 10 };
  const wsc = syntheticDistribution({ ...WSC, prefix: "w" });
  let big: ModelState = { ...base, elements: freezeElements({ ...base.elements, ...wsc.elements }) };
  const receptacleType = (big.elements[wsc.receptacleId] as { typeId: ElementId }).typeId;
  const levelId = (big.elements[wsc.receptacleId] as { levelId: ElementId }).levelId;
  gc();
  const addBalanced: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const f = (i % WSC.floors) + 1;
    const z = (Math.floor(i / WSC.floors) % WSC.zonesPerFloor) + 1;
    const placed = executeCommand(big, { type: "place_part", partId: `wsc-r-${i}`, typeId: receptacleType, levelId, position: { x: 100 * i, y: -5000 } });
    if (!placed.ok) throw new Error(`[perf/electrical] placing a receptacle refused: ${placed.error.message}`);
    big = placed.model;
    const head = big;
    const t = timeSync(() => executeCommand(head, { type: "create_service_link", linkId: `wsc-c-${i}`, sourceId: `w-l${f}-${z}`, members: [{ elementId: `wsc-r-${i}` }] }));
    if (!t.value.ok) throw new Error(`[perf/electrical] balanced add refused: ${t.value.error.message}`);
    big = t.value.model;
    addBalanced.push(t.ms);
  }
  const rebalance: number[] = [];
  let rebalanceMismatches = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const panel = `w-l${(i % WSC.floors) + 1}-${(Math.floor(i / WSC.floors) % WSC.zonesPerFloor) + 1}`;
    const head = big;
    const t = timeSync(() => planRebalance(head.elements, panel));
    rebalance.push(t.ms);
    if (JSON.stringify(t.value) !== JSON.stringify(planRebalance(head.elements, panel))) rebalanceMismatches += 1;
  }
  const planCircuiting = planCircuitingSamples(samplesPerRun, base.settings);
  const propose = proposeSamples(samplesPerRun, base);
  const checkEngine = new ElectricalLoadEngine(rules);
  // Committed state, as the model server and clients hold it (the edits above left a working copy).
  const checkHead: ModelState = { ...big, elements: freezeElements({ ...big.elements }) };
  const firstCheck = electricalCheck(checkEngine, checkHead);
  const check: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) check.push(timeSync(() => electricalCheck(checkEngine, checkHead)).ms);

  const counts = { totalElements, networkElements };
  const samples: Sample[] = [
    { metric: "electrical.aggregate.cold", values: cold, counts, note: `Fresh engine: every one of ${syn.counts.distribution} panels, boards and transformers reported (NEC 2023 demand, per phase, capacity, findings) over ${syn.counts.loads} loads` },
    { metric: "electrical.report.after_edit", values: afterEdit, counts, note: "After one load edit: the MDP's and the edited panel's reports, same engine (recomputes the path only)" },
    { metric: "electrical.report_all.after_edit", values: allAfterEdit, counts, note: "After one load edit: every node's report, same engine" },
    { metric: "electrical.schedules.cold.300", values: schedules.cold, counts: schedules.counts, note: `${SCHEDULE_PANELS} panel schedules evaluated and laid out (slots, per-phase kVA, NEC demand by class, totals) from a fresh engine` },
    { metric: "electrical.schedules.after_edit.300", values: schedules.afterEdit, counts: schedules.counts, note: `The same ${SCHEDULE_PANELS} panel schedules redrawn after one receptacle load edit (what a sheet set of panel schedules costs per edit)` },
    { metric: "electrical.circuit.edit", values: circuitEdit, counts, note: "executeCommand(add_link_members) putting one receptacle back on its 208 V branch circuit on the full head: what Add to circuit predicts locally before it sends" },
    { metric: "electrical.panel_view.after_edit", values: panelView, counts: { ...counts, visibleSolids: panelRows }, note: "After that circuit edit: panelSchedule for the panel, the engine's report for it and the panel list (distributionEquipment), what the panel view redraws. visibleSolids = slots + listed panels" },
    { metric: "electrical.panel_list", values: panelList, counts, note: "distributionEquipment alone: every element of the head scanned for panels, boards and transformers (the panel pickers and the panel view list)" },
    { metric: "electrical.circuit.edit.first", values: firstCircuitEdit, counts, note: "Informational: the first Add to circuit after load, which builds the link indexes once" },
    { metric: "store.scan.predicted", values: scanPredicted, counts, note: "Informational: elementValues over a model returned by executeCommand (a local prediction, not sealed)" },
    { metric: "store.scan.confirmed", values: scanConfirmed, counts, note: "Informational: elementValues over the same model sealed, as the server's commit and the client's applied changeset hold it" },
    { metric: "diagram.one_line.evaluate.150", values: diagram.evaluate, counts: { totalElements: diagram.elements, networkElements: diagram.nodes }, note: `Live one-line over ${diagram.nodes} pieces of equipment: graph, live field text, layout and drawing items from scratch` },
    { metric: "diagram.one_line.after_edit.150", values: diagram.afterEdit, counts: { totalElements: diagram.elements, networkElements: diagram.nodes }, note: "After one panel's bus rating changes: the whole one-line derived again from the graph" },
    { metric: "diagram.plumbing_riser.evaluate.200", values: piping.riser, counts: { totalElements: piping.elements, networkElements: piping.fixtures }, note: `Live sanitary riser over ${piping.fixtures} fixtures: pipe report, topology, labels, layout, drawing items and pipe targets from scratch` },
    { metric: "diagram.plumbing_riser.after_edit.200", values: piping.afterEdit, counts: { totalElements: piping.elements, networkElements: piping.fixtures }, note: "After one branch is resized: the whole riser derived again from the piping" },
    { metric: "diagram.plumbing_isometric.evaluate.200", values: piping.isometric, counts: { totalElements: piping.elements, networkElements: piping.fixtures }, note: "The same piping as an isometric, from scratch" },
    { metric: "electrical.circuit.add_balanced", values: addBalanced, counts, note: `One receptacle on a 208 V panel with no slots given (phase-balanced pick), ${wsc.counts.distribution} distribution nodes, ${wsc.counts.loads} loads` },
    { metric: "electrical.rebalance.plan", values: rebalance, counts, note: "The deterministic rebalance plan of one 42-circuit panel" },
    { metric: "electrical.check.all", values: check, counts, note: `The check list over the whole model, warm engine: ${firstCheck.length} items from ${wsc.counts.distribution} nodes` },
    { metric: "electrical.plan.circuiting.1200", values: planCircuiting.view, counts: { totalElements: planCircuiting.devices, networkElements: PLAN_CIRCUITS }, note: `An electrical plan printed with ${planCircuiting.devices} receptacles on ${PLAN_CIRCUITS} circuits: arcs from each symbol's connection point, home runs, gaps where circuits cross` },
    { metric: "electrical.plan.circuiting.after_move", values: planCircuiting.afterMove, counts: { totalElements: planCircuiting.devices, networkElements: PLAN_CIRCUITS }, note: "The same plan redrawn after one receptacle moves (its line and home run re-derived)" },
    { metric: "electrical.propose.receptacles.192", values: propose.values, counts: { totalElements: propose.elements, networkElements: propose.rooms }, note: `Receptacles proposed by NEC 2023 210.52 for ${propose.rooms} rooms (${PROPOSE_UNITS} copies of unit 001): room geometry read from the model, wall space, counters, islands, coverage. ${propose.devices} devices` },
    { metric: "electrical.plan.typical.24", values: planCircuiting.typical, counts: { totalElements: 31 * TYPICAL_COPIES, networkElements: 4 * TYPICAL_COPIES }, note: `A ${TYPICAL_COPIES}-unit typical (a unit panel and 30 receptacles on 4 circuits) printed with circuit numbers and home runs on every unit` },
  ];
  emit({
    suite: "electrical",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { tier, distribution: syn.counts.distribution, loads: syn.counts.loads, links: syn.counts.links, samplesPerRun, schedulePanels: SCHEDULE_PANELS },
    samples,
    invariants: { "electrical.recomputedAfterEdit": worstRecomputed, "electrical.incrementalMismatches": mismatches, "electrical.schedules.problems": schedules.problems, "diagram.nondeterministic": diagram.nondeterministic + piping.nondeterministic, "electrical.rebalanceNondeterministic": rebalanceMismatches, "electrical.plan.nondeterministic": planCircuiting.nondeterministic, "electrical.propose.nondeterministic": propose.nondeterministic, "electrical.propose.uncovered": propose.uncovered },
    info: { memory: memoryMB() },
  });
}

const PLAN_CIRCUITS = 150;
const PLAN_PER_CIRCUIT = 8;
const TYPICAL_COPIES = 24;
const PROPOSE_UNITS = 24;

/**
 * An electrical floor plan with its circuiting drawn (WS-F): 1,200 receptacles
 * on 150 circuits from four panels, laid so circuits cross, printed with
 * buildViewScene (arcs, home runs, crossing gaps); again after one receptacle
 * moves; and a 24-unit typical (one unit's panel and 30 receptacles) with
 * circuiting shown on every unit. Built on its own model so the timing is the
 * plan's circuiting, not the tier's ductwork.
 */
function planCircuitingSamples(samples: number, settings: ModelState["settings"]): { view: number[]; afterMove: number[]; typical: number[]; devices: number; nondeterministic: number } {
  const duplex = builtinPartType("builtin:duplex-receptacle@1")!.definition;
  const panelType = builtinPartType("builtin:panelboard-225@1")?.definition;
  if (!panelType) throw new Error("[perf/electrical] no built-in 208 V panelboard");
  let m: ModelState = { modelId: "plan-perf", revision: 0 as ModelState["revision"], elements: freezeElements({}), connections: [], settings };
  const run = (command: Command) => {
    const r = executeCommand(m, command);
    if (!r.ok) throw new Error(`[perf/electrical] plan setup ${command.type} refused: ${r.error.message}`);
    m = r.model;
  };
  run({ type: "create_level", levelId: "pl-1", name: "Level 1", elevationMm: 0 });
  for (let p = 0; p < 4; p++) run({ type: "place_part", partId: `pl-p${p}`, typeId: "pl-panel", ...(p === 0 ? { partType: panelType } : {}), levelId: "pl-1", position: { x: -3000, y: p * 20000 }, mark: `L${p + 1}`, values: { panel_name: `L${p + 1}` } });
  for (let c = 0; c < PLAN_CIRCUITS; c++) {
    const members: Array<{ elementId: string }> = [];
    for (let k = 0; k < PLAN_PER_CIRCUIT; k++) {
      // Rows of circuits, every other one turned diagonal so neighbouring rows cross.
      const id = `pl-r${c}-${k}`;
      const x = (c % 10) * 9000 + k * 1100;
      const y = Math.floor(c / 10) * 5000 + (c % 2 === 0 ? k * 600 : (PLAN_PER_CIRCUIT - k) * 600);
      run({ type: "place_part", partId: id, typeId: "pl-dup", ...(c === 0 && k === 0 ? { partType: duplex } : {}), levelId: "pl-1", position: { x, y } });
      members.push({ elementId: id });
    }
    run({ type: "create_service_link", linkId: `pl-c${c}`, sourceId: `pl-p${c % 4}`, members });
  }
  run({ type: "create_view", viewId: "pl-v", name: "Level 1 Power", viewType: "floor_plan", crop: { min: { x: -6000, y: -2000 }, max: { x: 96000, y: 80000 } }, props: { level: "Level 1", scale: 96, discipline: "electrical" } });
  m = { ...m, elements: freezeElements({ ...m.elements }) };
  const view: number[] = [];
  const afterMove: number[] = [];
  let nondeterministic = 0;
  let firstBytes = "";
  for (let i = 0; i < samples; i++) {
    const head = m;
    const t = timeSync(() => buildViewScene(head, "pl-v").scene.primitives.length);
    view.push(t.ms);
    const bytes = JSON.stringify(buildViewScene(head, "pl-v").scene.primitives);
    if (!firstBytes) firstBytes = bytes;
    else if (bytes !== firstBytes) nondeterministic += 1;
  }
  for (let i = 0; i < samples; i++) {
    run({ type: "move_elements", ids: [`pl-r${i % PLAN_CIRCUITS}-3`], delta: { x: 300, y: i % 2 === 0 ? 400 : -400 } });
    const head = m;
    afterMove.push(timeSync(() => buildViewScene(head, "pl-v").scene.primitives.length).ms);
  }
  // A typical unit: its own panel A001 and 30 receptacles on 4 circuits, 24 instances, circuiting on every one.
  run({ type: "place_part", partId: "ty-a", typeId: "pl-panel", levelId: "pl-1", position: { x: 0, y: -30000 }, mark: "A001", values: { panel_name: "A001" } });
  const unit = ["ty-a"];
  for (let c = 0; c < 4; c++) {
    const members: Array<{ elementId: string }> = [];
    for (let k = 0; k < 30 / 4 + (c < 2 ? 0.5 : -0.5); k++) {
      const id = `ty-r${c}-${k}`;
      run({ type: "place_part", partId: id, typeId: "pl-dup", levelId: "pl-1", position: { x: 1000 + k * 900, y: -30000 + c * 1200 } });
      members.push({ elementId: id });
      unit.push(id);
    }
    run({ type: "create_service_link", linkId: `ty-c${c}`, sourceId: "ty-a", positions: [c + 1], members });
  }
  run({ type: "create_group", groupId: "grp-ty", name: "Unit 001" });
  run({ type: "assign_elements_to_group", ids: unit, groupId: "grp-ty" });
  run({ type: "set_group_typical", groupId: "grp-ty", mark: "001", array: { count: TYPICAL_COPIES, columns: 6, spacingMm: { x: 12000, y: -8000 } } });
  run({ type: "create_view", viewId: "ty-v", name: "Units", viewType: "floor_plan", crop: { min: { x: -2000, y: -62000 }, max: { x: 72000, y: -24000 } }, props: { level: "Level 1", scale: 96, discipline: "electrical", circuitGraphics: { style: "numbers", allCopies: true } } });
  const typHead: ModelState = { ...m, elements: freezeElements({ ...m.elements }) };
  const typical: number[] = [];
  for (let i = 0; i < samples; i++) typical.push(timeSync(() => buildViewScene(typHead, "ty-v").scene.primitives.length).ms);
  return { view, afterMove, typical, devices: PLAN_CIRCUITS * PLAN_PER_CIRCUIT, nondeterministic };
}

/** Panel schedules of a 300-panel building (10 floors x 15 zones: a 480 V and a 208 V panel per zone) on the tier's model. */
const SCHEDULE_PANELS = 300;

function panelSchedules(base: ModelState): { cold: number[]; afterEdit: number[]; problems: number; counts: { totalElements: number; networkElements: number } } {
  const syn = syntheticDistribution({ floors: 10, zonesPerFloor: 15 });
  let model: ModelState = { ...base, elements: freezeElements({ ...base.elements, ...syn.elements }) };
  const panelIds = Object.values(syn.elements)
    .filter((el) => el.kind === "part" && distributionOf(syn.elements, el)?.kind === "panelboard")
    .map((el) => el.id)
    .slice(0, SCHEDULE_PANELS);
  if (panelIds.length !== SCHEDULE_PANELS) throw new Error(`[perf/electrical] expected ${SCHEDULE_PANELS} panelboards, got ${panelIds.length}`);
  const template = builtinFormTemplate("panel");
  const defs = (): FormScheduleDefinition[] => panelIds.map((id) => ({ kind: "panel", elementId: id, template, rules: "nec-2023" }));
  const drawAll = (m: ModelState, ds: readonly FormScheduleDefinition[]) => {
    let problems = 0;
    let area = 0;
    for (const d of ds) {
      const t = formTable(m, d);
      if (t.form.problem) problems += 1;
      area += t.size.x * t.size.y;
    }
    return { problems, area };
  };
  const cold: number[] = [];
  let problems = 0;
  for (let i = 0; i < COLD_SAMPLES; i++) {
    // A fresh pack set gets a fresh engine for the rules id (engines are per set), and fresh definitions: nothing cached.
    const fresh = PackSet.create([]);
    const t = timeSync(() => withPackSet(fresh, () => drawAll(model, defs())));
    cold.push(t.ms);
    problems = Math.max(problems, t.value.problems);
  }
  const placed = defs();
  drawAll(model, placed);
  const afterEdit: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const zone = `e-l${(i % 10) + 1}-${(i % 15) + 1}`;
    const edited = executeCommand(model, { type: "set_parameters", id: `${zone}-r${(i % 30) + 1}-1`, scope: "instance", values: { load_va: 200 + i } });
    if (!edited.ok) throw new Error(`[perf/electrical] schedule edit refused: ${edited.error.message}`);
    model = edited.model;
    const head = model;
    afterEdit.push(timeSync(() => drawAll(head, placed)).ms);
  }
  return { cold, afterEdit, problems, counts: { totalElements: Object.keys(model.elements).length, networkElements: syn.counts.loads + syn.counts.distribution } };
}

try {
  main();
} catch (err) {
  console.error("[perf/electrical] failed", err);
  process.exit(1);
}


/**
 * WS-G: unit 001 traced 24 times side by side (192 rooms), every room
 * proposed at once the way the Propose panel does when all are ticked:
 * roomGeometryFromModel per room, then proposeReceptacles. Timed per run;
 * the same rooms proposed twice must give the same bytes, and every room
 * must pass its coverage.
 */
function proposeSamples(samplesPerRun: number, base: ModelState): { values: number[]; rooms: number; devices: number; elements: number; nondeterministic: number; uncovered: number } {
  // On the tier's building, so walls, doors and parts of the whole model are what each room reads past.
  let model: ModelState = base;
  const run = (command: Command) => {
    const r = executeCommand(model, command);
    if (!r.ok) throw new Error(`[perf/electrical] ${command.type} refused: ${r.error.message}`);
    model = r.model;
  };
  run({ type: "create_level", levelId: "perf-propose-lvl", name: "Proposal units", elevationMm: 120_000 });
  for (let u = 0; u < PROPOSE_UNITS; u++) run(unit001Architecture("perf-propose-lvl", `pu${String(u + 1).padStart(3, "0")}`, { x: -2000 + (u % 6) * 32, y: Math.floor(u / 6) * 32 }));
  const head: ModelState = { ...model, elements: freezeElements({ ...model.elements }) };
  const rules = receptaclePlacementRules(necEdition("2023"));
  const roomIds = elementValues(head.elements).filter((e) => e.kind === "room" && e.id.startsWith("pu")).map((e) => e.id);
  const request = { mode: "dwelling" as const, rules, devices: { wall: "builtin:duplex-receptacle@1", countertop: "builtin:countertop-receptacle@1", bathroom: "builtin:gfci-receptacle@1" } };
  const once = () => proposeReceptacles(receptacleRoomGeometries(head, roomIds, rules), request);
  const first = once();
  const firstBytes = JSON.stringify(first);
  gc();
  const values: number[] = [];
  let nondeterministic = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(once);
    values.push(t.ms);
    if (JSON.stringify(t.value) !== firstBytes) nondeterministic += 1;
  }
  return { values, rooms: roomIds.length, devices: first.devices.length, elements: Object.keys(head.elements).length, nondeterministic, uncovered: first.rooms.filter((r) => !r.passes).length };
}

