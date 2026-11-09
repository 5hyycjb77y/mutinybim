/**
 * @jest-environment node
 *
 * Round 11 G11: the kernel's new lifecycle, basis and anchor files carry no
 * trade word (the ratchet's list, `trade-terms.test.ts`) and no real-estate
 * word: site constraints, parcels' contents, rent, cap rate and the pro forma
 * live only in the Site and Development add-ons. The anchor kind name
 * `parcel` is the one shared word D3 reserves; what a parcel holds is the
 * add-on's.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const FILES = [...walk(path.join(SRC, "lifecycle")), ...walk(path.join(SRC, "basis")), path.join(SRC, "graph/anchors.ts")];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const TRADE = ["electrical", "plumbing", "mechanical", "sanitary", "grease", "vent", "sewer", "drainage", "interceptor", "breaker", "panelboard", "panel", "circuit", "feeder", "receptacle", "conductor", "conduit", "ampacity", "voltage", "kva", "amps", "nec", "ipc", "ifgc", "imc", "hvac", "duct", "cfm", "diffuser", "airflow", "ventilation", "wsfu", "dfu", "fixture", "gas", "mbh", "sprinkler"];
const REAL_ESTATE = ["rent", "cap", "pro", "forma", "noi", "lease", "tenant", "underwriting", "zoning", "setback", "easement", "flood", "acquisition", "yield", "vacancy"];

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

describe("g11 new kernel files carry no trade or real-estate words", () => {
  it.each(FILES.map((f) => [path.relative(SRC, f), f]))("%s", (_name, file) => {
    const found = new Set<string>();
    for (const w of words(readFileSync(file, "utf8"))) {
      for (const t of [...TRADE, ...REAL_ESTATE]) if (w === t || w === `${t}s` || w === `${t}es`) found.add(t);
    }
    expect([...found]).toEqual([]);
  });
});
