import { detailComponents, buildViewScene, executeCommand, layoutOneLine, oneLineCommands, oneLineCropCommand, type OneLineSpec } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { ELECTRICAL_COMPONENTS, checkOneLineSpec, oneLineSpecSchema } from "@permitzip/bim-pack-electrical";

/** 480Y/277V service: utility, CT cabinet, switchboard; an ATS with a generator feeding a 480 V panel; a transformer to 208Y/120V feeding another. */
export const SERVICE_480: OneLineSpec = {
  title: "Electrical one-line diagram",
  roots: [
    {
      id: "utility",
      kind: "utility",
      name: "Utility",
      ratings: ["480Y/277V, 3Ø, 4W", "Available fault 42 kA"],
      feeder: { sets: 4, conductors: "4#600 KCMIL CU", conduit: '4" C', length_ft: 40 },
      children: [
        {
          id: "ct",
          kind: "ct_cabinet",
          name: "CT cabinet",
          ratings: ["Utility metering"],
          feeder: { sets: 4, conductors: "4#600 KCMIL CU, 1#4/0 G", conduit: '4" C', length_ft: 15 },
          children: [
            {
              id: "msb",
              kind: "switchboard",
              name: "MSB",
              ratings: ["1600A, 480Y/277V, 3Ø, 4W", "65 kAIC"],
              main: { device: "drawout_breaker", label: "1600A MCB" },
              spd: true,
              ground: true,
              children: [
                {
                  id: "ats1",
                  kind: "ats",
                  name: "ATS-1",
                  ratings: ["400A, 480V, 4P", "Emergency"],
                  feeder: { device: "breaker", device_label: "400AF/400AT 3P", conductors: "4#500 KCMIL CU, 1#3 G", conduit: '3" C', length_ft: 60 },
                  emergency: {
                    id: "gen1",
                    kind: "generator",
                    name: "GEN-1",
                    ratings: ["250 kW, 480Y/277V", "Diesel"],
                    feeder: { device: "breaker", device_label: "400AF/400AT 3P", conductors: "4#500 KCMIL CU, 1#3 G", conduit: '3" C', length_ft: 85 },
                  },
                  children: [
                    {
                      id: "h1",
                      kind: "panelboard",
                      name: "Panel H1",
                      ratings: ["400A, 480Y/277V, 3Ø, 4W", "MLO, 35 kAIC"],
                      feeder: { conductors: "4#500 KCMIL CU, 1#3 G", conduit: '3" C', length_ft: 20 },
                    },
                  ],
                },
                {
                  id: "t1",
                  kind: "transformer",
                  name: "T1",
                  ratings: ["75 kVA", "480Δ - 208Y/120V"],
                  ground: true,
                  feeder: { device: "breaker", device_label: "125AF/110AT 3P", conductors: "3#2 CU, 1#6 G", conduit: '1-1/4" C', length_ft: 30 },
                  children: [
                    {
                      id: "l1",
                      kind: "panelboard",
                      name: "Panel L1",
                      ratings: ["225A, 208Y/120V, 3Ø, 4W", "22 kAIC"],
                      main: { device: "breaker", label: "225A MCB" },
                      feeder: { conductors: "4#4/0 CU, 1#4 G", conduit: '2-1/2" C', length_ft: 10 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  notes: ["Verify available fault current with the utility.", "All conductors copper, THHN/THWN-2."],
};

function boxesOf(layout: ReturnType<typeof layoutOneLine>) {
  return layout.items.flatMap((i) => (i.shape === "text" ? [{ id: i.nodeId, first: i.lines[0]?.text ?? "", min: { x: i.at.x, y: i.at.y - i.lines.length * 4.2 }, max: { x: i.at.x + Math.min(i.widthMm, Math.max(...i.lines.map((l) => l.text.length)) * 1.9), y: i.at.y } }] : []));
}

describe("electrical one-line symbols", () => {
  it("are in the detail component library under electrical", () => {
    const ids = detailComponents().filter((c) => c.category === "electrical").map((c) => c.id);
    expect(ids).toEqual(ELECTRICAL_COMPONENTS.map((c) => c.id));
    expect(ids).toEqual(
      expect.arrayContaining([
        "elec_utility_source", "elec_meter", "elec_ct_cabinet", "elec_breaker", "elec_breaker_drawout", "elec_fuse", "elec_disconnect", "elec_disconnect_fused",
        "elec_contactor", "elec_transformer", "elec_generator", "elec_motor", "elec_ats", "elec_vfd", "elec_ups", "elec_switchboard", "elec_panelboard", "elec_mcc",
        "elec_bus", "elec_busway", "elec_ground", "elec_surge_protector",
      ]),
    );
  });

  it.each(ELECTRICAL_COMPONENTS.map((c) => [c.id, c] as const))("%s stays in its unit box", (_id, c) => {
    for (const p of c.prims) {
      const pts = p.k === "circle" ? [[p.c[0] - p.r, p.c[1]], [p.c[0] + p.r, p.c[1]]] : p.pts;
      for (const [x, y] of pts) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(1 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    for (const [x, y] of Object.values(c.terminals ?? {})) {
      expect([x, y].every((v) => v >= 0 && v <= 1)).toBe(true);
    }
  });
});

describe("one-line layout", () => {
  it("accepts the 480Y/277V service description", () => {
    expect(oneLineSpecSchema.safeParse(SERVICE_480).success).toBe(true);
    expect(checkOneLineSpec(oneLineSpecSchema.parse(SERVICE_480))).toBeNull();
  });

  it("is deterministic", () => {
    expect(layoutOneLine(SERVICE_480)).toEqual(layoutOneLine(SERVICE_480));
  });

  it("draws every piece of equipment, each with its symbol and label", () => {
    const layout = layoutOneLine(SERVICE_480);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(["ats1", "ct", "gen1", "h1", "l1", "msb", "t1", "utility"]);
    const symbols = new Set(layout.items.flatMap((i) => (i.shape === "component" ? [i.symbolId] : [])));
    for (const s of ["elec_utility_source", "elec_ct_cabinet", "elec_breaker_drawout", "elec_breaker", "elec_ats", "elec_generator", "elec_transformer", "elec_surge_protector", "elec_ground"]) expect(symbols).toContain(s);
    const words = layout.items.flatMap((i) => (i.shape === "text" ? i.lines.map((l) => l.text) : []));
    for (const w of ["MSB", "PANEL H1", "PANEL L1", "T1", "GEN-1", "ATS-1", "75 KVA", "480Δ - 208Y/120V", "65 KAIC", "400AF/400AT 3P", "(4) SETS 4#600 KCMIL CU", "L = 60'", "1600A MCB"]) expect(words).toContain(w);
    const heavy = layout.items.filter((i) => i.shape === "line" && i.weight === "heavy");
    expect(heavy).toHaveLength(3);
  });

  it("puts the generator beside the transfer switch and below the switchboard bus", () => {
    const layout = layoutOneLine(SERVICE_480);
    const at = (id: string) => layout.nodes.find((n) => n.id === id);
    const gen = at("gen1");
    const ats = at("ats1");
    const msb = at("msb");
    if (!gen || !ats || !msb) throw new Error("missing nodes");
    expect(gen.center.x).toBeGreaterThan(ats.center.x);
    expect(gen.center.y).toBeLessThan(msb.center.y);
    expect(gen.center.y).toBeGreaterThan(ats.center.y);
  });

  it("keeps equipment labels apart", () => {
    const boxes = boxesOf(layoutOneLine(SERVICE_480));
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        if (a.min.x < b.max.x && b.min.x < a.max.x && a.min.y < b.max.y && b.min.y < a.max.y) overlaps.push(`${a.first} / ${b.first}`);
      }
    expect(overlaps).toEqual([]);
  });

  it("commits as one batch into a drafting view and draws", () => {
    let model = createDemoModel("sld-test");
    const created = executeCommand(model, { type: "create_view", viewId: "view-sld", name: "E-601 One-line", viewType: "detail", props: { scale: 1 } });
    if (!created.ok) throw new Error(created.error.message);
    model = created.model;
    const layout = layoutOneLine(SERVICE_480);
    const commands = [...oneLineCommands("view-sld", layout, "sld"), oneLineCropCommand("view-sld", layout)];
    const batch = executeCommand(model, { type: "batch_documents", label: "One-line", commands });
    if (!batch.ok) throw new Error(batch.error.message);
    expect(batch.changedIds.length).toBe(commands.length);
    const { scene } = buildViewScene(batch.model, "view-sld");
    expect(scene.primitives.length).toBeGreaterThan(150);
    expect((scene.textBlocks ?? []).length).toBe(layout.items.filter((i) => i.shape === "text").length);
  });

  it("refuses what it can't draw, in plain words", () => {
    expect(checkOneLineSpec({ roots: [{ id: "a", kind: "panelboard", name: "A", children: [{ id: "a", kind: "motor", name: "M" }] }] })).toMatch(/same|different/);
    expect(checkOneLineSpec({ roots: [{ id: "m", kind: "motor", name: "M", children: [{ id: "x", kind: "motor", name: "X" }] }] })).toMatch(/load/);
    expect(checkOneLineSpec({ roots: [{ id: "p", kind: "panelboard", name: "P", emergency: { id: "g", kind: "generator", name: "G" } }] })).toMatch(/transfer switch/);
  });
  it("draws a multi-lot meter center (bus, meters, panels) with no sliver line the model refuses (conv cdaf614b)", () => {
    const lots = [141, 142, 143, 144, 145, 146, 147, 148];
    const spec: OneLineSpec = {
      roots: [
        {
          id: "u",
          kind: "utility",
          name: "Utility",
          children: [
            {
              id: "mc",
              kind: "switchboard",
              name: "Meter center",
              main: { device: "breaker", label: "1200A MCB" },
              ground: true,
              children: lots.map((lot) => ({
                id: `m${lot}`,
                kind: "meter" as const,
                name: `Meter ${lot}`,
                feeder: { device: "none" as const },
                children: [{ id: `p${lot}`, kind: "panelboard" as const, name: `Lot ${lot}`, ratings: ["200A, 120/240V, 1Ø, 3W"], feeder: { device: "breaker" as const, device_label: "200A 2P" }, ground: true }],
              })),
            },
          ],
        },
      ],
    };
    expect(checkOneLineSpec(oneLineSpecSchema.parse(spec))).toBeNull();
    const layout = layoutOneLine(spec);
    for (const item of layout.items) {
      if (item.shape !== "line") continue;
      const [a, b] = item.points;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThanOrEqual(0.5);
    }
    const model = createDemoModel("sld-meter-center");
    const r = executeCommand(model, { type: "batch_documents", label: "one-line", commands: [{ type: "create_view", viewId: "v-mc", name: "MC one-line", viewType: "detail", props: { scale: 1 } }, ...oneLineCommands("v-mc", layout, "mc", 2.4)] });
    expect(r.ok ? "saved" : r.error.message).toBe("saved");
  });
});
