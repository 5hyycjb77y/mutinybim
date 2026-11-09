import { connectionTypeOf } from "../catalog/model";
import type { CatalogTrade } from "../catalog/types";
import { loadPointTotals, partConnectionTypeName } from "../load-points/model";
import { disciplineOfCategory, paramValue, resolveConnectors } from "../parts";
import { serviceById } from "../services/registry";
import { connectionTypeTrades, loadSectionsPresent, type LoadSection } from "../requirements/facets";
import { loadIndexOf } from "../requirements/load-index";
import type { BimElement, Discipline, PartInstance } from "../types";
import { tradeAdapter } from "./model";
import { SERVICE_TRADES } from "./types";

/**
 * The trades a part takes part in (shared connection model, every trade the
 * same way): its class's own discipline, then every trade it is connected in
 * or can be (a served-from link either end, a connector, a nameplate a trade
 * adapter circuits it by), then every trade its loads draw on (load records
 * anchored on it, the connection type it names, nameplate quantities). A fryer
 * filed as Mechanical equipment with 120 V 1,800 VA and 80 MBH takes part in
 * mechanical, electrical and plumbing (gas reads on the Plumbing side).
 *
 * Cost: the part's own record, its type, its links and its loads from the
 * per-record load index; never a pass over the model.
 */

type Elements = Readonly<Record<string, BimElement>>;

const SECTION_DISCIPLINE: Readonly<Record<LoadSection, Discipline>> = {
  electrical: "electrical",
  gas: "plumbing",
  water: "plumbing",
  drainage: "plumbing",
  air: "mechanical",
};

const CATALOG_DISCIPLINE: Readonly<Record<CatalogTrade, Discipline>> = {
  electrical: "electrical",
  plumbing: "plumbing",
  gas: "plumbing",
  mechanical: "mechanical",
};

const PART_DISCIPLINES: ReadonlySet<string> = new Set<Discipline>(["architecture", "structure", "mechanical", "plumbing", "electrical", "fire_protection"]);

const isPartDiscipline = (d: string): d is Discipline => PART_DISCIPLINES.has(d);

/** Who owns a connector's system, from its service row; "Other" and kinds this release doesn't know name no trade. */
function systemDiscipline(kind: string): Discipline | null {
  if (kind === "other") return null;
  const d = serviceById(kind)?.discipline;
  return d !== undefined && isPartDiscipline(d) ? d : null;
}

/**
 * Nameplate values a part states without a drawn connector, by the load
 * section they fill: an equipment list's "120 V, 1,800 VA, 80 MBH, 1/2 in. CW".
 * Extend here, never in a consumer.
 */
const NAMEPLATE_SECTIONS: Readonly<Record<string, LoadSection>> = {
  load_va: "electrical",
  input_mbh: "gas",
  gas_input_mbh: "gas",
  cw_size: "water",
  hw_size: "water",
  waste_size: "drainage",
  airflow_cfm: "air",
};

function stated(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  return typeof value === "string" && value.trim() !== "";
}

/** Every discipline the part takes part in, its class's own first, each once. */
export function partDisciplines(elements: Elements, part: PartInstance): Discipline[] {
  const type = elements[part.typeId];
  const def = type?.kind === "part_type" ? type.definition : null;
  const out: Discipline[] = [part.partition?.discipline ?? (def ? disciplineOfCategory(def.category) : "architecture")];
  const add = (d: Discipline | null | undefined): void => {
    if (d && !out.includes(d)) out.push(d);
  };

  for (const id of [...Object.values(part.served ?? {}), ...(part.feeds ?? [])]) {
    const link = elements[id];
    if (link?.kind === "service_link") add(link.trade);
  }
  if (def) {
    for (const c of resolveConnectors(def, part.values)) add(c.domain === "duct" ? "mechanical" : c.domain === "electrical" ? "electrical" : systemDiscipline(c.systemKind));
    for (const [param, section] of Object.entries(NAMEPLATE_SECTIONS)) if (stated(paramValue(def, part.values, param))) add(SECTION_DISCIPLINE[section]);
  }
  for (const trade of SERVICE_TRADES) {
    const adapter = tradeAdapter(trade);
    if (adapter && (adapter.connectors(elements, part).length > 0 || adapter.source(elements, part) !== null)) add(trade);
  }

  const designator = partConnectionTypeName(elements, part);
  const entry = designator === null ? null : connectionTypeOf(elements, designator);
  if (entry) for (const t of connectionTypeTrades(entry)) add(CATALOG_DISCIPLINE[t]);
  for (const id of loadIndexOf(elements).ofPart(part.id)) {
    const lp = elements[id];
    if (lp?.kind !== "load_point") continue;
    for (const section of loadSectionsPresent(loadPointTotals(elements, lp))) add(SECTION_DISCIPLINE[section]);
  }
  return out;
}
