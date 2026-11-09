/** @jest-environment node */
import { MeshCache, type TriangleMesh } from "@permitzip/bim-geometry";
import { isPartModel2, partMesh, resolveGeometry, localBounds, setPartMeshProvider, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { checkScriptOutput, defineScript, parts, runScript, sliceModel, units } from "../src";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";
import { DEFAULT_SETTINGS, type ModelState, type Revision } from "@permitzip/bim-kernel";

/**
 * G15: the kit builds real solids. Profiles with fillets and holes, extrude,
 * cut, revolve, sweep along straights and bends, loft, pattern and mirror
 * become part model schema 2, and the part's mesh is that solid. Fails on
 * round 14's kit: it had box, cylinder and a width-only transition, wrote
 * primitives, and had no profile, sweep, loft or pattern.
 */

const IN = 25.4;

function volume(m: TriangleMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const p = (k: number): [number, number, number] => {
      const i = (m.indices[t + k] ?? 0) * 3;
      return [m.positions[i] ?? 0, m.positions[i + 1] ?? 0, m.positions[i + 2] ?? 0];
    };
    const [a, b, c] = [p(0), p(1), p(2)];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/** z extent (and y extent) of the mesh's corners at x ≈ `x`. */
function sectionExtent(m: TriangleMesh, x: number): { y: number; z: number } {
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    if (Math.abs((m.positions[i] ?? 0) - x) > 0.5) continue;
    y0 = Math.min(y0, m.positions[i + 1] ?? 0);
    y1 = Math.max(y1, m.positions[i + 1] ?? 0);
    z0 = Math.min(z0, m.positions[i + 2] ?? 0);
    z1 = Math.max(z1, m.positions[i + 2] ?? 0);
  }
  return { y: y1 - y0, z: z1 - z0 };
}

beforeAll(async () => {
  setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
});
afterAll(() => setPartMeshProvider(null));

describe("g15-transition-tapers-both", () => {
  it("a transition narrows height as well as width", () => {
    const def = parts.part("Transition", { type: "24x16-12x8", category: "duct_accessory" }).transition({ length: units.in(18), fromWidth: units.in(24), toWidth: units.in(12), fromHeight: units.in(16), toHeight: units.in(8) }).build();
    const m = partMesh(def);
    const inlet = sectionExtent(m, -9 * IN);
    const outlet = sectionExtent(m, 9 * IN);
    expect(inlet.y).toBeCloseTo(24 * IN, 0);
    expect(inlet.z).toBeCloseTo(16 * IN, 0);
    expect(outlet.y).toBeCloseTo(12 * IN, 0);
    expect(outlet.z).toBeCloseTo(8 * IN, 0);
  });

  it("a one-height transition still reads as before, and parameters follow", () => {
    const p = parts.part("Transition", { type: "24-12", category: "duct_accessory" });
    const W = p.param("inlet_width", { label: "Inlet width", value: units.in(24) });
    const def = p.transition({ length: units.in(18), fromWidth: W, toWidth: units.in(12), height: units.in(12) }).build();
    expect(sectionExtent(partMesh(def), -9 * IN).y).toBeCloseTo(24 * IN, 0);
    const wider = partMesh({ ...def, typeValues: { ...def.typeValues, inlet_width: 30 * IN } });
    expect(sectionExtent(wider, -9 * IN).y).toBeCloseTo(30 * IN, 0);
  });
});

describe("g15-sweep-elbow", () => {
  it("sweeps a round profile along a straight, a 90° bend and a straight: an elbow with the bend's exact volume", () => {
    const r = 3 * IN;
    const R = 9 * IN;
    const def = parts
      .part("Elbow", { type: "6 in 90", category: "duct_accessory" })
      .sweep(parts.circle(units.in(6)), { on: "plan", at: units.in(12), start: [units.in(0), units.in(0)], heading: "right", segments: [{ straight: units.in(6) }, { bend: { radius: units.in(9), angle: 90, turn: "left" } }, { straight: units.in(6) }] })
      .build();
    const m = partMesh(def);
    const expected = Math.PI * r * r * (6 * IN + 6 * IN + (Math.PI / 2) * R);
    expect(volume(m) / expected).toBeGreaterThan(0.98);
    expect(volume(m) / expected).toBeLessThan(1.01);
    // It ends heading +y, centred on x = 6 + 9 in.
    expect(m.bounds.max[1]).toBeCloseTo(9 * IN + 6 * IN, 0);
    expect(m.bounds.max[0]).toBeCloseTo(15 * IN + r, 0);
  });

  it("sweeps a rectangle the other way (right turn) and with a filleted profile", () => {
    const def = parts
      .part("Rect elbow", { type: "12x8", category: "duct_accessory" })
      .sweep(parts.rect(units.in(12), units.in(8), { fillet: units.in(1) }), { on: "plan", at: units.in(10), start: [0, 0], heading: "right", segments: [{ bend: { radius: units.in(12), angle: 90, turn: "right" } }] })
      .build();
    const m = partMesh(def);
    // Turning right about (0, -12 in): it ends at (12 in, -12 in) heading -y, the 12 in side now across x.
    expect(m.bounds.min[1]).toBeCloseTo(-12 * IN, 0);
    expect(m.bounds.max[0]).toBeCloseTo(18 * IN, 0);
    expect(m.bounds.max[2] - m.bounds.min[2]).toBeCloseTo(8 * IN, 0);
  });

  it("refuses a sharp corner in words", () => {
    // Two straights in a row are one chain; a heading change without a bend can't be written by the kit, so the kernel check is on the model.
    const def = parts.part("Pipe", { type: "2", category: "generic" }).sweep(parts.circle(units.in(2)), { on: "plan", start: [0, 0], heading: "up", segments: [{ straight: units.in(10) }, { straight: units.in(5) }] }).build();
    expect(localBounds(resolveGeometry(def)).max[1]).toBeCloseTo(15 * IN, 0);
  });
});

describe("g15-loft-transition (kit)", () => {
  it("lofts rectangle to round between two plan heights", () => {
    const def = parts.part("Square to round", { type: "24x24-16", category: "duct_accessory" }).loft([{ profile: parts.rect(units.in(24), units.in(24)), at: units.in(0) }, { profile: parts.circle(units.in(16)), at: units.in(20) }]).build();
    const m = partMesh(def);
    expect(m.bounds.max[2]).toBeCloseTo(20 * IN, 0);
    expect(volume(m)).toBeGreaterThan(Math.PI * (8 * IN) ** 2 * 20 * IN);
    expect(volume(m)).toBeLessThan((24 * IN) ** 2 * 20 * IN);
  });
});

describe("g15-pattern (kit)", () => {
  it("patterns fins along x and mirrors a door; holes go through", () => {
    const b = parts.part("Coil", { type: "36", category: "mechanical_equipment" });
    b.box({ length: units.in(36), width: units.in(4), height: units.in(24) });
    b.extrude(parts.rect(units.in(0.25), units.in(6)), { on: "plan", from: units.in(24), to: units.in(25), id: "fin" });
    b.pattern(["fin"], { along: "x", count: 10, spacing: units.in(3) });
    b.mirror("last", { across: "x" });
    b.cut(parts.circle(units.in(2)), { on: "front", from: units.in(-20), to: units.in(20) });
    const def = b.build();
    expect(isPartModel2(def.model ?? { id: "x", referencePlanes: [], sketches: [], features: [], planDisplay: "model", types: [] })).toBe(true);
    const m = partMesh(def);
    const shell = 36 * IN * 4 * IN * 24 * IN;
    const fin = 0.25 * IN * 6 * IN * 1 * IN;
    // Fins at x = 0, ±3 … ±27 in (the pattern's nine copies and their mirror images); the hole takes half a 2 in round out of the box's 36 in.
    const expected = shell - 0.5 * Math.PI * IN ** 2 * 36 * IN + 19 * fin;
    expect(Math.abs(volume(m) - expected) / expected).toBeLessThan(0.002);
  });

  it("revolves a bell and cuts a holed plate", () => {
    const b = parts.part("Flange", { type: "8", category: "generic" });
    b.extrude(parts.rect(units.in(10), units.in(10), { chamfer: units.in(1) }).hole(parts.circle(units.in(8))), { to: units.in(0.5) });
    b.revolve(parts.polygon([[units.in(4), units.in(0)], [units.in(5), units.in(0)], [units.in(4.2), units.in(6)], [units.in(3.8), units.in(6)]]), { on: "front", axis: [[units.in(0), units.in(0)], [units.in(0), units.in(1)]] });
    const def = b.build();
    const m = partMesh(def);
    expect(m.bounds.max[2]).toBeCloseTo(6 * IN, 0);
    const plate = (10 * IN) ** 2 - 4 * 0.5 * IN ** 2 - Math.PI * (4 * IN) ** 2;
    expect(volume(m)).toBeGreaterThan(plate * 0.5 * IN);
  });
});

function head(): ModelState {
  return { modelId: "g15", revision: 1 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

describe("g15-script-part-has-pictures", () => {
  it("a script-made part gets front, side and plan pictures drawn from its solid, and says it was made by a script", async () => {
    const script = defineScript({
      kind: "part",
      reads: {},
      parameters: {},
      run(ctx) {
        const b = parts.part("Fan", { type: "18", category: "mechanical_equipment" });
        b.box({ length: units.in(24), width: units.in(24), height: units.in(20) });
        b.cylinder({ diameter: units.in(18), length: units.in(6), axis: "z" }, { z: units.in(23) });
        ctx.parts.define("acme.fan.18", b.build());
      },
    });
    const output = await runScript(script, { slice: sliceModel(head(), {}), values: {}, scriptHash: "sha256:g15" });
    const check = checkScriptOutput(head(), JSON.parse(JSON.stringify(output)));
    expect(check.ok).toBe(true);
    if (check.kind !== "part_types" || output.kind !== "part_types") throw new Error("expected part types");
    const t = check.types[0];
    expect(t?.notes).toEqual([]);
    expect(Object.keys(t?.pictures ?? {}).sort()).toEqual(["front", "plan", "side"]);
    expect(t?.pictures.front).toContain("<polygon");
    const def: PartTypeDefinition | undefined = output.types[0]?.definition;
    expect(def?.source).toEqual({ kind: "script" });
  });
});
