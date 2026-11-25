/**
 * @jest-environment node
 *
 * #66, the circuits half: a group in the file (a distribution system, a
 * circuit) that became no record is named in the import report, so nobody
 * learns later that what they exported as circuited came back loose.
 * Bringing the circuits themselves back is not in this change.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { runScript, sliceModel, type ScriptDefinition } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, importIfc } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import electricalRoom from "../../bim-script/examples/electrical-room";
import { IfcText, architectureAndStructure, hostModel, mechanicalAndSprinkler } from "./i9-fixtures";

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };

/** Runs the script on an empty model and commits its edits through the kernel. */
async function build(def: ScriptDefinition): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(def, { slice: sliceModel(m.head, def.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:import-groups" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

/** The model's own export, read back into an empty model. */
function readBack(model: ModelState) {
  const ifc = exportIfc({ model, project: PROJECT, timeStamp: "2026-11-12T00:00:00" }).text;
  const empty: ModelState = { modelId: "readback", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return importIfc(ifc, { model: empty, referenceId: "ref", sourceKey: "rt", sourceId: "rt", label: "Round trip", disciplines: ["architecture", "electrical"] });
}

const ofKind = (els: readonly BimElement[], kind: BimElement["kind"]) => els.filter((e) => e.kind === kind);
const opts = (label: string) => ({ model: hostModel(), referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label, disciplines: ["mechanical"] });

describe("groups the import leaves behind are named in its report", () => {
  let model: ModelState;
  beforeAll(async () => {
    model = await build(electricalRoom);
  });

  it("electrical-room: the report names the two circuits that weren't brought in, first", () => {
    expect(ofKind(Object.values(model.elements), "service_link")).toHaveLength(2);
    const { report } = readBack(model);
    expect(report.notes[0]).toBe("2 circuits and feeders weren't brought in (Bedroom receptacles and Living room receptacles); anything in them that converted came in on its own, so set them up again by hand");
    // The parts themselves still came in: the note is about the grouping, not about them. (Only the circuits' own
    // members are checked, so this doesn't break when another kind in the room starts to come in.)
    const converted = Object.fromEntries(report.classes.map((c) => [c.label, c.converted]));
    expect(converted).toMatchObject({ Receptacles: 11, "Electrical equipment": 1 });
  });

  it("a system whose runs converted isn't named; one nothing came from is", () => {
    const { report, records } = importIfc(mechanicalAndSprinkler().text, opts("Acme MEP"));
    expect(ofKind(records, "mep_system").map((s) => Reflect.get(s, "name"))).toEqual(["Supply Air 1"]);
    const about = report.notes.filter((n) => n.includes("brought in ("));
    expect(about).toEqual(["1 system wasn't brought in (Wet sprinkler); anything in it that converted came in on its own, so set it up again by hand"]);
  });

  it("a file with no groups gets no such note", () => {
    const { report } = importIfc(architectureAndStructure().text, opts("Shell"));
    expect(report.notes.filter((n) => n.includes("brought in ("))).toEqual([]);
  });

  it("a group no class takes (the export's own organization group) isn't named", () => {
    const { report } = readBack(model);
    expect(report.notes.join(" ")).not.toContain("General");
  });

  it("a very long group name is cut short in the note", () => {
    const t = IfcText.start();
    t.storey("Level 1", 0);
    const head = t.product("Level 1", "IFCFIRESUPPRESSIONTERMINAL", "Head", [0, 0, 2900], t.body([t.extrude(t.circle(30), 50)]), ".SPRINKLER.", { tag: "SP-1" });
    t.assign(t.system("x".repeat(5000), "FIREPROTECTION"), [head]);
    const { report } = importIfc(t.text(), opts("Long name"));
    const [note] = report.notes.filter((n) => n.includes("brought in ("));
    expect(note).toBe(`1 system wasn't brought in (${"x".repeat(79)}…); anything in it that converted came in on its own, so set it up again by hand`);
  });
});
