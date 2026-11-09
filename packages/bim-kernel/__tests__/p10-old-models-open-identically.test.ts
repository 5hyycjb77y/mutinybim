/**
 * @jest-environment node
 *
 * Round 10 lane P10: the pipe catalogue moved into the Plumbing add-on, and
 * every stored model opens with the same pipes, sizes and joints. The
 * `stored-changesets/pipe-*.json` fixtures were written by round 9's kernel
 * (4c169c013) before the move: four routed models (the three-storey stack,
 * the restroom risers, a PE and a steel gas line) with their changesets, a
 * stored model holding a piece of every pipe product with a fitting of every
 * family made in its material (bends once per joint they offer), and round
 * 9's whole catalogue (`pipe-catalogue-r9.json`). Each carries round 9's own
 * readings: dimensions, product words, every fitting's joint check, body,
 * hub rings and mesh, and the model's issues.
 *
 * Fails on round 9's code: `pipeProducts`, `defaultPipeSpec`, `pipeSpecLabel`
 * and `pipeJointLabel` don't exist, and a product row has no `endTypes`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  fittingFamilies,
  SYSTEM_KINDS,
  applyChangeset,
  defaultPipeSpec,
  isPipeMaterial,
  isStoredPipeSpec,
  jointIssue,
  pipeJointLabel,
  pipeParams,
  pipeProducts,
  pipeSpecLabel,
  resolveParams,
  storedJointName,
  type Changeset,
  type ModelState,
  type RunSize,
} from "@permitzip/bim-kernel";
import { BUILTIN_PIPE_TYPES, pipeTypeFittings, pipeTypeMismatch, pipeTypeSummary } from "@permitzip/bim-pack-plumbing";
import { pipeReadings, type PipeReading } from "./fixtures/p10-pipe-readings";

interface Fixture {
  readonly scenario: string;
  readonly round: string;
  readonly changesets: readonly Changeset[];
  readonly head: ModelState;
  readonly expected: { readonly elements: Readonly<Record<string, PipeReading>>; readonly issues: readonly string[] };
}

interface Round9Product {
  readonly id: string;
  readonly material: string;
  readonly name: string;
  readonly standard: string;
  readonly services: readonly string[];
  readonly sizes: readonly unknown[];
  readonly roughnessMm: number;
  readonly hazenWilliamsC: number;
  readonly manningN: number;
  readonly pressureClass: string;
  readonly joints: readonly string[];
  readonly defaultJoint: string;
  readonly note?: string;
}

interface Catalogue {
  readonly products: readonly Round9Product[];
  readonly defaultSpec: Readonly<Record<string, string>>;
  readonly specLabel: Readonly<Record<string, string>>;
  readonly jointLabel: Readonly<Record<string, string>>;
  readonly familyJoints: Readonly<Record<string, { readonly joints?: readonly string[]; readonly param?: unknown }>>;
  readonly defaults: Readonly<Record<string, Readonly<Record<string, string | number>>>>;
  readonly jointChecks: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  readonly types: readonly { readonly name: string; readonly summary: string; readonly mismatch: Readonly<Record<string, string | null>>; readonly fittings: Readonly<Record<string, unknown>> }[];
}

const DIR = path.join(__dirname, "fixtures", "stored-changesets");
const read = <T,>(name: string): T => JSON.parse(readFileSync(path.join(DIR, name), "utf8")) as T;
const FIXTURES: readonly Fixture[] = readdirSync(DIR)
  .filter((f) => f.startsWith("pipe-") && f.endsWith(".json") && f !== "pipe-catalogue-r9.json")
  .sort()
  .map((f) => read<Fixture>(f));
const R9 = read<Catalogue>("pipe-catalogue-r9.json");

describe("p10-old-models-open-identically", () => {
  it("has every round 9 pipe fixture, written by round 9", () => {
    expect(FIXTURES.map((f) => f.scenario)).toEqual(["pipe-every-product", "pipe-gas-pe", "pipe-gas-steel", "pipe-stack-risers", "pipe-three-storey-stack"]);
    expect(FIXTURES.every((f) => f.round === "9")).toBe(true);
    const every = FIXTURES.find((f) => f.scenario === "pipe-every-product");
    expect(Object.values(every?.expected.elements ?? {}).filter((r) => r.joint !== undefined).length).toBeGreaterThan(300);
  });

  it.each(FIXTURES.map((f) => [f.scenario, f] as const))("%s: every pipe and fitting reads as round 9 read it, element by element", (_name, fx) => {
    const now = pipeReadings(fx.head);
    expect(Object.keys(now.elements)).toEqual(Object.keys(fx.expected.elements));
    for (const [id, want] of Object.entries(fx.expected.elements)) expect({ id, ...now.elements[id] }).toEqual({ id, ...want });
    expect(now.issues).toEqual(fx.expected.issues);
  });

  it.each(FIXTURES.filter((f) => f.changesets.length > 1).map((f) => [f.scenario, f] as const))("%s: replaying the stored changesets gives the stored head", (_name, fx) => {
    let m: ModelState = { modelId: fx.head.modelId, revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: fx.head.settings };
    for (const cs of fx.changesets) m = applyChangeset(m, cs);
    expect(pipeReadings(m)).toEqual(fx.expected);
  });

  it("every round 9 product is an add-on row with the same dimensions, values and words, joints by end type", () => {
    const now = pipeProducts();
    expect(now.map((p) => `${p.materialId}:${p.spec}`)).toEqual(R9.products.map((p) => `${p.material}:${p.id}`));
    R9.products.forEach((was, i) => {
      const p = now[i];
      if (!p) throw new Error(`missing ${was.material} ${was.id}`);
      expect({ name: p.name, standard: p.standard, services: p.services, sizes: p.sizes, roughnessMm: p.roughnessMm, hazenWilliamsC: p.hazenWilliamsC, manningN: p.manningN, pressureClass: p.pressureClass, note: p.note }).toEqual({ name: was.name, standard: was.standard, services: was.services, sizes: was.sizes, roughnessMm: was.roughnessMm, hazenWilliamsC: was.hazenWilliamsC, manningN: was.manningN, pressureClass: was.pressureClass, note: was.note });
      expect(p.endTypes.map((e) => storedJointName(e))).toEqual(was.joints);
      expect(storedJointName(p.defaultEndType)).toBe(was.defaultJoint);
      expect(p.id.startsWith("plumbing_gas.")).toBe(true);
    });
    for (const [material, spec] of Object.entries(R9.defaultSpec)) expect(defaultPipeSpec(material)).toBe(spec);
    for (const [spec, label] of Object.entries(R9.specLabel)) expect(pipeSpecLabel(spec)).toBe(label);
    for (const [joint, label] of Object.entries(R9.jointLabel)) expect(pipeJointLabel(joint)).toBe(label);
  });

  it("every family offers the same joints, and on every product picks the same joint and judges every joint the same", () => {
    // Families added since round 9 (new rows; every round 9 row keeps its place and joints).
    const added = new Set(["dwv.sixth_bend", "pipe.water.elbow_22"]);
    const families = fittingFamilies().filter((f) => f.domain === "pipe" && !added.has(f.id));
    expect(families.map((f) => f.id)).toEqual(Object.keys(R9.familyJoints));
    for (const f of families) {
      const was = R9.familyJoints[f.id];
      expect({ id: f.id, joints: f.pipe?.joints, param: f.params.find((p) => p.key === "joint") }).toEqual({ id: f.id, joints: was?.joints, param: was?.param });
    }
    let compared = 0;
    for (const p of pipeProducts()) {
      if (!isPipeMaterial(p.materialId) || !isStoredPipeSpec(p.spec)) throw new Error(`${p.id} isn't a stored built-in product`);
      const size: RunSize = { shape: "pipe", nominalMm: (p.sizes[0]?.nominalIn ?? 1) * 25.4, material: p.materialId, spec: p.spec };
      for (const f of families) {
        const key = `${p.materialId}:${p.spec}:${f.id}`;
        expect({ key, params: resolveParams(f, pipeParams(f, size, undefined)) }).toEqual({ key, params: R9.defaults[key] });
        const checks: Record<string, string | null> = {};
        for (const j of f.pipe?.joints ?? []) checks[j] = jointIssue(f, { joint: j }, size);
        checks["(none)"] = jointIssue(f, {}, size);
        expect({ key, checks }).toEqual({ key, checks: R9.jointChecks[key] });
        compared += 1;
      }
    }
    expect(compared).toBe(Object.keys(R9.defaults).length);
  });

  it("the firm's starting pipe types read the same, except GAS-PE, which round 9 wrongly judged by CPVC's SDR 11", () => {
    for (const was of R9.types) {
      const t = BUILTIN_PIPE_TYPES.find((x) => x.name === was.name);
      if (!t) throw new Error(was.name);
      expect(pipeTypeSummary(t)).toBe(was.summary);
      const mismatch = Object.fromEntries(SYSTEM_KINDS.map((k) => [k, pipeTypeMismatch(t, k)]));
      const expected = was.name === "GAS-PE" ? { ...was.mismatch, natural_gas: null } : was.mismatch;
      expect({ name: t.name, mismatch }).toEqual({ name: t.name, mismatch: expected });
      const fittings = Object.fromEntries(SYSTEM_KINDS.filter((k) => pipeTypeMismatch(t, k) === null && (was.name !== "GAS-PE" || k !== "natural_gas")).map((k) => [k, pipeTypeFittings(t, k)]));
      expect({ name: t.name, fittings: JSON.parse(JSON.stringify(fittings)) as unknown }).toEqual({ name: t.name, fittings: was.fittings });
    }
    // Round 9 found the first product stored as "sdr11" (CPVC, water) for a PE gas type; the product is now found by material and spec.
    expect(R9.types.find((t) => t.name === "GAS-PE")?.mismatch.natural_gas).toBe("SDR 11 is not made for fuel gas");
    const pe = BUILTIN_PIPE_TYPES.find((t) => t.name === "GAS-PE");
    if (!pe) throw new Error("GAS-PE");
    expect(pipeTypeMismatch(pe, "natural_gas")).toBeNull();
    expect(pipeTypeFittings(pe, "natural_gas").map((f) => f.familyId)).toEqual(["pipe.gas.pe_elbow_90", "pipe.gas.pe_elbow_45", "pipe.gas.pe_tee", "pipe.gas.pe_reducer", "pipe.gas.pe_cap"]);
  });
});
