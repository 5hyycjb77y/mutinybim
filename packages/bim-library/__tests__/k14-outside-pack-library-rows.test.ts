/**
 * @jest-environment node
 *
 * Round 14 lane K14 step 2 (guardrail 1): an add-on that isn't first-party
 * puts a class and a field into the built-in library through
 * `kernel.library_rows` with zero kernel or library edits. Its rows pass
 * conformance, load after the kernel's own, read in the field registry and
 * disappear with the add-on.
 *
 * Fails on round 13's code: the built-in bundle never read add-on rows
 * (`builtinLibraryBundle()` didn't exist).
 */
import { LIBRARY_ROWS_POINT, type LibraryRow } from "@permitzip/bim-kernel";
import { contribute, definePack, PACK_CONTRACT_VERSION, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { runPackConformance } from "@permitzip/bim-pack";
import { FileLibraryProvider, builtinLibraryBundle, builtinLibrarySource, loadBundle } from "../src";
import { bimFormulaEngine, bimUnitsCatalog } from "../src/bim-formula";

const env = { formula: bimFormulaEngine, units: bimUnitsCatalog };

const ROWS: readonly LibraryRow[] = [
  { section: "classes", item: { id: "zz:class:zz.widget", revision: 1, key: "zz.widget", label: "Widgets", discipline: "general_contracting", description: "A test add-on's own class." } },
  { section: "fields", item: { id: "zz:field:zz.widget.rating", revision: 1, key: "zz.rating", label: "Widget rating", appliesTo: ["zz.widget"], valueType: "text", group: "Identity", editable: true, storage: { kind: "parameter", scope: "instance", name: "zz_rating" } } },
];

const ZZ = definePack({ id: "zz", name: "ZZ widgets", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(LIBRARY_ROWS_POINT, ROWS)]);

describe("k14 outside add-on library rows", () => {
  it("pass conformance as an ordinary add-on", () => {
    expect(runPackConformance(ZZ).problems).toEqual([]);
  });

  it("load into the built-in library after the kernel's rows, and read in the registry", async () => {
    const { bundle, source } = withPackSet(PackSet.create([ZZ]), () => ({ bundle: builtinLibraryBundle(), source: builtinLibrarySource() }));
    const loaded = loadBundle(bundle, env);
    if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join("\n"));
    expect(loaded.registry.getClass("zz.widget")?.label).toBe("Widgets");
    expect(loaded.registry.field("zz.widget", "zz.rating")?.label).toBe("Widget rating");
    const p = new FileLibraryProvider({ env, sources: [source] });
    const classes = (await p.list("builtin", { type: "class" })).map((c) => c.id);
    expect(classes[classes.length - 1]).toBe("zz:class:zz.widget");
  });

  it("a row that isn't a library item is left out and logged; the rest of the library still loads", () => {
    const bad = definePack({ id: "yy", name: "YY", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(LIBRARY_ROWS_POINT, [{ section: "fields", item: { id: "yy:field:broken", label: "No key or class" } }])]);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const bundle = withPackSet(PackSet.create([bad, ZZ]), () => builtinLibraryBundle());
      const ids = (bundle.fields ?? []).flatMap((f) => (typeof f === "object" && f !== null && "id" in f ? [f.id] : []));
      expect(ids).toContain("zz:field:zz.widget.rating");
      expect(ids).not.toContain("yy:field:broken");
      expect(loadBundle(bundle, env).ok).toBe(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("left out of the built-in library"), expect.objectContaining({ addOn: "yy", id: "yy:field:broken" }));
    } finally {
      error.mockRestore();
    }
  });

  it("are absent with the add-on off", () => {
    const loaded = loadBundle(builtinLibraryBundle(), env);
    if (!loaded.ok) throw new Error(loaded.problems.map((p) => p.message).join("\n"));
    expect(loaded.registry.getClass("zz.widget")).toBeUndefined();
  });
});
