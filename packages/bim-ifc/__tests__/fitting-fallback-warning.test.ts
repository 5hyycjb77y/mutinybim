/**
 * @jest-environment node
 *
 * When a fitting's library shape fails to resolve, exportIfc falls back to a
 * leg to each port (#123). That fallback was only logged to the console; the
 * export report now says so too, so the person exporting can see which
 * fitting came out simplified.
 *
 * The kernel's `fittingBody` is made to throw for one fitting; everything
 * else is the real kernel.
 */
import { DEFAULT_SETTINGS, asRevision, gatedRecordFeatures, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { runScript, sliceModel } from "@permitzip/bim-script";
import { PROTOCOL_FEATURES } from "@permitzip/bim-sync";
import { exportIfc, readStep, type ReadEntity } from "../src";
import { Log } from "../../bim-kernel/__tests__/a13a-fixtures";
import rooftopUnit from "../../bim-script/examples/rooftop-unit";
import { ref, refs, text } from "./a13a-ifc-support";

const mockBroken = new Set<string>();

jest.mock("@permitzip/bim-kernel", () => {
  const actual = jest.requireActual<typeof import("@permitzip/bim-kernel")>("@permitzip/bim-kernel");
  return {
    ...actual,
    fittingBody: (...args: Parameters<typeof actual.fittingBody>) => {
      if (mockBroken.has(args[1].id)) throw new Error("the fitting library could not build this shape");
      return actual.fittingBody(...args);
    },
  };
});

const FEATURES = [...new Set([...Object.values(PROTOCOL_FEATURES), ...gatedRecordFeatures()])];
const PROJECT = { id: "2c9a7e14-5b3d-4f86-a1e0-7d4c3b2a1f09", name: "Synthetic examples" };

async function rooftop(): Promise<ModelState> {
  const m = new Log({ modelId: "examples", revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  const out = await runScript(rooftopUnit, { slice: sliceModel(m.head, rooftopUnit.manifest.reads, [], FEATURES), values: {}, scriptHash: "sha256:fitting-fallback" });
  if (out.kind !== "edits") throw new Error(`expected edits, got ${out.kind}`);
  for (const batch of out.batches) m.ok(batch);
  return m.head;
}

const fittingsOf = (model: ModelState) => Object.values(model.elements).filter((e): e is Extract<BimElement, { kind: "run_fitting" }> => e.kind === "run_fitting");

/** The export's warnings, and the kind of body each fitting got. */
function exported(model: ModelState) {
  const out = exportIfc({ model, project: PROJECT, timeStamp: "2026-11-12T00:00:00" });
  const file = readStep(out.text);
  const bodyKind = (id: string): string | null => {
    const guid = out.report.globalIds[id];
    const e: ReadEntity | undefined = [...file.entities.values()].find((x) => x.args[0]?.kind === "string" && x.args[0].value === guid);
    if (!e || e.args[6]?.kind !== "ref") return null;
    const shape = file.entities.get(ref(e, 6));
    const rep = shape ? file.entities.get(refs(shape, 2)[0] ?? -1) : undefined;
    return text(rep, 2);
  };
  return { warnings: out.report.warnings, bodyKind };
}

describe("exportIfc: a fitting whose library shape doesn't resolve", () => {
  let logged: jest.SpyInstance;
  beforeEach(() => {
    mockBroken.clear();
    logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  it("says nothing when every fitting resolves", async () => {
    const model = await rooftop();
    const { warnings, bodyKind } = exported(model);
    const fittings = fittingsOf(model);
    expect(fittings.length).toBeGreaterThan(1);
    expect(fittings.map((f) => bodyKind(f.id))).toEqual(fittings.map(() => "Tessellation"));
    expect(warnings.filter((w) => fittings.some((f) => w.includes(f.id)))).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("names the fitting in the export report when it falls back to a leg to each port", async () => {
    const model = await rooftop();
    const [broken, fine] = fittingsOf(model);
    if (!broken || !fine) throw new Error("rooftop-unit has fewer than two fittings");
    // Two openings 200 mm either side of the fitting's point, so the fallback has legs to sweep.
    const p = broken.position;
    const ports = broken.ports.slice(0, 2).map((port, i) => ({ ...port, position: { x: p.x + (i === 0 ? -200 : 200), y: p.y, z: p.z }, direction: { x: i === 0 ? -1 : 1, y: 0, z: 0 } }));
    expect(ports).toHaveLength(2);
    mockBroken.add(broken.id);
    const { warnings, bodyKind } = exported({ ...model, elements: { ...model.elements, [broken.id]: { ...broken, ports } } });

    expect(bodyKind(broken.id)).toBe("SweptSolid");
    expect(bodyKind(fine.id)).toBe("Tessellation");
    expect(warnings.filter((w) => w.includes(broken.id))).toEqual([`${broken.id}: its fitting shape did not resolve, so it is written as a leg to each port`]);
    expect(warnings.filter((w) => w.includes(fine.id))).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("says it has no body when its openings are all at its own point, as an elbow's are", async () => {
    const model = await rooftop();
    const [broken] = fittingsOf(model);
    if (!broken) throw new Error("rooftop-unit has no fitting");
    // An elbow meets its runs at one point, so a leg to each opening has no length to sweep.
    expect(broken.ports.every((port) => port.position.x === broken.position.x && port.position.y === broken.position.y && port.position.z === broken.position.z)).toBe(true);
    mockBroken.add(broken.id);
    const { warnings, bodyKind } = exported(model);

    expect(bodyKind(broken.id)).toBeNull();
    expect(warnings.filter((w) => w.includes(broken.id))).toEqual([`${broken.id}: its fitting shape did not resolve and it has no ports with length, so it has no body in the file`]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
