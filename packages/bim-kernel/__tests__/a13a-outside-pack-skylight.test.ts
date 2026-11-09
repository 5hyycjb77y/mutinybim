/**
 * @jest-environment node
 *
 * Round 13 lane A13a: an outside add-on's skylight voids the Architecture
 * add-on's roof, with zero kernel edits. The test add-on `zz` registers a
 * `zz.skylight` kind (drawn at a point, naming its roof) and a host void row
 * for it on `architecture.roof`. The roof lists the void, its plan draws the
 * opening and its body is left in blocks round it.
 *
 * Fails on round 12's code: no roof kind, no host voids, no create face.
 */
import { asElementId, ELEMENT_KIND_POINT, type BimElement, type ElementId, type Vec2 } from "../src";
import { contribute, definePack, PackSet, withPackSet } from "../src/packs";
import { elementSolid } from "../src/drawing/solids";
import { planGraphicsContext, planGraphicsOf } from "../src/drawing/plan-graphics";
import { HOST_VOID_POINT, voidsOf } from "../src/hosting/void-point";
import { roofBlocks } from "@permitzip/bim-pack-architecture";
import { element, twoLevels } from "./a13a-fixtures";

interface Skylight {
  readonly id: ElementId;
  readonly kind: "zz.skylight";
  readonly hostId: string;
  readonly position: Vec2;
  readonly size: Vec2;
}

function skylight(el: BimElement): Skylight | null {
  const kind: string = el.kind;
  return kind === "zz.skylight" ? (el as unknown as Skylight) : null;
}

const PACK = definePack({ id: "zz", name: "ZZ skylights", version: "1.0.0", kernel: "^1.11.0" }, [
  contribute(ELEMENT_KIND_POINT, [
    {
      kind: "zz.skylight",
      label: "Skylight",
      nature: "physical",
      create: {
        placements: ["point"],
        make: (input) => {
          if (input.placement.kind !== "point") return { refused: "A skylight is placed at a point" };
          const host = input.values?.["zz.roof"];
          if (typeof host !== "string") return { refused: "A skylight sits in a roof; name the roof" };
          const rec: Skylight = { id: asElementId(input.id), kind: "zz.skylight", hostId: host, position: input.placement.position, size: { x: input.size?.widthMm ?? 1200, y: input.size?.depthMm ?? 1200 } };
          return { ...rec, version: 0, authoredRev: {} } as unknown as BimElement;
        },
      },
    },
  ]),
  contribute(HOST_VOID_POINT, [
    {
      kind: "zz.skylight",
      label: "Skylight",
      hostKinds: ["architecture.roof"],
      voidOf: (el, host) => {
        const s = skylight(el);
        const hostKind: string = host.kind;
        if (!s || hostKind !== "architecture.roof") return null;
        const { x, y } = s.position;
        const hx = s.size.x / 2;
        const hy = s.size.y / 2;
        return { elementId: s.id, hostId: host.id, role: "fill", profile: [{ x: x - hx, y: y - hy }, { x: x + hx, y: y - hy }, { x: x + hx, y: y + hy }, { x: x - hx, y: y + hy }] };
      },
    },
  ]),
]);

const RECT = [
  { x: 0, y: 0 },
  { x: 10_000, y: 0 },
  { x: 10_000, y: 8000 },
  { x: 0, y: 8000 },
];

describe("a13a outside pack skylight", () => {
  it("a test add-on's skylight voids the roof: listed, drawn in plan, cut from its body", () => {
    withPackSet(PackSet.create([PACK]), () => {
      const m = twoLevels();
      m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: RECT } });
      m.ok({ type: "create_element", elementId: "sk", kind: "zz.skylight", levelId: "L2", values: { "zz.roof": "r" }, placement: { kind: "point", position: { x: 5000, y: 4000 } } });
      const voids = voidsOf(m.head, asElementId("r"));
      expect(Array.isArray(voids) && voids.map((v) => [v.elementId, v.role])).toEqual([["sk", "fill"]]);
      const plan = planGraphicsOf(element(m.head, "r"), planGraphicsContext(m.head, { scale: 100, levelId: "L2", detail: "medium", drawing: "view" })) ?? [];
      expect(plan.filter((g) => g.form === "polyline")).toHaveLength(2);
      // Left strip, below and above the skylight, right strip.
      expect(elementSolid(m.head, element(m.head, "r"), 0)?.pieces).toHaveLength(4);
      expect(m.refused({ type: "create_element", elementId: "sk2", kind: "zz.skylight", levelId: "L2", placement: { kind: "point", position: { x: 1, y: 1 } } })).toBe("A skylight sits in a roof; name the roof");
    });
  });

  it("the roof's blocks tile its footprint less the void", () => {
    const blocks = roofBlocks(RECT, [[{ x: 4400, y: 3400 }, { x: 5600, y: 3400 }, { x: 5600, y: 4600 }, { x: 4400, y: 4600 }]]);
    const area = (p: readonly Vec2[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length] as Vec2; return s + a.x * b.y - b.x * a.y; }, 0) / 2);
    expect(blocks.reduce((s, b) => s + area(b), 0)).toBeCloseTo(80_000_000 - 1_440_000, 3);
  });
});
