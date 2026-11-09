/**
 * @jest-environment node
 *
 * Round 11 lane K11: `anchorOf` reads the kind's row (the kernel's own row
 * for a kernel kind, the add-on's row otherwise) and switches on no kind, so
 * a door, a footing or a culvert an add-on registers sits where its row says
 * with no kernel edit.
 *
 * Fails on round 10's code: `anchorOf` was a 45-case switch in model.ts, and
 * no kernel kind had a row (`kernelKindRow("wall")` doesn't exist).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorOf, ELEMENT_KIND_POINT, kindRowOf, type BimElement } from "../src";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";
import { kernelKindRow } from "../src/registry/element-kind-point";

const MODEL_TS = readFileSync(path.join(__dirname, "..", "src", "model.ts"), "utf8");

function bodyOf(source: string, name: string): string {
  const at = source.indexOf(`export function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`${name} has no end`);
}

const base = { version: 1, authoredRev: {} };

const CULVERT_ADDON = definePack({ id: "k11civil", name: "K11 civil", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
  contribute(ELEMENT_KIND_POINT, [
    {
      kind: "k11civil.culvert",
      label: "Culvert",
      nature: "physical",
      shape: { fields: [{ name: "inlet", form: "point" }, { name: "outlet", form: "point" }], points: (el: BimElement) => [Reflect.get(el, "inlet"), Reflect.get(el, "outlet")] },
    },
    { kind: "k11civil.headwall", label: "Headwall", nature: "physical", anchor: (el: BimElement) => ({ x: Number(Reflect.get(el, "station")), y: 0 }) },
    { kind: "k11civil.easement", label: "Easement", nature: "intent" },
  ]),
]);

describe("k11 anchorOf reads the row, never a kind switch", () => {
  it("model.ts has no kind switch: anchorOf asks the row", () => {
    const body = bodyOf(MODEL_TS, "anchorOf");
    expect(body).not.toMatch(/\bswitch\b/);
    expect(body).not.toMatch(/case "/);
    expect(body).toMatch(/kernelRowOf\(el\.kind\)/);
    expect(MODEL_TS).not.toMatch(/case "/);
  });

  it("every kernel kind's place comes from its kernel row", () => {
    const wall = { ...base, id: "W", kind: "wall", start: { x: 0, y: 0 }, end: { x: 4000, y: 0 }, thickness: 200, height: 3000, wallType: "w" } as unknown as BimElement;
    const room = { ...base, id: "R", kind: "room", number: "1", name: "A", outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], areaSqM: 1 } as unknown as BimElement;
    const sheet = { ...base, id: "SH", kind: "sheet", number: "M1", title: "Plan", viewIds: [] } as unknown as BimElement;
    expect(kernelKindRow("wall")?.anchor?.(wall)).toEqual({ x: 2000, y: 0 });
    expect(anchorOf(wall)).toEqual({ x: 2000, y: 0 });
    expect(anchorOf(room)).toEqual({ x: 5, y: 5 });
    expect(kernelKindRow("sheet")?.anchor).toBeUndefined();
    expect(anchorOf(sheet)).toBeNull();
    // A row's anchor answers only for its own kind.
    expect(kernelKindRow("wall")?.anchor?.(room)).toBeNull();
  });

  it("an add-on's kinds sit where their rows say, with no kernel edit; without the add-on they sit nowhere", () => {
    const culvert = { ...base, id: "C1", kind: "k11civil.culvert", inlet: { x: 0, y: 0 }, outlet: { x: 10000, y: 2000 } } as unknown as BimElement;
    const headwall = { ...base, id: "H1", kind: "k11civil.headwall", station: 2500 } as unknown as BimElement;
    const easement = { ...base, id: "E1", kind: "k11civil.easement", values: { "k11civil.width_m": 6 } } as unknown as BimElement;
    withPackSet(PackSet.create([CULVERT_ADDON]), () => {
      expect(kindRowOf("k11civil.culvert")?.label).toBe("Culvert");
      expect(anchorOf(culvert)).toEqual({ x: 5000, y: 1000 });
      expect(anchorOf(headwall)).toEqual({ x: 2500, y: 0 });
      expect(anchorOf(easement)).toBeNull();
    });
    expect(kindRowOf("k11civil.culvert")).toBeUndefined();
    expect(anchorOf(culvert)).toBeNull();
    expect(anchorOf(headwall)).toBeNull();
  });
});
