/**
 * @jest-environment node
 *
 * Round 12 lane P12: a kernel with no add-on installed (@mutinybim-bare-kernel)
 * has no pipe fitting families of its own. A stored model full of pipe
 * fittings still opens and keeps every fitting byte for byte; nothing is
 * guessed: the family readers say "no such family", a pipe slot falls to the
 * frozen generic id, and the words name the add-on that's missing.
 *
 * Fails on round 11's code: the kernel resolved every pipe family itself
 * (`fittingFamily("dwv.sanitary_tee")` was a kernel row) and had no
 * `missingFittingFamilyMessage`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyChangeset,
  fittingFamilies,
  fittingFamily,
  missingFittingFamilyMessage,
  resolveFitting,
  systemDefault,
  type Changeset,
  type MepSystem,
  type ModelState,
} from "@permitzip/bim-kernel";

interface StoredFixture {
  readonly changesets: readonly Changeset[];
  readonly head: ModelState;
}

const STORED = path.join(__dirname, "..", "..", "bim-kernel", "__tests__", "fixtures", "stored-changesets");
const fx = JSON.parse(readFileSync(path.join(STORED, "pipe-three-storey-stack.json"), "utf8")) as StoredFixture;

describe("p12-bare-kernel", () => {
  it("has no pipe family and resolves none", () => {
    expect(fittingFamilies().filter((f) => f.domain === "pipe")).toEqual([]);
    expect(fittingFamily("dwv.sanitary_tee")).toBeNull();
    expect(fittingFamily("pipe.water.elbow_90")).toBeNull();
    expect(systemDefault({ systemKind: "sanitary", domain: "pipe" }, "drain_branch_hv")).toEqual({ family: "pipe.elbow" });
  });

  it("opens a stored pipe model and keeps every fitting as stored", () => {
    let m: ModelState = { modelId: fx.head.modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: fx.head.settings };
    for (const cs of fx.changesets) m = applyChangeset(m, cs);
    const fittings = Object.values(m.elements).filter((e) => e.kind === "run_fitting" && e.domain === "pipe");
    expect(fittings.length).toBeGreaterThan(0);
    for (const f of fittings) expect(JSON.stringify(f)).toBe(JSON.stringify(fx.head.elements[f.id]));
    const systems = Object.values(m.elements).filter((e): e is MepSystem => e.kind === "mep_system");
    for (const f of fittings) {
      if (f.kind !== "run_fitting") continue;
      expect(resolveFitting(systems.find((s) => s.id === f.systemId) ?? null, f)).toBeNull();
    }
  });

  it("names the add-on that makes the fitting instead of guessing", () => {
    expect(missingFittingFamilyMessage("dwv.sanitary_tee", { shape: "pipe", nominalMm: 101.6, material: "pvc" })).toBe(
      "This model uses Plumbing and gas, which isn't loaded here, so its dwv.sanitary_tee fitting isn't checked. It is kept as stored",
    );
    expect(missingFittingFamilyMessage("acme.grooved_elbow")).toBe("No add-on here makes the acme.grooved_elbow fitting, so it isn't checked. It is kept as stored");
  });
});
