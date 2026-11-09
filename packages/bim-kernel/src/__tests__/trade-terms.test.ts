/**
 * @jest-environment node
 *
 * Trade-term ratchet (batch 5c, FOUNDATION-COVERAGE §3.3): trade knowledge
 * belongs in packs, not in `packages/bim-kernel`, so the count of
 * trade-specific words in the kernel's source only goes down.
 *
 * Counted: every `.ts` file under packages/bim-kernel/src except tests
 * (`__tests__/`, `*.test.ts`). The transitional first-party packs
 * (`packs/first-party/*`) ARE counted, so moving a trade out of the kernel
 * lowers the number. Identifiers are split into words first
 * (`electricalAdapter`, `ELECTRICAL_CALCS`, `wsfu_cold` → electrical,
 * adapter / electrical, calcs / wsfu, cold), then each word is compared,
 * case-insensitively, with each term and its plural (`circuit`, `circuits`).
 *
 * Fails when a term's total rises, or when a file the baseline doesn't list
 * uses any term. Passes and prints the new numbers when a total falls: lower
 * `trade-terms.baseline.json` to them (TRADE_TERMS_WRITE=1 rewrites it; only
 * ever commit a baseline that goes down).
 *
 * The terms, and why each is a trade's and not the kernel's:
 * - electrical, plumbing, mechanical: the three first-party trades by name.
 * - sanitary, grease, vent, sewer, drainage, interceptor: plumbing drainage
 *   systems and their parts.
 * - breaker, panelboard, panel, circuit, feeder, receptacle, conductor,
 *   conduit, ampacity, voltage, kva, amps: electrical distribution.
 * - nec, ipc, ifgc, imc: code books of one trade each.
 * - hvac, duct, cfm, diffuser, airflow, ventilation: air-side mechanical.
 * - wsfu, dfu, fixture: plumbing fixture units and fixtures.
 * - gas, mbh: fuel gas loads.
 * - sprinkler: fire protection (a pack in waiting).
 * Not counted, because the kernel needs them for any trade: network, load,
 * source, service, system, pipe (a shape every liquid trade routes), flow,
 * pressure, slope, clearance.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const TERMS = [
  "electrical", "plumbing", "mechanical",
  "sanitary", "grease", "vent", "sewer", "drainage", "interceptor",
  "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps",
  "nec", "ipc", "ifgc", "imc",
  "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation",
  "wsfu", "dfu", "fixture",
  "gas", "mbh",
  "sprinkler",
] as const;

type Term = (typeof TERMS)[number];
type Counts = Record<string, Partial<Record<Term, number>>>;

interface Baseline {
  readonly comment: string;
  readonly terms: readonly string[];
  readonly files: Counts;
}

const SRC = path.resolve(__dirname, "..");
const ROOT = path.resolve(SRC, "../../..");
const BASELINE_FILE = path.join(__dirname, "trade-terms.baseline.json");

const WORDS: ReadonlyMap<string, Term> = new Map(TERMS.flatMap((t) => [[t, t], [`${t}s`, t], [`${t}es`, t]] as const));

/** Each term's count in a source text, identifiers split into words. */
export function countTerms(text: string): Partial<Record<Term, number>> {
  const out: Partial<Record<Term, number>> = {};
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const raw of split.split(/[^A-Za-z]+/)) {
    if (raw.length < 3) continue;
    const term = WORDS.get(raw.toLowerCase());
    if (term) out[term] = (out[term] ?? 0) + 1;
  }
  return out;
}

function sourceFiles(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function countKernel(): Counts {
  const counts: Counts = {};
  for (const file of sourceFiles(SRC, []).sort()) {
    const c = countTerms(readFileSync(file, "utf8"));
    if (Object.keys(c).length > 0) counts[path.relative(ROOT, file).split(path.sep).join("/")] = c;
  }
  return counts;
}

function totals(counts: Counts): Record<Term, number> {
  const out = Object.fromEntries(TERMS.map((t) => [t, 0])) as Record<Term, number>;
  for (const byTerm of Object.values(counts)) for (const t of TERMS) out[t] += byTerm[t] ?? 0;
  return out;
}

function readBaseline(): Baseline {
  const raw: unknown = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  if (typeof raw !== "object" || raw === null || !("files" in raw) || !("terms" in raw)) throw new Error("trade-terms.baseline.json needs terms and files");
  return raw as Baseline;
}

describe("trade terms in packages/bim-kernel (shrink-only)", () => {
  it("splits identifiers into words and counts plurals", () => {
    expect(countTerms("const electricalAdapter = ELECTRICAL_CALCS; // circuits, wsfu_cold, a gasket")).toEqual({ electrical: 2, circuit: 1, wsfu: 1 });
  });

  it("no term's total rises and no new file uses one", () => {
    const t0 = performance.now();
    const now = countKernel();
    const ms = performance.now() - t0;
    if (process.env.TRADE_TERMS_WRITE === "1") {
      const baseline: Baseline = { comment: "Trade-specific words per kernel source file (trade-terms.test.ts). Shrink-only: lower these when a trade moves into a pack; never raise one.", terms: [...TERMS], files: now };
      writeFileSync(BASELINE_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
    }
    const baseline = readBaseline();
    expect([...baseline.terms]).toEqual([...TERMS]);
    const was = totals(baseline.files);
    const is = totals(now);
    const rose = TERMS.filter((t) => is[t] > was[t]).map((t) => `${t}: ${was[t]} → ${is[t]}`);
    const newFiles = Object.keys(now).filter((f) => !(f in baseline.files)).map((f) => `${f} (${Object.entries(now[f] ?? {}).map(([t, n]) => `${t} ${n}`).join(", ")})`);
    const fell = TERMS.filter((t) => is[t] < was[t]).map((t) => `${t}: ${was[t]} → ${is[t]}`);
    if (fell.length > 0) process.stdout.write(`[trade-terms] fewer trade terms in the kernel: ${fell.join("; ")}. Lower trade-terms.baseline.json to these (TRADE_TERMS_WRITE=1).\n`);
    expect({ rose, newFiles }).toEqual({ rose: [], newFiles: [] });
    expect(ms).toBeLessThan(2000);
  });
});
