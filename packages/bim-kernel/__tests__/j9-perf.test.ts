/**
 * @jest-environment node
 *
 * Round 9 lane J9: what connector integrity costs. Each case prints
 * `[j9 <row>] p50 … p95 …`; an internal design note records
 * the runs. Ceilings here are coarse so a loaded laptop doesn't fail them;
 * the budgets are the gate's.
 *
 * - `connections.integrity.full`: every finding on the full-BIM model of
 *   the tier, beside `validate.full` (`validateModel`) on the same model.
 * - `connections.integrity.edit`: the findings of 50 changed parts, each
 *   open end looking for others through a spatial index (what the lint grid
 *   does on an edit), on a chain of joined pieces as large as the tier.
 * - `parts.import_report.one_type`: the report for one part type.
 *
 * J9_PERF=1 runs it; J9_PERF_TIER picks the tier (250k by default).
 */
import {
  DEFAULT_SETTINGS,
  asElementId,
  builtinPartType,
  elementIntegrityIssues,
  freezeElements,
  integrityPortsOf,
  modelIntegrityIssues,
  partTypeImportReport,
  validateModel,
  type BimElement,
  type ElementId,
  type ModelState,
  type PartInstance,
  type RunPoint,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { straightPiece } from "./fixtures/j9-pieces";

type Tier = keyof typeof FULL_BIM_TIERS;
const isTier = (value: string): value is Tier => value in FULL_BIM_TIERS;

function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}

function time(n: number, fn: () => void): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t0 = performance.now();
    fn();
    if (i > 0) out.push(performance.now() - t0);
  }
  return out;
}

function report(row: string, samples: readonly number[], extra = ""): void {
  const s = p50p95(samples);
  process.stderr.write(`[j9 ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})${extra ? `; ${extra}` : ""}\n`);
}

/** `count` pieces in rows of 1000, each joined to the next; every 97th joint left open (touching, not joined). */
function chain(count: number): ModelState {
  const elements: Record<string, BimElement> = {};
  elements["lvl-1"] = { id: asElementId("lvl-1"), version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as BimElement;
  elements["j9-t"] = { id: asElementId("j9-t"), version: 1, authoredRev: {}, kind: "part_type", definition: straightPiece("Piece", { endType: "mechanical.slip" }) } as BimElement;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 1000);
    const col = i % 1000;
    const links: Record<string, { elementId: ElementId; port: string }> = {};
    const open = (c: number) => c % 97 === 0;
    if (col > 0 && !open(col)) links.a = { elementId: asElementId(`p${i - 1}`), port: "b" };
    if (col < 999 && i + 1 < count && !open(col + 1)) links.b = { elementId: asElementId(`p${i + 1}`), port: "a" };
    const part: PartInstance = {
      id: asElementId(`p${i}`),
      version: 1,
      authoredRev: {},
      kind: "part",
      typeId: asElementId("j9-t"),
      levelId: asElementId("lvl-1"),
      position: { x: col * 300, y: row * 2000 },
      offsetMm: 1000,
      rotationDeg: 0,
      mark: `P-${i}`,
      values: {},
      ...(Object.keys(links).length > 0 ? { links } : {}),
    };
    elements[part.id] = part;
  }
  return { modelId: "j9-chain", revision: 1 as ModelState["revision"], elements: freezeElements(elements), connections: [], settings: DEFAULT_SETTINGS };
}

/** A hash of every element by the cells its ends fall in: the stand-in for the lint grid's "bodies near". */
function endIndex(elements: Readonly<Record<string, BimElement>>): (at: RunPoint, radius: number) => ElementId[] {
  const cell = 50;
  const byCell = new Map<string, ElementId[]>();
  for (const el of Object.values(elements)) {
    for (const p of integrityPortsOf(elements, el)) {
      const key = `${Math.floor(p.absolute.x / cell)},${Math.floor(p.absolute.y / cell)},${Math.floor(p.absolute.z / cell)}`;
      const list = byCell.get(key) ?? [];
      list.push(el.id);
      byCell.set(key, list);
    }
  }
  return (at, radius) => {
    const out = new Set<ElementId>();
    for (let x = Math.floor((at.x - radius) / cell); x <= Math.floor((at.x + radius) / cell); x++)
      for (let y = Math.floor((at.y - radius) / cell); y <= Math.floor((at.y + radius) / cell); y++)
        for (let z = Math.floor((at.z - radius) / cell); z <= Math.floor((at.z + radius) / cell); z++) for (const id of byCell.get(`${x},${y},${z}`) ?? []) out.add(id);
    return [...out];
  };
}

const tierName = process.env.J9_PERF_TIER ?? "250k";
const run = process.env.J9_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

run(`j9 connector integrity at ${tierName}`, () => {
  if (!isTier(tierName)) throw new Error(`J9_PERF_TIER=${tierName} isn't a full-BIM tier (${Object.keys(FULL_BIM_TIERS).join(", ")})`);
  installFirstPartyAddOns();

  it(`connections.integrity.full.${tierName}: every finding, beside validate.full`, () => {
    const built = createFullBimModel({ ...FULL_BIM_TIERS[tierName], modelId: `j9-${tierName}` });
    const head: ModelState = { ...built, elements: freezeElements(built.elements) };
    let found = 0;
    const integrity = time(3, () => {
      found = modelIntegrityIssues(head.elements).length;
    });
    const validate = time(3, () => {
      validateModel(head);
    });
    report(`connections.integrity.full.${tierName}`, integrity, `${Object.keys(head.elements).length} elements, ${found} findings`);
    report(`validate.full.${tierName}`, validate);
    expect(p50p95(integrity).p50).toBeLessThan(Math.max(p50p95(validate).p50, 1) * 3 + 2000);
  });

  it(`connections.integrity.edit.${tierName}: 50 changed parts' ends through a spatial index`, () => {
    const count = tierName === "1M" ? 1_000_000 : tierName === "250k" ? 250_000 : 50_000;
    const m = chain(count);
    const near = endIndex(m.elements);
    const ids = Array.from({ length: 50 }, (_, k) => `p${Math.floor((k * count) / 50) + 1}`);
    let found = 0;
    const s = time(20, () => {
      found = 0;
      for (const id of ids) {
        const el = m.elements[id];
        if (el) found += elementIntegrityIssues(m.elements, el, near).length;
      }
    });
    const full = time(1, () => {
      modelIntegrityIssues(m.elements);
    });
    const validate = time(1, () => {
      validateModel(m);
    });
    report(`connections.integrity.edit.${tierName}`, s, `${count} pieces, ${found} findings on the 50`);
    report(`connections.integrity.full.chain.${tierName}`, full, `${modelIntegrityIssues(m.elements).length} findings`);
    report(`validate.full.chain.${tierName}`, validate);
    if (ABSOLUTE_BUDGETS) expect(p50p95(s).p50).toBeLessThan(100);
  });

  it("parts.import_report.one_type: one starter type and one with 24 connectors", () => {
    const rtu = builtinPartType("builtin:rtu-5-ton@1");
    if (!rtu) throw new Error("starter library is missing the RTU");
    const one = time(50, () => {
      partTypeImportReport(rtu.definition);
    });
    const piece = straightPiece("Wide");
    const wide = { ...piece, connectors: Array.from({ length: 24 }, (_, i) => ({ ...(piece.connectors[i % 2] ?? piece.connectors[0]), id: `c${i}`, label: `C${i}` })) } as typeof piece;
    const many = time(50, () => {
      partTypeImportReport(wide);
    });
    report("parts.import_report.one_type", one, "starter unit");
    report("parts.import_report.one_type.24", many, "24 connectors");
    if (ABSOLUTE_BUDGETS) expect(p50p95(one).p50).toBeLessThan(50);
  });
});
