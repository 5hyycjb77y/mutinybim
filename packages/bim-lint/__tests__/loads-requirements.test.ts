/**
 * @jest-environment node
 *
 * The requirements lint pack: loads typed before they are drawn. A row or a
 * device load that names no source is reported (info); a load whose source was
 * deleted disagrees with the drawing (warning); a 120 V receptacle load named
 * against a 480Y/277 V panel can't be served there (warning). Each has a near
 * miss that stays quiet. On code before the pack none of these rules exist, so
 * every "fires" case below finds nothing and fails.
 */
import { asElementId, type BimElement, type LoadPointElement, type ModelState } from "@permitzip/bim-kernel";
import { rulesFired } from "./fixtures";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

function site(): Building {
  const b = new Building();
  b.place("h1", "panel480", { panel_name: "H1" }, "H1");
  b.place("l1", "panel208", { panel_name: "L1" }, "L1");
  b.ok({ type: "save_connection_type", entry: { designator: "E-REC", loadClass: "receptacle", description: "Receptacles", voltage: 120, poles: 1 } });
  b.ok({ type: "save_connection_type", entry: { designator: "E-WH", loadClass: "other", description: "Water heater", voltage: 480, poles: 3 } });
  return b;
}

const point = (x: number) => ({ kind: "point" as const, levelId: "lvl-1", position: { x, y: 0 } });

function without(model: ModelState, id: string): ModelState {
  const elements: Record<string, BimElement> = { ...model.elements };
  delete elements[id];
  return { ...model, elements };
}

describe("requirements lint pack", () => {
  it("a row with no source is reported; the same row naming its panel is not", () => {
    const b = site();
    b.ok({ type: "create_load", loads: [{ id: "row-1", connectionType: "E-REC", values: { va: 1800 } }, { id: "row-2", connectionType: "E-REC", values: { va: 1800 }, servedBy: "l1" }] });
    const fired = rulesFired(b.head);
    const unserved = fired.get("load-unserved") ?? [];
    expect(unserved).toHaveLength(1);
    expect(unserved[0]).toContain("has no source yet");
    expect(fired.get("load-voltage-mismatch") ?? []).toEqual([]);
  });

  it("a 120 V receptacle named against a 480Y/277 V panel can't be served there; on the 208Y/120 V panel it can", () => {
    const b = site();
    b.ok({ type: "create_load", loads: [{ id: "rec-h", anchor: point(1000), connectionType: "E-REC", values: { va: 180 }, servedBy: "h1" }, { id: "rec-l", anchor: point(2000), connectionType: "E-REC", values: { va: 180 }, servedBy: "l1" }] });
    const fired = rulesFired(b.head);
    const volts = fired.get("load-voltage-mismatch") ?? [];
    expect(volts).toHaveLength(1);
    expect(volts[0]).toMatch(/H1/);
    expect(volts[0]).toMatch(/can't serve it/);
  });

  it("a three-phase 480 V water heater named against the 208Y/120 V panel is refused; against the 480 V panel it is not", () => {
    const b = site();
    b.ok({ type: "create_load", loads: [{ id: "wh-l", anchor: point(3000), connectionType: "E-WH", values: { va: 18000 }, servedBy: "l1" }, { id: "wh-h", anchor: point(4000), connectionType: "E-WH", values: { va: 18000 }, servedBy: "h1" }] });
    const volts = rulesFired(b.head).get("load-voltage-mismatch") ?? [];
    expect(volts).toHaveLength(1);
    expect(volts[0]).toMatch(/L1/);
  });

  it("a load whose source has gone disagrees with the model; one whose source is there does not", () => {
    const b = site();
    b.ok({ type: "create_load", loads: [{ id: "on-h1", anchor: point(1000), connectionType: "E-WH", values: { va: 18000 }, servedBy: "h1" }, { id: "on-l1", anchor: point(2000), connectionType: "E-REC", values: { va: 180 }, servedBy: "l1" }] });
    expect(rulesFired(b.head).get("load-status-mismatch") ?? []).toEqual([]);
    const mismatch = rulesFired(without(b.head, "h1")).get("load-status-mismatch") ?? [];
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]).toContain("is not in the model any more");
  });

  it("a load point written before anchors (host, no anchor, no source) adds no requirement findings, even with its pipe gone", () => {
    const b = site();
    const legacy: LoadPointElement = { id: asElementId("lp:seg-9:end"), kind: "load_point", version: 1, authoredRev: {}, host: { elementId: asElementId("seg-9"), port: "end" }, connectionType: "", values: { dfu: 2 } };
    const model: ModelState = { ...b.head, elements: { ...b.head.elements, [legacy.id]: legacy } };
    const fired = rulesFired(model);
    for (const rule of ["load-unserved", "load-status-mismatch", "load-voltage-mismatch"]) expect(fired.get(rule) ?? []).toEqual([]);
  });
});
