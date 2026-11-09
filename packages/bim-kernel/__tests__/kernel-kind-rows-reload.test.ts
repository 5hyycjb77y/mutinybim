/**
 * @jest-environment node
 *
 * A host can evaluate a module that declares kernel rows a second time while
 * the registry module survives: the dev server did exactly that when the
 * standalone MutinyBIM window compiled, and from then on every Building Model
 * request died with `the kernel already keeps a row for the kind "wall"`
 * (`kinds/rows.ts` re-ran with new row objects; the registry still held the
 * first ones). A declaring module that runs again replaces its own rows; only
 * a different module claiming a kind is refused.
 *
 * Fails on the old code: re-evaluating `kinds/rows.ts` against the surviving
 * registry throws, because any second, different row object for a kind was
 * refused.
 */
import { KERNEL_KIND_ROWS } from "../src/kinds/rows";
import { RECORD_KIND_ROWS } from "../src/kinds/records";
import { LIFECYCLE_KIND_ROWS } from "../src/lifecycle/records";
import { FINDING_DISPOSITION_KIND_ROW } from "../src/findings/record";
import * as registry from "../src/registry/element-kind-point";
import type { ElementKindItem } from "../src/registry/element-kind-point";

const REGISTRY = "../src/registry/element-kind-point";

/** Evaluate `path` again, as a second copy of the module, against the registry this file already loaded. */
function evaluateAgainstSurvivingRegistry<T>(path: string): T {
  let loaded: T | undefined;
  jest.isolateModules(() => {
    jest.doMock(REGISTRY, () => registry);
    loaded = require(path) as T;
  });
  if (loaded === undefined) throw new Error(`${path} did not load`);
  return loaded;
}

function restoreOriginalRows(): void {
  registry.registerKernelKindRows("kernel.kinds", KERNEL_KIND_ROWS);
  registry.registerKernelKindRows("kernel.records", RECORD_KIND_ROWS);
  registry.registerKernelKindRows("kernel.lifecycle", LIFECYCLE_KIND_ROWS);
  registry.registerKernelKindRows("kernel.findings", [FINDING_DISPOSITION_KIND_ROW]);
}

describe("kernel kind rows survive a second evaluation of the modules that declare them", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    restoreOriginalRows();
  });

  it("re-running every declaring module keeps the same kinds and serves the newest rows", () => {
    const kindsBefore = [...registry.kernelKindRowKinds()].sort();
    const errors = jest.spyOn(console, "error");

    const rows = evaluateAgainstSurvivingRegistry<typeof import("../src/kinds/rows")>("../src/kinds/rows");
    expect(rows.KERNEL_KIND_ROWS).not.toBe(KERNEL_KIND_ROWS);
    const wall = rows.KERNEL_KIND_ROWS.find((r) => r.kind === "wall");
    expect(wall).toBeDefined();
    expect(registry.kernelKindRow("wall")).toBe(wall);

    const records = evaluateAgainstSurvivingRegistry<typeof import("../src/kinds/records")>("../src/kinds/records");
    expect(registry.kernelKindRow("submittal")).toBe(records.RECORD_KIND_ROWS[0]);
    const lifecycle = evaluateAgainstSurvivingRegistry<typeof import("../src/lifecycle/records")>("../src/lifecycle/records");
    for (const r of lifecycle.LIFECYCLE_KIND_ROWS) expect(registry.kernelKindRow(r.kind)).toBe(r);
    const findings = evaluateAgainstSurvivingRegistry<typeof import("../src/findings/record")>("../src/findings/record");
    expect(registry.kernelKindRow(findings.FINDING_DISPOSITION_KIND_ROW.kind)).toBe(findings.FINDING_DISPOSITION_KIND_ROW);

    expect(errors).not.toHaveBeenCalled();
    expect([...registry.kernelKindRowKinds()].sort()).toEqual(kindsBefore);
  });

  it("another module claiming a kernel kind is still refused, and nothing it listed is registered", () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const wall = registry.kernelKindRow("wall");
    const intruder: readonly ElementKindItem[] = [
      { kind: "reload_test.extra", label: "Extra", nature: "record" },
      { kind: "wall", label: "Another wall", nature: "physical" },
    ];
    expect(() => registry.registerKernelKindRows("reload_test", intruder)).toThrow('the kernel already keeps a row for the kind "wall"');
    expect(errors).toHaveBeenCalled();
    expect(registry.kernelKindRow("wall")).toBe(wall);
    expect(registry.kernelKindRow("reload_test.extra")).toBeUndefined();
  });

  it("a module that lists a kind twice is refused", () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const twice: readonly ElementKindItem[] = [
      { kind: "reload_test.twice", label: "Twice", nature: "record" },
      { kind: "reload_test.twice", label: "Twice again", nature: "record" },
    ];
    expect(() => registry.registerKernelKindRows("reload_test", twice)).toThrow('lists the kind "reload_test.twice" twice');
    expect(registry.kernelKindRow("reload_test.twice")).toBeUndefined();
  });

  it("a module that runs again without a kind it used to declare drops that kind", () => {
    registry.registerKernelKindRows("reload_test", [
      { kind: "reload_test.kept", label: "Kept", nature: "record" },
      { kind: "reload_test.dropped", label: "Dropped", nature: "record" },
    ]);
    registry.registerKernelKindRows("reload_test", [{ kind: "reload_test.kept", label: "Kept", nature: "record" }]);
    expect(registry.kernelKindRow("reload_test.kept")?.label).toBe("Kept");
    expect(registry.kernelKindRow("reload_test.dropped")).toBeUndefined();
    registry.registerKernelKindRows("reload_test", []);
    expect(registry.kernelKindRow("reload_test.kept")).toBeUndefined();
  });
});
