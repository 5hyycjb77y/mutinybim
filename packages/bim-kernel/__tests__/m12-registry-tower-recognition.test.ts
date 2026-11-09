/**
 * @jest-environment node
 *
 * Class recognition on the tower-14 synthetic in one pass over the model,
 * cached per revision. Moved unchanged from `src/registry/__tests__/registry.test.ts`
 * in round 12 (lane M12): the load-test building is `@permitzip/bim-first-party`'s
 * now, and a test beside the registry may not import an add-on.
 */
import { createFullBimModel, describeModel } from "@permitzip/bim-first-party/seed";
import { builtinRegistry, buildClassIndex } from "../src/registry";

describe("class recognition", () => {
  it("recognizes the tower-14 synthetic in one pass over the model, cached per revision", () => {
    // tower-14: fixtures/mutinybim/profiles/tower-14.json → authoredOptions(profile).
    const model = createFullBimModel({ floors: 14, zonesPerFloor: 2, modelId: "synthetic-tower-14" });
    const { byKind, total } = describeModel(model);
    expect(total).toBeGreaterThan(100_000);
    const registry = builtinRegistry();
    // Committing carries a class index onto each record, so a fresh copy of the record is the cold case.
    // A pass over the model lists the record's elements once; the proxy counts those listings.
    let passes = 0;
    const cold = {
      elements: new Proxy(
        { ...model.elements },
        {
          ownKeys: (target) => {
            passes += 1;
            return Reflect.ownKeys(target);
          },
        },
      ),
    };
    const t0 = performance.now();
    const index = buildClassIndex(registry, cold);
    const ms = performance.now() - t0;
    expect(passes).toBe(1);
    expect(buildClassIndex(registry, cold)).toBe(index);
    expect(passes).toBe(1);
    console.log(`[registry] tower-14 class index: ${total} elements in ${ms.toFixed(1)} ms`);

    expect(index.elementsOf("arch.wall")).toHaveLength(byKind.wall ?? 0);
    expect(index.elementsOf("struct.beam")).toHaveLength(byKind.beam ?? 0);
    expect(index.elementsOf("arch.room")).toHaveLength(byKind.room ?? 0);
    expect(index.elementsOf("gen.level")).toHaveLength(byKind.level ?? 0);
    const doors = index.elementsOf("arch.door");
    const windows = index.elementsOf("arch.window");
    expect(doors.length + windows.length).toBe(byKind.opening ?? 0);
    expect(doors.every((d) => d.kind === "opening" && d.openingType === "door")).toBe(true);
    // A parent lists its subclasses' instances, each once, in model order.
    const equipment = index.elementsOf("mep.equipment");
    expect(equipment.length).toBe(index.elementsOf("mep.mechanical_equipment").length + index.elementsOf("mep.electrical_equipment").length);
    expect(index.elementsOf("mep.equipment", { includeSubclasses: false })).toHaveLength(0);
    const first = doors[0];
    if (first) expect(index.classesOf(first.id)).toEqual(["arch.door"]);
  });
});
