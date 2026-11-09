/**
 * @jest-environment node
 *
 * @mutinybim-bare-kernel: the test setup must not install the first-party
 * add-ons; this file proves what a host without Mechanical does with an old
 * duct model after round 12's move.
 *
 * The round-1 demo (rooftop unit, trunk, taps, branches, diffusers) opens
 * with every stored record kept byte for byte. Moving the unit with Move is
 * refused in words and changes nothing; round 1's `move_equipment` names the
 * add-on ("This model uses Mechanical, which isn't loaded here"). Walls still
 * move: the kernel's own kinds don't need the add-on.
 *
 * A floor plan keeps every record's stored outline, screened, with no
 * label the add-on would print (round 13 K13 step 1.6).
 *
 * Fails on round 11's code: the kernel's `Propagator` moved the unit and its
 * run without the add-on (round 11's `move_elements` had an `equipment` case).
 * The plan case fails on round 12's code: the kernel drew ducts, sizes and
 * diffusers with no add-on (its own kind cases), not screened outlines.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildViewScene, canonicalJson, commandSchema, executeCommand, recomputeDerived, type ModelState } from "../src";
import { installedFirstPartyPacks } from "../src/packs";

const NOT_LOADED = "This model uses Mechanical, which isn't loaded here";
const FIXTURE = path.join(__dirname, "fixtures", "stored-changesets", "r1-demo.json");
const stored = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { readonly head: ModelState }).head;

describe("m12 bare kernel", () => {
  it("has no Mechanical add-on installed", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("mechanical");
  });

  it("opens a round-1 duct model with every stored record kept", () => {
    const opened = recomputeDerived(stored).model;
    for (const [id, el] of Object.entries(stored.elements)) expect([id, canonicalJson(opened.elements[id])]).toEqual([id, canonicalJson(el)]);
    expect(opened.connections).toEqual(stored.connections);
  });

  it("a plan keeps every duct's and the unit's outline, screened, with no add-on label (K13 step 1.6)", () => {
    const made = executeCommand(stored, commandSchema.parse({ type: "create_view", viewId: "k13-plan", name: "Plan", viewType: "floor_plan", props: { level: "L1", scale: 48 } }));
    if (!made.ok) throw new Error(made.error.message);
    const scene = buildViewScene(made.model, "k13-plan").scene;
    const screened = scene.primitives.filter((p) => p.kind === "line" && p.tone === "halftone");
    const ducts = Object.values(stored.elements).filter((el) => el.kind === "duct_segment");
    expect(ducts.length).toBeGreaterThan(0);
    // One centre line per duct; a box (four lines) per unit, terminal, tap and elbow.
    const points = Object.values(stored.elements).filter((el) => el.kind === "equipment" || el.kind === "terminal" || el.kind === "tap" || el.kind === "elbow");
    expect(screened.filter((p) => p.kind === "line" && p.pen === "medium")).toHaveLength(ducts.length);
    expect(screened.filter((p) => p.kind === "line" && p.pen === "thin")).toHaveLength(4 * points.length);
    expect(scene.tags).toEqual([]);
    for (const [id, el] of Object.entries(stored.elements)) expect([id, canonicalJson(made.model.elements[id])]).toEqual([id, canonicalJson(el)]);
  });

  it("refuses to move the unit in words and changes nothing", () => {
    const unit = Object.values(stored.elements).find((el) => el.kind === "equipment");
    if (!unit) throw new Error("the round-1 demo has a unit");
    const moved = executeCommand(stored, { type: "move_elements", ids: [unit.id], delta: { x: 0, y: 300 } });
    expect(moved).toEqual({ ok: false, error: { code: "wrong_kind", message: `equipment ${unit.id} belongs to an add-on that isn't loaded here, so it can't be moved`, elementIds: [unit.id] } });
    const legacy = executeCommand(stored, { type: "move_equipment", equipmentId: unit.id, delta: { x: 0, y: 300 } });
    expect(legacy.ok).toBe(false);
    expect(!legacy.ok && legacy.error.message).toBe(NOT_LOADED);
  });
});
