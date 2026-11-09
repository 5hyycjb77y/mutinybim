/**
 * @jest-environment node
 *
 * Building pressurization on the cross-trade balance primitive (ROADMAP F9 /
 * M1, KERNEL-REQUIREMENTS-MODEL §3.10). Before this change the kernel had only
 * an untyped two-number `balance` inside drainage: there was no
 * `src/balance` module, no `balanceOf`, no pressurization read, no
 * makeup-air load, and a field block could not name a table, so every test
 * here fails on the old tree (the imports below don't exist, and
 * `renderFieldBlock` with `table` printed the caption only).
 *
 * @mutinybim-bare-kernel: these cases read the kernel with no pressure
 * targets or outdoor-air engine loaded unless a case brings its own set
 * (`withTargets`), as before round 6.
 * Since round 6 Mechanical's rows are installed without its engine and
 * targets (`installMechanicalRowsOnly`), as the bare kernel read them before.
 */
import { to, qty, type Quantity } from "@permitzip/bim-units";
import {
  balance as drainageBalance,
  coversDemand as drainageCoversDemand,
} from "@permitzip/bim-kernel";
import {
  asElementId,
  balance,
  balanceOf,
  VENTILATION_NOT_LOADED,
  blockHashInput,
  fieldBlockSpecSchema,
  fieldProviderRegistry,
  renderFieldBlock,
  type DrawingItem,
  type PartInstance,
} from "@permitzip/bim-kernel";
import {
  makeupAirHeat,
  makeupLoadOnUnit,
  pressurizationClassifyCount,
  pressurizationOf,
} from "../src";
import { sampleGrill, restaurantTargets, withTargets } from "../../bim-kernel/__tests__/m1-fixtures";
import { installMechanicalRowsOnly } from "./mechanical-rows";

installMechanicalRowsOnly();

const cfm = (v: Quantity<"flow_air"> | null | undefined) => (v === null || v === undefined ? null : Math.round(to(v, "cfm") * 1000) / 1000);


describe("balance: one cross-trade primitive", () => {
  it("drainage keeps reading the same functions it always did (re-exported, not copied)", () => {
    expect(drainageBalance).toBe(balance);
    expect(drainageBalance(100, 95, { percent: 10 })).toMatchObject({ verdict: "balanced", difference: 5 });
    expect(drainageCoversDemand(52, 50, { absolute: 1 })).toMatchObject({ ok: false, spare: -2 });
  });

  it("sums typed contributors with signs and an absolute floor beside the percentage", () => {
    const b = balanceOf(
      "flow_air",
      [
        { id: "a", label: "MUA-1", side: "in", role: "makeup_air", value: qty("flow_air", 2400, "cfm") },
        { id: "b", label: "KEF-1", side: "out", role: "exhaust", value: qty("flow_air", 3000, "cfm") },
        { id: "c", label: "RTU-1", side: "in", role: "outdoor_air", value: qty("flow_air", 620, "cfm") },
      ],
      { absolute: qty("flow_air", 25, "cfm") },
    );
    if (b.status !== "complete") throw new Error("incomplete");
    expect(cfm(b.inflow)).toBe(3020);
    expect(cfm(b.outflow)).toBe(3000);
    expect(cfm(b.net)).toBe(20);
    expect(b.verdict).toBe("balanced");
  });

  it("never gives a partial total: a missing input makes it incomplete and names which", () => {
    const b = balanceOf("flow_air", [
      { id: "a", label: "MUA-1", side: "in", role: "makeup_air", value: qty("flow_air", 2400, "cfm") },
      { id: "b", label: "KEF-1", side: "out", role: "exhaust", value: null, missing: "KEF-1 has no exhaust airflow (exhaust_cfm). Type it in Properties." },
    ]);
    expect(b.status).toBe("incomplete");
    expect(b).not.toHaveProperty("net");
    expect(b.status === "incomplete" ? b.missing : []).toEqual([{ id: "b", label: "KEF-1", reason: "KEF-1 has no exhaust airflow (exhaust_cfm). Type it in Properties." }]);
  });
});

describe("7303 pressurization from the model", () => {
  it("KEF-1 −3,000, MUA-1 +2,400, RTU-1 +320, RTU-2 +380: the building is +100 cfm, slightly positive as targeted", () => {
    const m = sampleGrill().head;
    const r = pressurizationOf(m.elements);
    const signed = r.contributors.map((c) => [c.label, c.role, c.side === "out" ? -(cfm(c.value) ?? 0) : cfm(c.value)]);
    expect(signed).toEqual([
      ["KEF-1", "exhaust", -3000],
      ["MUA-1", "makeup_air", 2400],
      ["RTU-1", "outdoor_air", 320],
      ["RTU-2", "outdoor_air", 380],
    ]);
    const b = r.building;
    if (b.balance.status !== "complete" || !b.subtotals) throw new Error("incomplete");
    expect(cfm(b.subtotals.exhaust)).toBe(3000);
    expect(cfm(b.subtotals.makeupAir)).toBe(2400);
    expect(cfm(b.subtotals.outdoorAir)).toBe(700);
    expect(cfm(b.balance.net)).toBe(100);
    expect(b.state).toBe("positive");
    expect(b.meetsTarget).toBe(true);
    expect(b.text).toBe("net +100 cfm: positive (target positive, met)");
  });

  it("per zone: the kitchen draws 220 cfm from the dining room (negative, as kitchens should be), the dining room is +320", () =>
    withTargets(restaurantTargets, () => {
      const r = pressurizationOf(sampleGrill().head.elements);
      const kitchen = r.zones.find((z) => z.name === "Zone 2 Kitchen");
      const dining = r.zones.find((z) => z.name === "Zone 1 Dining");
      expect(kitchen?.balance.status === "complete" ? cfm(kitchen.balance.net) : null).toBe(-220);
      expect(kitchen?.state).toBe("negative");
      expect(kitchen?.target?.target).toBe("negative");
      expect(kitchen?.meetsTarget).toBe(true);
      expect(kitchen?.text).toBe("net −220 cfm: negative (target negative, met)");
      expect(dining?.balance.status === "complete" ? cfm(dining.balance.net) : null).toBe(320);
      expect(dining?.meetsTarget).toBe(true);
      expect(r.contributors.find((c) => c.label === "KEF-1")?.zoneBasis).toBe("named");
      expect(r.contributors.find((c) => c.label === "RTU-2")?.zoneBasis).toBe("serves");
    }));

  it("without MUA-1 the building is −2,300 cfm: negative against its slightly positive target", () =>
    withTargets(restaurantTargets, () => {
      const r = pressurizationOf(sampleGrill({ withMua: false }).head.elements);
      expect(r.building.balance.status === "complete" ? cfm(r.building.balance.net) : null).toBe(-2300);
      expect(r.building.meetsTarget).toBe(false);
      expect(r.building.text).toBe("net −2,300 cfm: negative (target positive, NOT met)");
    }));

  it("an exhaust fan with no airflow typed: no net for its zone or the building, and it says which", () => {
    const r = pressurizationOf(sampleGrill({ kefCfm: null }).head.elements);
    expect(r.building.balance.status).toBe("incomplete");
    expect(r.building.subtotals).toBeNull();
    expect(r.building.text).toBe("No net yet: KEF-1 has no exhaust airflow (exhaust_cfm). Type it in Properties.");
    expect(r.zones.find((z) => z.name === "Zone 2 Kitchen")?.balance.status).toBe("incomplete");
    expect(r.zones.find((z) => z.name === "Zone 1 Dining")?.balance.status).toBe("complete");
  });

  it("untempered MUA-1: 2,400 × 1.08 × (92 − 80) = 31,104 Btu/h heating, carried by RTU-2 (the kitchen's unit)", () => {
    const r = pressurizationOf(sampleGrill().head.elements);
    const line = r.heat.find((h) => h.mark === "MUA-1");
    expect(line?.heat?.arithmetic).toBe("2,400 × 1.08 × (92 − 80) = 31,104 Btu/h");
    expect(line?.heat?.direction).toBe("heating");
    expect(line?.servingUnits.map((u) => u.mark)).toEqual(["RTU-2"]);
    const load = makeupLoadOnUnit(r, asElementId("rtu2"));
    expect(load ? Math.round(to(load.load, "Btu/h")) : null).toBe(31104);
    expect(makeupLoadOnUnit(r, asElementId("rtu1"))).toBeNull();
    expect(Math.round(to(makeupAirHeat({ airflow: qty("flow_air", 2400, "cfm"), from: qty("temperature", 80, "degF"), to: qty("temperature", 92, "degF") }).load, "Btu/h"))).toBe(31104);
  });

  it("is kept per part: editing KEF-1 re-reads one part, not every part", () => {
    const b = sampleGrill();
    pressurizationOf(b.head.elements);
    const before = pressurizationClassifyCount();
    b.ok({ type: "set_parameters", id: "kef1", scope: "instance", values: { exhaust_cfm: 2800 } });
    const r = pressurizationOf(b.head.elements);
    expect(pressurizationClassifyCount() - before).toBe(1);
    expect(r.building.balance.status === "complete" ? cfm(r.building.balance.net) : null).toBe(300);
    expect((b.el("kef1") as PartInstance).values.exhaust_cfm).toBe(2800);
  });

  it("zone and equipment fields read the same balance (schedules and tags)", () =>
    withTargets(restaurantTargets, () => {
      const m = sampleGrill().head;
      const reg = fieldProviderRegistry();
      const zone = m.elements["z-kitchen"];
      const rtu2 = m.elements["rtu2"];
      if (!zone || !rtu2) throw new Error("fixture");
      expect(reg.field("gen.zone", "pressurization.net_cfm")?.read?.(zone, { elements: m.elements })).toBe(-220);
      expect(reg.field("gen.zone", "pressurization.state")?.read?.(zone, { elements: m.elements })).toBe("negative");
      expect(reg.field("mep.mechanical_equipment", "pressurization.makeup_load_btuh")?.read?.(rtu2, { elements: m.elements })).toBe(31104);
      expect(reg.field("mep.mechanical_equipment", "own.outdoor_cfm")?.read?.(rtu2, { elements: m.elements })).toBe(380);
    }));
});

describe("table blocks: pressurization and ventilation on sheets", () => {
  const TABLE = { template: "Pressurization", title: "BUILDING PRESSURIZATION", table: { kind: "pressurization" as const, scope: { kind: "model" as const } } };

  it("renders the live pressurization table through the ordinary field block", () => {
    const m = sampleGrill().head;
    const r = renderFieldBlock(m, TABLE);
    expect(r.text.split("\n")).toEqual([
      "Item | Air | Zone | cfm (+ in, − out)",
      "KEF-1 | Exhaust | Zone 2 Kitchen | −3,000",
      "MUA-1 | Makeup air | Zone 2 Kitchen | +2,400",
      "RTU-1 | Outdoor air | Zone 1 Dining | +320",
      "RTU-2 | Outdoor air | Zone 2 Kitchen | +380",
      "Zone 1 Dining: exhaust 0, makeup 0, outdoor air 320; net +320 cfm: positive",
      "Zone 2 Kitchen: exhaust 3,000, makeup 2,400, outdoor air 380; net −220 cfm: negative",
      "Building: exhaust 3,000, makeup 2,400, outdoor air 700; net +100 cfm: positive (target positive, met)",
      "MUA-1 untempered makeup air: 2,400 × 1.08 × (92 − 80) = 31,104 Btu/h heating, added to RTU-2",
      expect.stringMatching(/^Makeup air load: Q = 1\.08 × cfm × ΔT/),
    ]);
    expect(r.unresolved).toEqual([]);
    expect(r.dependsOn).toEqual(expect.arrayContaining(["kef1", "mua1", "rtu1", "rtu2", "z-kitchen", "z-dining", "type-kef"]));
    expect(renderFieldBlock(m, TABLE)).toEqual(r);
  });

  it("a block without a table renders and hashes exactly as before (the schema adds no key)", () => {
    const spec = fieldBlockSpecSchema.parse({ template: "Kitchen {name}", subjectId: "z-kitchen" });
    expect(Object.keys(spec).sort()).toEqual(["subjectId", "template"]);
    const r = renderFieldBlock(sampleGrill().head, spec);
    expect(blockHashInput(r)).toBe('{"pins":{},"text":"Kitchen Zone 2 Kitchen","unresolved":[],"v":1}');
  });

  it("add_field_block places a table, edit keeps it, a zone scope that doesn't exist is refused, freezing works on its text", () => {
    const b = sampleGrill();
    b.ok({ type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Mechanical plan" });
    b.ok({ type: "add_field_block", itemId: "blk-p", sheetId: "s-m101", at: { x: 40, y: 60 }, block: TABLE });
    const item = b.el("blk-p") as DrawingItem;
    expect(item.block?.table).toEqual({ kind: "pressurization", scope: { kind: "model" } });
    b.ok({ type: "edit_field_block", itemId: "blk-p", title: "PRESSURIZATION TABLE" });
    expect((b.el("blk-p") as DrawingItem).block?.table?.kind).toBe("pressurization");
    b.ok({ type: "edit_field_block", itemId: "blk-p", table: { kind: "pressurization", scope: { kind: "zone", zoneId: "z-kitchen" } } });
    const zoneText = renderFieldBlock(b.head, (b.el("blk-p") as DrawingItem).block ?? TABLE).text;
    expect(zoneText).toContain("Zone 2 Kitchen: exhaust 3,000");
    expect(zoneText).not.toContain("RTU-1");
    expect(zoneText).not.toContain("Building:");
    expect(b.refused({ type: "add_field_block", itemId: "blk-q", sheetId: "s-m101", at: { x: 40, y: 160 }, block: { ...TABLE, table: { kind: "pressurization", scope: { kind: "zone", zoneId: "z-gone" } } } })).toBe("The zone this table lists no longer exists. Pick another, or list the whole model.");
    const live = renderFieldBlock(b.head, (b.el("blk-p") as DrawingItem).block ?? TABLE);
    b.ok({ type: "set_parameters", id: "kef1", scope: "instance", values: { exhaust_cfm: 2800 } });
    const after = renderFieldBlock(b.head, (b.el("blk-p") as DrawingItem).block ?? TABLE);
    expect(blockHashInput(after)).not.toBe(blockHashInput(live));
  });

  it("a ventilation table names its kind (r2-ventilation §4); with no pack loaded it says so instead of printing zeros", () => {
    const m = sampleGrill().head;
    const r = renderFieldBlock(m, { template: "Ventilation", table: { kind: "ventilation", scope: { kind: "model" } } });
    expect(r.text).toBe(VENTILATION_NOT_LOADED);
    expect(r.unresolved).toEqual(["ventilation"]);
  });
});
