/**
 * @jest-environment node
 *
 * Round 12 lane E: an outside add-on (a test fire alarm add-on, not first
 * party) uses every point Electrical moved onto, with zero kernel edits:
 * - its own catalog record type (a loop type) saved, renamed with the devices
 *   naming it following, and refused for delete while used, by the ordinary
 *   catalog commands;
 * - loop lines drawn on a plan through the view graphics point, after the
 *   parts, as part of the printed scene;
 * - a loop riser laid out through the diagram layout point into the kernel's
 *   generic diagram items, put on a drafting view by the kernel's commands;
 * - a "+" grip answer for an unconnected detector (`sourcesFor`).
 *
 * On round 11's code none of these points existed: the catalog refused any
 * record type but its six, plans drew only the kernel's own circuit lines and
 * only the kernel's one-line could be laid out.
 */
import { buildViewScene, catalogEntryRow, commandSchema, diagramLayoutRow, executeCommand, oneLineCommands, sourcesFor, CATALOG_ENTRY_POINT, DIAGRAM_LAYOUT_POINT, NETWORK_ADAPTER_POINT, VIEW_GRAPHICS_POINT, type BimElement, type Command, type ElementId, type OneLineItem, type PartInstance, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, isPackRefusal, withPackSet, type Pack } from "@permitzip/bim-kernel/packs";
import { runPackConformance } from "@permitzip/bim-pack";
import { z } from "zod";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const loopTypeSchema = z.object({ type: z.literal("zzfa.loop_type"), name: z.string().trim().min(1).max(20), devices: z.number().int().min(1).max(250) });

/** Detectors are parts whose mark starts "FA-"; the loop a detector is on is its `loop` value. */
const isDetector = (el: BimElement): el is PartInstance => el.kind === "part" && el.mark.startsWith("FA-");

const FIRE_ALARM: Pack = definePack({ id: "zzfa", name: "Test fire alarm", version: "1.0.0", kernel: "^1.10.0" }, [
  contribute(CATALOG_ENTRY_POINT, [
    {
      type: "zzfa.loop_type",
      idPrefix: "zzfaloop",
      label: "Loop type",
      schema: loopTypeSchema,
      nameOf: (e) => String((e as { name?: unknown }).name ?? ""),
      references: {
        plural: "detectors",
        find: (elements, key) => Object.values(elements).flatMap((el) => (isDetector(el) && String(el.values.loop_type ?? "").toUpperCase() === key ? [{ id: el.id, name: el.mark }] : [])),
        rename: (el, name) => (isDetector(el) ? { element: { ...el, values: { ...el.values, loop_type: name } } } : null),
      },
    },
  ]),
  contribute(VIEW_GRAPHICS_POINT, [
    {
      id: "zzfa.loop_lines",
      label: "Loop lines",
      hintsKey: "zzfaLoops",
      order: 200,
      draw: (ctx) => {
        const detectors = [...ctx.shown.values()].filter(isDetector).sort((a, b) => a.mark.localeCompare(b.mark));
        for (let i = 0; i + 1 < detectors.length; i++) {
          const a = detectors[i] as PartInstance;
          const b = detectors[i + 1] as PartInstance;
          ctx.prims.push({ kind: "line", a: ctx.toPaper(a.position), b: ctx.toPaper(b.position), pen: "thin", dash: [3, 1] });
        }
      },
    },
  ]),
  contribute(DIAGRAM_LAYOUT_POINT, [
    {
      kind: "zzfa.loop_riser",
      label: "Loop riser",
      check: (stored) => (typeof stored === "object" && stored !== null && "loops" in stored ? null : "no loops"),
      layout: (stored) => {
        const loops = typeof stored === "object" && stored !== null && "loops" in stored && Array.isArray(stored.loops) ? stored.loops.map(String) : [];
        if (loops.length === 0) return { refused: "This riser has no loops" };
        const items: OneLineItem[] = loops.flatMap((name, i): OneLineItem[] => [
          { shape: "line", points: [{ x: i * 20, y: 0 }, { x: i * 20, y: -40 }], weight: "medium", nodeId: name },
          { shape: "text", at: { x: i * 20 + 2, y: -2 }, widthMm: 16, lines: [{ text: name, bold: true }], nodeId: name },
        ]);
        return { items, extent: { min: { x: 0, y: -40 }, max: { x: loops.length * 20, y: 0 } }, nodes: loops.map((name, i) => ({ id: name, name, center: { x: i * 20, y: -20 }, depth: 0, kind: "zzfa.loop" })) };
      },
    },
  ]),
  contribute(NETWORK_ADAPTER_POINT, [
    {
      id: "zzfa.loops",
      sourcesFor: (model, end) => {
        const el = model.elements[end.elementId];
        if (!el || !isDetector(el) || el.values.loop) return null;
        return { sourceWord: "loop", prompt: "Needs a source. Drag to a loop", candidates: [{ sourceId: "facp" as ElementId, label: "FACP loop 1", distanceMm: 4000 }], refused: [] };
      },
    },
  ]),
]);

/** A detector with no power connector: nothing Electrical circuits. */
const DETECTOR: PartTypeDefinition = {
  familyName: "Smoke detector",
  typeName: "Photoelectric",
  category: "generic",
  typeParams: [],
  typeValues: {},
  instanceParams: [{ name: "loop_type", label: "Loop type", kind: "text" }],
  connectors: [],
  geometry: [{ kind: "box", center: [0, 0, 50], size: [150, 150, 100] }],
  symbol: [{ kind: "circle", center: [0, 0], radius: 75 }],
  tagFields: ["mark"],
  source: { kind: "builtin", libraryVersion: "test" },
};

function building(): Building {
  const b = new Building();
  const at: ReadonlyArray<readonly [string, number, number]> = [["d1", 0, 0], ["d2", 4000, 0], ["d3", 4000, 3000]];
  at.forEach(([id, x, y], i) => b.ok({ type: "place_part", partId: id, typeId: "type-detector", ...(i === 0 ? { partType: DETECTOR } : {}), levelId: "lvl-1", position: { x, y }, mark: `FA-${i + 1}`, values: {} } as Command));
  b.ok({ type: "create_view", viewId: "v-fa", name: "Level 1 Fire alarm", viewType: "floor_plan", crop: { min: { x: -2000, y: -2000 }, max: { x: 8000, y: 6000 } }, props: { level: "Level 1", scale: 48 } } as Command);
  return b;
}

describe("e12: an outside add-on draws, lays out, catalogs and gets a grip with zero kernel edits", () => {
  const set = PackSet.create([FIRE_ALARM]);

  it("passes the add-on conformance suite", () => {
    expect(runPackConformance(FIRE_ALARM).problems).toEqual([]);
  });

  it("draws its loop lines on the plan after the parts", () => {
    const b = building();
    const without = buildViewScene(b.head, "v-fa").scene.primitives;
    const withLoops = withPackSet(set, () => buildViewScene(b.head, "v-fa").scene.primitives);
    const dashedThin = (ps: typeof without) => ps.filter((p) => p.kind === "line" && p.pen === "thin" && p.dash?.[0] === 3);
    expect(dashedThin(without)).toHaveLength(0);
    expect(dashedThin(withLoops)).toHaveLength(2);
    expect(withLoops.slice(0, without.length)).toEqual(without);
  });

  it("lays out a loop riser into generic diagram items and puts it on a drafting view", () => {
    withPackSet(set, () => {
      const row = diagramLayoutRow("zzfa.loop_riser");
      expect(row?.check({ loops: ["L1"] })).toBeNull();
      const b = building();
      const layout = row?.layout({ loops: ["L1", "L2"] }, { model: b.head });
      if (!layout || isPackRefusal(layout)) throw new Error("expected a layout");
      expect(layout.nodes.map((n) => n.name)).toEqual(["L1", "L2"]);
      expect(row?.layout({ loops: [] }, { model: b.head })).toEqual({ refused: "This riser has no loops" });
      const r = executeCommand(b.head, { type: "batch_documents", label: "loop riser", commands: [{ type: "create_view", viewId: "v-riser", name: "Loop riser", viewType: "detail" }, ...oneLineCommands("v-riser", layout, "fa")] } as Command);
      expect(r.ok ? null : r.error.message).toBeNull();
    });
  });

  it("saves its own record type and renames it with the detectors naming it following", () => {
    withPackSet(set, () => {
      expect(catalogEntryRow("zzfa.loop_type")?.label).toBe("Loop type");
      const b = building();
      let m = b.head;
      // Raw commands as a session sends them, read by the kernel's command check (the add-on's row validates its record).
      const run = (raw: unknown) => {
        const r = executeCommand(m, commandSchema.parse(raw));
        if (!r.ok) throw new Error(r.error.message);
        m = r.model;
      };
      run({ type: "save_catalog_entry", entry: { type: "zzfa.loop_type", name: "SLC-A", devices: 159 } });
      run({ type: "set_parameters", id: "d1", scope: "instance", values: { loop_type: "SLC-A" } });
      expect(m.elements["etype:zzfaloop:SLC-A"]?.kind).toBe("service_catalog");
      const refused = executeCommand(m, { type: "delete_catalog_entry", entryType: "zzfa.loop_type", name: "SLC-A" });
      expect(refused.ok ? null : refused.error.message).toBe("Loop type SLC-A is used by FA-1; change it first");
      run({ type: "save_catalog_entry", entry: { type: "zzfa.loop_type", name: "SLC-B", devices: 159 }, replaces: "SLC-A" });
      const d1 = m.elements.d1;
      expect(d1?.kind === "part" ? d1.values.loop_type : null).toBe("SLC-B");
    });
  });

  it("answers the grip for a detector with no loop", () => {
    const b = building();
    withPackSet(set, () => {
      expect(sourcesFor(b.head, { elementId: "d1" as ElementId })?.prompt).toBe("Needs a source. Drag to a loop");
    });
  });
});
