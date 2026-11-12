/**
 * @jest-environment node
 *
 * IFC 4.3 export of three synthetic example buildings (#40). Each script in
 * packages/bim-script/examples runs with the script kit's own runner on an
 * empty model, its edits are committed through the kernel, and the exported
 * STEP text is read back. small-office's storey names, wall count and room
 * names are checked in packages/bim-mcp/__tests__/examples-run.test.ts (#50);
 * this file covers the rest of it, the duct run and the panel.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, type ModelState } from "@permitzip/bim-kernel";
import { defineScript, runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { danglingReferences, entityCounts, exportIfc, readStep, type ReadEntity, type StepFile } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import electricalRoom from "../../bim-script/examples/electrical-room";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import smallOffice from "../../bim-script/examples/small-office";
import { num, ofType, ref, refs, text } from "./a13a-ifc-support";

const FT = 304.8;
const IN = 25.4;
/** What a current server takes, as the tool server's slice features. */
const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];

/** Runs each script on an empty model in turn and commits its edits through the kernel. */
async function build(...scripts: ScriptDefinition[]): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  for (const [i, def] of scripts.entries()) {
    const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: `sha256:examples-ifc-${i}` });
    if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
    for (const batch of out.batches) m.ok(batch);
  }
  return m.head;
}

const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };
const TIME_STAMP = "2026-11-12T00:00:00";

/** The model's IFC 4.3 export, read back as STEP. */
function exported(model: ModelState): StepFile {
  const file = readStep(exportIfc({ model, project: PROJECT, timeStamp: TIME_STAMP }).text);
  expect(file.schemas).toEqual(["IFC4X3_ADD2"]);
  expect(danglingReferences(file)).toEqual([]);
  return file;
}

/** The entity at `#id`, or a failure naming it. */
function get(file: StepFile, id: number | undefined): ReadEntity {
  const e = id === undefined ? undefined : file.entities.get(id);
  if (!e) throw new Error(`no entity #${id}`);
  return e;
}

/** The only entity of a type. */
function only(file: StepFile, type: string): ReadEntity {
  const all = ofType(file, type);
  expect(all).toHaveLength(1);
  return get(file, all[0]?.id);
}

/** Property set name → property name → value, on an entity or (HasPropertySets) its type. */
function psets(file: StepFile, e: ReadEntity): Record<string, Record<string, unknown>> {
  const ids = ofType(file, "IFCRELDEFINESBYPROPERTIES").filter((r) => refs(r, 4).includes(e.id)).map((r) => ref(r, 5));
  if (e.type.endsWith("TYPE")) ids.push(...refs(e, 5));
  const out: Record<string, Record<string, unknown>> = {};
  for (const set of ids.flatMap((id) => file.entities.get(id) ?? [])) {
    const props: Record<string, unknown> = {};
    for (const p of refs(set, set.type === "IFCPROPERTYSET" ? 4 : 5).flatMap((id) => file.entities.get(id) ?? [])) {
      const v = p.type === "IFCPROPERTYSINGLEVALUE" ? p.args[2] : p.args[3];
      props[text(p, 0) ?? "?"] = v?.kind === "typed" && "value" in v.value ? v.value.value : v?.kind === "number" ? v.value : null;
    }
    out[text(set, 2) ?? "?"] = props;
  }
  return out;
}

/** The entities a relationship of type `rel` ties to `of`: its owner at argument `owner`, its members at `members`. */
const related = (file: StepFile, rel: string, owner: number, members: number, of: number) => ofType(file, rel).filter((r) => ref(r, owner) === of).flatMap((r) => refs(r, members));

describe("small-office", () => {
  let file: StepFile;
  beforeAll(async () => {
    file = exported(await build(smallOffice));
  });

  it("writes each storey at its elevation, with its six walls in it", () => {
    const storeys = ofType(file, "IFCBUILDINGSTOREY").sort((a, b) => (num(a, 9) ?? 0) - (num(b, 9) ?? 0));
    expect(storeys.map((s) => text(s, 2))).toEqual(["Level 1", "Level 2"]);
    expect(num(storeys[0], 9)).toBeCloseTo(0, 3);
    expect(num(storeys[1], 9)).toBeCloseTo(12 * FT, 3);
    for (const s of storeys) expect(related(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE", 5, 4, s.id).filter((id) => file.entities.get(id)?.type === "IFCWALL")).toHaveLength(6);
  });

  it("sizes every door and window, and tags the entry door 101A", () => {
    const doors = ofType(file, "IFCDOOR");
    expect(doors.map((d) => [num(d, 8), num(d, 9)])).toEqual(Array(5).fill([2134, 36 * IN]));
    expect(doors.filter((d) => text(d, 7) !== null).map((d) => [text(d, 2), text(d, 7)])).toEqual([["101A", "101A"]]);
    expect(ofType(file, "IFCWINDOW").map((w) => [num(w, 8), num(w, 9)])).toEqual(Array(6).fill([5 * FT, 4 * FT]));
  });

  it("gives every room its number as Reference and a floor area", () => {
    for (const space of ofType(file, "IFCSPACE")) {
      const sets = psets(file, space);
      expect(sets.Pset_SpaceCommon?.Reference).toBe(text(space, 2));
      expect(sets.Qto_SpaceBaseQuantities?.NetFloorArea).toBeGreaterThan(10);
    }
  });
});

describe("rooftop-unit", () => {
  let file: StepFile;
  beforeAll(async () => {
    file = exported(await build(rooftopUnit));
  });

  it("writes the duct run: four segments swept at the sized section and two elbows, each run in its system with the unit", () => {
    expect(entityCounts(file)).toMatchObject({ IFCDUCTSEGMENT: 4, IFCDUCTFITTING: 2, IFCUNITARYEQUIPMENT: 1 });
    const sections = ofType(file, "IFCDUCTSEGMENT").map((seg) => {
      const rep = get(file, refs(get(file, ref(seg, 6)), 2)[0]);
      const profile = get(file, ref(get(file, refs(rep, 3)[0]), 0));
      return [num(profile, 3), num(profile, 4)];
    });
    // 4000 CFM at 12 in deep: wider than 20 in.
    expect(new Set(sections.map(String)).size).toBe(1);
    expect(sections[0]?.[0]).toBeGreaterThan(20 * IN);
    expect(sections[0]?.[1]).toBe(305);
    const systems = ofType(file, "IFCDISTRIBUTIONSYSTEM");
    expect(systems.map((s) => [text(s, 2), text(s, 6)]).sort()).toEqual([["Return air", "AIRCONDITIONING"], ["Supply air", "AIRCONDITIONING"]]);
    for (const s of systems) {
      const members = related(file, "IFCRELASSIGNSTOGROUP", 6, 4, s.id).map((id) => file.entities.get(id)?.type);
      expect(members.sort()).toEqual(["IFCDUCTFITTING", "IFCDUCTSEGMENT", "IFCDUCTSEGMENT", "IFCUNITARYEQUIPMENT"]);
    }
  });

  it("joins the unit's supply and return ports to a duct port each", () => {
    const unit = only(file, "IFCUNITARYEQUIPMENT");
    expect(text(unit, 2)).toBe("RTU-1");
    const unitPorts = related(file, "IFCRELNESTS", 4, 5, unit.id);
    const ductPorts = new Set(ofType(file, "IFCDUCTSEGMENT").flatMap((s) => related(file, "IFCRELNESTS", 4, 5, s.id)));
    const partners = ofType(file, "IFCRELCONNECTSPORTS").flatMap((c) => (unitPorts.includes(ref(c, 4)) ? [ref(c, 5)] : unitPorts.includes(ref(c, 5)) ? [ref(c, 4)] : []));
    expect(unitPorts).toHaveLength(2);
    expect(partners.filter((p) => ductPorts.has(p))).toHaveLength(2);
  });
});

/** After electrical-room: two of the panel's own instance parameters, set as an agent's script would. */
const setPanelValues = defineScript({
  kind: "layout",
  reads: { levels: true, kinds: ["part", "service_link"], partTypes: ["builtin:panelboard-*"] },
  parameters: {},
  run(ctx) {
    const panel = ctx.model.ofKind("part").find((p) => p.kind === "part" && p.mark === "LP-1");
    if (!panel) throw new Error("no LP-1");
    ctx.edit({ type: "set_parameters", id: panel.id, scope: "instance", values: { panel_name: "LP-1 synthetic", aic: 22000 } });
  },
});

describe("electrical-room", () => {
  let file: StepFile;
  let board: ReadEntity;
  beforeAll(async () => {
    file = exported(await build(electricalRoom, setPanelValues));
    board = only(file, "IFCELECTRICDISTRIBUTIONBOARD");
  });

  it("writes one board named and tagged LP-1, where the script put it", () => {
    expect(entityCounts(file)).toMatchObject({ IFCELECTRICDISTRIBUTIONBOARD: 1, IFCDISTRIBUTIONCIRCUIT: 2 });
    expect([text(board, 2), text(board, 7)]).toEqual(["LP-1", "LP-1"]);
    const point = get(file, ref(get(file, ref(get(file, ref(board, 5)), 1)), 0)).args[0];
    const xyz = point?.kind === "list" ? point.items.map((c) => (c.kind === "number" ? c.value : NaN)) : [];
    expect(xyz.map((c) => Math.round(c * 10) / 10)).toEqual([1 * FT, 13 * FT, 0]);
  });

  it("types the board by its panelboard type, with its rated voltage and ratings", () => {
    const rel = ofType(file, "IFCRELDEFINESBYTYPE").find((r) => refs(r, 4).includes(board.id));
    const type = get(file, rel && ref(rel, 5));
    expect([type.type, text(type, 2)]).toEqual(["IFCELECTRICDISTRIBUTIONBOARDTYPE", "125A 120/208V 1-phase 3-wire 30 circuit, main breaker"]);
    const sets = psets(file, type);
    expect(sets.Pset_ElectricalDeviceCommon?.RatedVoltage).toBe(208);
    expect(sets.MutinyBIM_Parameters).toMatchObject({ "Bus rating": 125, Circuits: 30, Mains: "125A MCB", Phases: "1" });
  });

  it("writes the parameters a script set on the board", () => {
    expect(Object.assign({}, ...Object.values(psets(file, board)))).toMatchObject({ "Panel name": "LP-1 synthetic", "Short-circuit rating": 22000 });
  });

  it("writes one circuit per room, each grouping the board, and every outlet in one", () => {
    const circuits = ofType(file, "IFCDISTRIBUTIONCIRCUIT");
    expect(circuits.map((c) => text(c, 2)).sort()).toEqual(["Bedroom receptacles", "Living room receptacles"]);
    const members = circuits.map((c) => related(file, "IFCRELASSIGNSTOGROUP", 6, 4, c.id));
    for (const m of members) expect(m).toContain(board.id);
    const outlets = ofType(file, "IFCOUTLET").map((o) => o.id);
    expect(outlets.length).toBeGreaterThanOrEqual(6);
    expect(outlets.filter((o) => members.filter((m) => m.includes(o)).length !== 1)).toEqual([]);
  });
});
