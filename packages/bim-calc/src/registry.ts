import { jurisdictionWords, parseJurisdiction, type JurisdictionId, type ModelState } from "@permitzip/bim-kernel";
import { activePackSet, defineExtensionPoint, type ExtensionPoint } from "@permitzip/bim-kernel/packs";
import { BIM_CALC_UNIT_CODES, UNIT_CODES } from "@permitzip/bim-units";
import { z } from "zod";
import { PERMITZIP_DESIGN_CRITERIA } from "./packs/design-criteria";
import { IFGC_EDITIONS, ifgcEdition, isIfgcYear } from "./packs/ifgc/pack";
import { IPC_EDITIONS, ipcEdition, isIpcYear } from "./packs/ipc/pack";
import { CODE_ADOPTIONS, ELECTRICAL_ADOPTIONS, ELECTRICAL_ADOPTIONS_SOURCE, adoptionFor, adoptionTableKey, codeBookFor, isNecYear, modelYearFromAdoption, necYearFromAdoption, type CodeDiscipline, type ProjectCodeAdoption, type ProjectElectricalAdoption } from "./packs/jurisdictions";
import { NEC_EDITIONS, isNecEdition, necEdition, type NecEdition, type NecEditionYear } from "./packs/nec/pack";
import type { CalcContext, CalcDomain, CalcPlugin, CalcRun, CalcStep, Citation, CodeEdition, DesignCriteria } from "./types";

export interface CalcInfo {
  readonly id: string;
  readonly version: string;
  readonly domain: CalcDomain;
  readonly title: string;
  readonly summary: string;
  readonly codeFamily: string | null;
  readonly needsModel: boolean;
  readonly example: unknown;
  /** JSON Schema of the raw input. */
  readonly inputSchema: unknown;
}

export interface RegisteredCalc {
  readonly info: CalcInfo;
  execute(raw: unknown, ctx: CalcContext): { ok: true; parsed: unknown; output: Omit<CalcRun, "calc" | "code" | "criteria" | "inputs" | "citations" | "runKey"> } | { ok: false; reason: string };
}

/** Type-erase a plugin behind its schema: the registry only ever hands it input its own schema accepted. */
export function defineCalc<S extends z.ZodType, D>(plugin: CalcPlugin<S, D>): RegisteredCalc {
  let schema: unknown = null;
  try {
    schema = z.toJSONSchema(plugin.input, { io: "input", unrepresentable: "any" });
  } catch (err) {
    console.error(`[bim-calc] ${plugin.id}: input schema could not be expressed as JSON Schema; listing it without one`, err);
  }
  return {
    info: { id: plugin.id, version: plugin.version, domain: plugin.domain, title: plugin.title, summary: plugin.summary, codeFamily: plugin.codeFamily, needsModel: plugin.needsModel, example: plugin.example, inputSchema: schema },
    execute(raw, ctx) {
      const parsed = plugin.input.safeParse(raw);
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "inputs"}: ${i.message}`).join("; ");
        return { ok: false, reason: `The inputs for ${plugin.title} aren't valid: ${why}` };
      }
      const output = plugin.run(parsed.data, ctx);
      return { ok: true, parsed: parsed.data, output: { values: output.values, steps: output.steps, issues: output.issues, detail: output.detail } };
    },
  };
}

export interface RunRequest {
  readonly calc: string;
  readonly inputs: unknown;
  /** An edition chosen for this run. Wins over everything else. */
  readonly necEdition?: NecEditionYear;
  /** The project's adopted electrical code (Code Study). Wins over the state. */
  readonly projectAdoption?: ProjectElectricalAdoption | null;
  /** Where the project is, any country (round 10): its adopted editions are used when none is given. Wins over `state`. */
  readonly jurisdiction?: JurisdictionId | string;
  /** Older callers' two-letter US state; read as `{ country: "US", subdivision: "US-<state>" }`. */
  readonly state?: string;
  /** Per code family, the edition chosen for this run ({ nec: "2023", ipc: "2021", "struct.asce7": "7-22" }). Wins over the project's and the place's. */
  readonly editions?: Readonly<Record<string, string>>;
  /** Plumbing code (IPC family) edition chosen for this run ("2021"). Wins over the project's and the state's. */
  readonly plumbingEdition?: string;
  /** Fuel gas code (IFGC family) edition chosen for this run ("2021"). */
  readonly fuelGasEdition?: string;
  /** The project's adopted plumbing and fuel gas codes (Code Study). Win over the state. */
  readonly projectAdoptions?: { readonly plumbing?: ProjectCodeAdoption | null; readonly fuel_gas?: ProjectCodeAdoption | null };
  readonly criteria?: DesignCriteria;
  readonly model?: ModelState | null;
}

const NO_CALCS: ReadonlyMap<string, RegisteredCalc> = new Map();

const CALC_UNITS: ReadonlySet<string> = new Set<string>([...Object.keys(BIM_CALC_UNIT_CODES), ...UNIT_CODES]);

/** Whether `unit` is a calc unit or a bim-units code. */
export function isCalcUnit(unit: string): boolean {
  return CALC_UNITS.has(unit);
}

export type RunResult = { readonly ok: true; readonly run: CalcRun } | { readonly ok: false; readonly reason: string };

export interface CalcRegistryOptions {
  /** Also offer the calcs packs contribute here, from the pack set in force when asked (`builtinCalcRegistry` passes `CALC_POINT`). */
  readonly packPoint?: ExtensionPoint<RegisteredCalc>;
}

export class CalcRegistry {
  private readonly calcs = new Map<string, RegisteredCalc>();
  private readonly packPoint: ExtensionPoint<RegisteredCalc> | null;
  /** Per pack set: its calcs, checked against this registry's own. */
  private readonly packCache = new WeakMap<object, ReadonlyMap<string, RegisteredCalc>>();

  constructor(options: CalcRegistryOptions = {}) {
    this.packPoint = options.packPoint ?? null;
  }

  register(calc: RegisteredCalc): this {
    if (this.calcs.has(calc.info.id)) throw new Error(`[bim-calc] calc ${calc.info.id} is registered twice`);
    this.calcs.set(calc.info.id, calc);
    return this;
  }

  /** The pack set in force's calcs by id; empty outside any scope. A pack calc never shadows a registered one. */
  private packCalcs(): ReadonlyMap<string, RegisteredCalc> {
    const point = this.packPoint;
    if (!point) return NO_CALCS;
    const set = activePackSet();
    const items = set.packItems(point);
    if (items.length === 0) return NO_CALCS;
    const cached = this.packCache.get(set);
    if (cached) return cached;
    const out = new Map<string, RegisteredCalc>();
    for (const calc of items) {
      if (this.calcs.has(calc.info.id)) throw new Error(`[bim-calc] a pack's calc ${calc.info.id} has a built-in calc's id; a pack may not replace it`);
      out.set(calc.info.id, calc);
    }
    this.packCache.set(set, out);
    return out;
  }

  private lookup(id: string): RegisteredCalc | undefined {
    return this.calcs.get(id) ?? this.packCalcs().get(id);
  }

  list(): readonly CalcInfo[] {
    return [...this.calcs.values(), ...this.packCalcs().values()].map((c) => c.info).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): RegisteredCalc | null {
    return this.lookup(id) ?? null;
  }

  /** Whether the calc's code edition resolves for this request (given, the project's Code Study, or the state); false when it would be refused for that. */
  resolvesCode(calcId: string, request: Omit<RunRequest, "calc" | "inputs">): boolean {
    const calc = this.lookup(calcId);
    return calc ? resolveCode(calc.info.codeFamily, request).ok : false;
  }

  run(request: RunRequest): RunResult {
    const calc = this.lookup(request.calc);
    if (!calc) return { ok: false, reason: `No calc "${request.calc}". Available: ${this.list().map((c) => c.id).join(", ")}.` };
    const criteria = request.criteria ?? PERMITZIP_DESIGN_CRITERIA;
    const resolved = resolveCode(calc.info.codeFamily, request);
    if (!resolved.ok) return resolved;
    if (calc.info.needsModel && !request.model) return { ok: false, reason: `${calc.info.title} reads a model; give the model to run it against.` };
    const ctx: CalcContext = { code: resolved.code, criteria, model: request.model ?? null };
    let result: ReturnType<RegisteredCalc["execute"]>;
    try {
      result = calc.execute(request.inputs, ctx);
    } catch (err) {
      console.error(`[bim-calc] ${calc.info.id} threw`, err);
      return { ok: false, reason: `${calc.info.title} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!result.ok) return result;
    const badUnit = result.output.values.find((v) => v.unit !== null && !isCalcUnit(v.unit));
    if (badUnit) {
      console.error(`[bim-calc] ${calc.info.id} returned a value in a unit nobody knows`, { key: badUnit.key, unit: badUnit.unit });
      return { ok: false, reason: `${calc.info.title} returned ${badUnit.label} in "${badUnit.unit}", which isn't a unit MutinyBIM knows; the calc needs fixing.` };
    }
    const steps: readonly CalcStep[] = resolved.step ? [resolved.step, ...result.output.steps] : result.output.steps;
    const citations = dedupe([...steps.flatMap((s) => s.cite), ...result.output.values.flatMap((v) => v.cite), ...result.output.issues.flatMap((i) => i.cite)]);
    const code = resolved.code ? { family: resolved.code.family, edition: resolved.code.edition, packVersion: resolved.code.packVersion } : null;
    const keyCode = resolved.code && resolved.code.family !== "nec" ? { ...code, adoptedAs: resolved.code.code } : code;
    const model = request.model ? { modelId: request.model.modelId, revision: request.model.revision } : null;
    return {
      ok: true,
      run: {
        calc: { id: calc.info.id, version: calc.info.version, title: calc.info.title, domain: calc.info.domain },
        code,
        criteria: { id: criteria.id, version: criteria.version },
        inputs: result.parsed,
        values: result.output.values,
        steps,
        issues: result.output.issues,
        citations,
        detail: result.output.detail,
        runKey: fingerprint({ calc: calc.info.id, version: calc.info.version, code: keyCode, criteria: [criteria.id, criteria.version, criteria.electrical], inputs: result.parsed, model }),
      },
    };
  }
}

/** Which NEC edition applies: the one asked for, else the project's adopted code, else the state's adoption; else the reason it can't be told. */
export function resolveNecEdition(request: Pick<RunRequest, "necEdition" | "projectAdoption" | "state" | "jurisdiction" | "editions">): { readonly ok: true; readonly edition: NecEdition; readonly step: CalcStep | null } | { readonly ok: false; readonly reason: string } {
  const r = resolveCode("nec", request);
  if (!r.ok) return r;
  if (!r.code || !isNecEdition(r.code)) return { ok: false, reason: "No NEC edition resolved" };
  return { ok: true, edition: r.code, step: r.step };
}

/** What a code family's resolver is told: the run request without the calc id (the inputs only when running). */
export type CodeRequest = Omit<RunRequest, "calc" | "inputs"> & { readonly inputs?: unknown };

export type CodeResolution = { readonly ok: true; readonly code: CodeEdition; readonly step: CalcStep | null } | { readonly ok: false; readonly reason: string };

/**
 * A code family and its editions (NEC, IPC; a pack's `struct.asce7`): which
 * edition applies to a run, from the request, the project's Code Study or
 * the state. A pack's family id is `<pack>.<name>`; its resolver reads what
 * it needs from the request (its own calc inputs included), so no new
 * `RunRequest` field is ever needed.
 */
export interface CodeFamilyDef {
  readonly family: string;
  /** "National Electrical Code". */
  readonly label: string;
  readonly editions: readonly string[];
  resolve(request: CodeRequest): CodeResolution;
}

function resolveCode(family: string | null, request: CodeRequest): { ok: true; code: CodeEdition | null; step: CalcStep | null } | { ok: false; reason: string } {
  if (family === null) return { ok: true, code: null, step: null };
  const def = codeFamilies().get(family);
  if (!def) return { ok: false, reason: `No code pack "${family}" is installed.` };
  return def.resolve(request);
}

/** Where a request says the project is: `jurisdiction`, else the older `state`, read tolerantly. */
export function requestJurisdiction(request: Pick<RunRequest, "jurisdiction" | "state">): JurisdictionId | null {
  return parseJurisdiction(request.jurisdiction ?? request.state);
}

/** How a refusal names the place: a US state by its postal code (as before round 10), anywhere else in words ("Sweden"). */
function placeWords(request: Pick<RunRequest, "jurisdiction" | "state">): string | null {
  const j = requestJurisdiction(request);
  const state = adoptionTableKey(j ?? "");
  if (state && !j?.locality && !j?.authority) return state;
  if (j) return jurisdictionWords(j);
  return request.state ? request.state.toUpperCase() : null;
}

/** The edition asked for one family: `editions[family]`, else the older per-family field. */
function askedEdition(request: CodeRequest, family: string, legacy: string | undefined): string | undefined {
  return request.editions?.[family] ?? legacy;
}

function resolveNec(request: CodeRequest): CodeResolution {
  const asked = askedEdition(request, "nec", request.necEdition);
  if (asked) {
    if (!isNecYear(asked)) return { ok: false, reason: `NEC ${asked} isn't an edition the NEC pack covers (2020 or 2023).` };
    return { ok: true, code: necEdition(asked), step: null };
  }
  if (request.projectAdoption) {
    const a = request.projectAdoption;
    const found = necYearFromAdoption(a);
    if (found && "unsupported" in found) return { ok: false, reason: `This project's electrical code is ${a.codeName} ${a.edition} (NEC ${found.unsupported}); the NEC pack covers 2020 and 2023. Give nec_edition to run it under one of those, knowing it isn't the adopted edition.` };
    if (found) {
      const cite: Citation = { source: "code", code: a.codeName, edition: found.year, clause: "adoption", detail: `project Code Study, ${a.status}`, text: `${a.codeName} ${a.edition}: NEC ${found.year} (this project's Code Study, ${a.status})` };
      return { ok: true, code: necEdition(found.year), step: { label: "Code edition", detail: `The project's Code Study lists ${a.codeName} ${a.edition}${a.status === "unconfirmed" ? " (not yet confirmed)" : ""}`, cite: [cite] } };
    }
  }
  const place = requestJurisdiction(request);
  const where = placeWords(request);
  if (where) {
    const adoption = place ? adoptionFor(place) : null;
    if (!adoption) return { ok: false, reason: `No NEC adoption is on file for ${where} (on file: ${Object.keys(ELECTRICAL_ADOPTIONS).join(", ")}). Give the NEC edition the project is under: 2020 or 2023.` };
    const cite: Citation = { source: "code", code: adoption.codeName, edition: adoption.nec, clause: "adoption", detail: `effective ${adoption.effectiveDate}`, text: `${adoption.codeName}: NEC ${adoption.nec}, effective ${adoption.effectiveDate} (${ELECTRICAL_ADOPTIONS_SOURCE})` };
    return { ok: true, code: necEdition(adoption.nec), step: { label: "Code edition", detail: `${adoption.stateName} adopted NEC ${adoption.nec}${adoption.note ? ` (${adoption.note})` : ""}`, cite: [cite] } };
  }
  return { ok: false, reason: "Say which NEC edition the project is under (2020 or 2023), or give its state so the adopted edition is used. (Recording the electrical code in the project's Code Study makes this automatic.)" };
}

const BOOK: Readonly<Record<"plumbing" | "fuel_gas", { readonly model: string; readonly words: string; readonly field: string }>> = {
  plumbing: { model: "IPC", words: "plumbing code", field: "plumbing_edition" },
  fuel_gas: { model: "IFGC", words: "fuel gas code", field: "fuel_gas_edition" },
};

/**
 * Plumbing (IPC family) and fuel gas (IFGC family) editions: the one asked
 * for, else the project's Code Study, else the state's adoption from the Code
 * Map; else a refusal that says what to give. Only 2021 has data (the code
 * library holds Virginia's 2021 adoption); other years are refused by name.
 */
function resolveModelCode(discipline: "plumbing" | "fuel_gas", asked: string | undefined, project: ProjectCodeAdoption | null, request: Pick<RunRequest, "jurisdiction" | "state">): { ok: true; code: CodeEdition; step: CalcStep | null } | { ok: false; reason: string } {
  const place = requestJurisdiction(request);
  const where = placeWords(request);
  const state = place ? adoptionTableKey(place) : null;
  const book = BOOK[discipline];
  const supported = discipline === "plumbing" ? isIpcYear : isIfgcYear;
  const make = (year: "2021", code: string, libraryText: boolean): CodeEdition => (discipline === "plumbing" ? ipcEdition(year, { code, libraryText }) : ifgcEdition(year, { code, libraryText }));
  const refuseYear = (year: string, whose: string) => ({ ok: false as const, reason: `${whose} is the ${year} ${book.model}; the code library holds the 2021 edition only (Virginia's adoption). Give ${book.field}: "2021" to run it under 2021 knowing it isn't the adopted edition, or import the ${year} tables.` });
  if (asked) {
    if (!supported(asked)) return refuseYear(asked, "The edition asked for");
    const va = state === "VA";
    return { ok: true, code: make("2021", va ? (discipline === "plumbing" ? "VPC" : "VFGC") : book.model, va), step: null };
  }
  if (project) {
    const year = modelYearFromAdoption(project);
    if (year && !supported(year)) return refuseYear(year, `This project's ${book.words} (${project.codeName} ${project.edition})`);
    if (year) {
      const virginia = /virginia|\bV(PC|FGC)\b/i.test(`${project.codeName} ${project.edition}`);
      const cite: Citation = { source: "code", code: project.codeName, edition: year, clause: "adoption", detail: `project Code Study, ${project.status}`, text: `${project.codeName} ${project.edition}: ${year} ${book.model} (this project's Code Study, ${project.status})` };
      return { ok: true, code: make("2021", virginia ? (discipline === "plumbing" ? "VPC" : "VFGC") : project.codeName, virginia), step: { label: "Code edition", detail: `The project's Code Study lists ${project.codeName} ${project.edition}${project.status === "unconfirmed" ? " (not yet confirmed)" : ""}`, cite: [cite] } };
    }
  }
  if (where) {
    const adopted = state ? codeBookFor(state, discipline as CodeDiscipline) : null;
    if (!adopted) {
      const listed = Object.keys(CODE_ADOPTIONS).filter((s) => codeBookFor(s, discipline as CodeDiscipline)).join(", ");
      return { ok: false, reason: `No ${book.words} adoption is on file for ${where} (on file: ${listed}). Say which edition applies: give ${book.field} ("2021").` };
    }
    if (!supported(adopted.editionYear)) return refuseYear(adopted.editionYear, `${adopted.stateName}'s ${book.words}`);
    const cite: Citation = { source: "code", code: adopted.codeName, edition: adopted.editionYear, clause: "adoption", detail: `effective ${adopted.effectiveDate}`, text: `${adopted.codeName} (${adopted.shortName}): ${adopted.baseModelCode}, effective ${adopted.effectiveDate} (${ELECTRICAL_ADOPTIONS_SOURCE})` };
    return { ok: true, code: make("2021", adopted.shortName, adopted.state === "VA"), step: { label: "Code edition", detail: `${adopted.stateName} adopted the ${adopted.baseModelCode} as the ${adopted.codeName}${adopted.note ? ` (${adopted.note})` : ""}`, cite: [cite] } };
  }
  return { ok: false, reason: `Say which ${book.words} edition applies (give ${book.field}: "2021"), or give the project's state so its adopted edition is used. (Recording the ${book.words} in the project's Code Study makes this automatic.)` };
}

const BUILTIN_CODE_FAMILIES: readonly CodeFamilyDef[] = [
  { family: "nec", label: "National Electrical Code", editions: NEC_EDITIONS, resolve: resolveNec },
  { family: "ipc", label: "International Plumbing Code", editions: IPC_EDITIONS, resolve: (r) => resolveModelCode("plumbing", askedEdition(r, "ipc", r.plumbingEdition), r.projectAdoptions?.plumbing ?? null, r) },
  { family: "ifgc", label: "International Fuel Gas Code", editions: IFGC_EDITIONS, resolve: (r) => resolveModelCode("fuel_gas", askedEdition(r, "ifgc", r.fuelGasEdition), r.projectAdoptions?.fuel_gas ?? null, r) },
];

/** Code families and their editions (v1). A pack registers its own family (`struct.asce7`) with its editions and resolver. */
export const CODE_EDITION_POINT = defineExtensionPoint<CodeFamilyDef>({
  id: "calc.code_edition",
  version: 1,
  label: "Code editions",
  idOf: (def) => def.family,
  builtins: () => BUILTIN_CODE_FAMILIES,
});

const BUILTIN_FAMILY_TABLE: ReadonlyMap<string, CodeFamilyDef> = new Map(BUILTIN_CODE_FAMILIES.map((d) => [d.family, d]));

function codeFamilies(): ReadonlyMap<string, CodeFamilyDef> {
  const set = activePackSet();
  if (set.packItems(CODE_EDITION_POINT).length === 0) return BUILTIN_FAMILY_TABLE;
  return set.memo("calc.code_edition.table", () => new Map(set.items(CODE_EDITION_POINT).map((d) => [d.family, d])));
}

/** The first-party pack a built-in code family belongs to, for listing; null for a pack's own. */
export function codeFamilyOwner(def: Pick<CodeFamilyDef, "family">): string | null {
  return def.family === "nec" ? "electrical" : def.family === "ipc" || def.family === "ifgc" ? "plumbing_gas" : null;
}

function dedupe(cites: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of cites) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    out.push(c);
  }
  return out;
}

/** Key-sorted JSON, so the same value always serializes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Two independent 32-bit FNV-1a passes over the canonical JSON, hex. A cache key, not a security hash. */
export function fingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
