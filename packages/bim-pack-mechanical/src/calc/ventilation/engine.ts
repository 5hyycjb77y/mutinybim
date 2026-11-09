import { convert, qty, to, type Quantity } from "@permitzip/bim-units";
import { elementsOfKind, pinnedUse, resolveField, spaceBasis, spaceLabel, spaceMeasure, spacesOfZone, zonesServedBy, type BimElement, type ElementId, type Space, type Zone } from "@permitzip/bim-kernel";
import { contribute, type ErasedContribution } from "@permitzip/bim-kernel/packs";
import {
  OUTDOOR_AIR_READER_POINT,
  ventilationTableOf,
  VENTILATION_STANDARD_IDS,
  type GoverningStandard,
  type SpaceStandardVentilation,
  type SpaceVentilation,
  type VentilationReader,
  type VentilationScope,
  type VentilationStandardId,
  type VentilationTable,
  type ZoneServingUnit,
  type ZoneStandardVentilation,
  type ZoneVentilation,
} from "./kernel-seam";
import { ventilateUnderStandard, type SpaceVentilationOverrides, type VentilationUseRow, type VentilationUseSource } from "./space";
import { DEFAULT_EZ, resolveGoverningStandard, standardCite, VENTILATION_PACK_VERSION, VENTILATION_STANDARDS } from "./standards";

/**
 * Outdoor air on a model's spaces and zones, incrementally. A space's result
 * depends only on its area (from the space index), its occupants, its pinned
 * use and its overrides; it is kept against a fingerprint of exactly those,
 * so any read after an unrelated edit returns the kept value. `advance`
 * re-checks only the spaces a command changed (and the spaces built on a
 * changed room), the way the requirements engine moves along by changed ids.
 * Zones sum their spaces' kept results on read.
 */

type Elements = Readonly<Record<string, BimElement>>;
type SpaceCore = Omit<SpaceVentilation, "governing">;

export interface VentilationEngineOptions {
  readonly uses: VentilationUseSource;
  /** Which standard is marked governing. Absent: IMC by default, said so. */
  readonly governing?: GoverningStandard;
  /** Per space id. Each carries its reason. */
  readonly overrides?: Readonly<Record<string, SpaceVentilationOverrides>>;
}

/** Unit parameters read as the serving unit's outdoor air, first found wins. */
export const UNIT_OUTDOOR_AIR_PARAMS = ["outdoor_cfm", "oa_cfm", "outdoor_air_cfm"] as const;

const WHOLE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtFt2 = (m2: number): string => WHOLE.format(convert(m2, "m2", "ft2"));

export class VentilationEngine implements VentilationReader {
  readonly id = `bim-calc ventilation ${VENTILATION_PACK_VERSION} (${VENTILATION_STANDARDS.imc.label}, ${VENTILATION_STANDARDS.ashrae_62_1.label})`;
  readonly governing: GoverningStandard;
  private readonly uses: VentilationUseSource;
  private readonly overrides: Readonly<Record<string, SpaceVentilationOverrides>>;
  private readonly kept: Map<ElementId, { readonly key: string; readonly value: SpaceCore }>;
  private readonly fingerprints = new WeakMap<Space, { readonly areaM2: number | null; readonly key: string }>();
  private readonly counter: { evaluations: number };

  constructor(opts: VentilationEngineOptions, shared?: { readonly kept: Map<ElementId, { readonly key: string; readonly value: SpaceCore }>; readonly counter: { evaluations: number } }) {
    this.uses = opts.uses;
    this.governing = opts.governing ?? resolveGoverningStandard();
    this.overrides = opts.overrides ?? {};
    this.kept = shared?.kept ?? new Map();
    this.counter = shared?.counter ?? { evaluations: 0 };
  }

  /** How many space evaluations have run (tests and the perf case prove an edit re-evaluates one space). */
  get evaluations(): number {
    return this.counter.evaluations;
  }

  /** The same kept results with another standard marked governing (the engineer's switch). Nothing is recomputed. */
  withGoverning(governing: GoverningStandard): VentilationEngine {
    return new VentilationEngine({ uses: this.uses, governing, overrides: this.overrides }, { kept: this.kept, counter: this.counter });
  }

  private fingerprint(space: Space, areaM2: number | null): string {
    const hit = this.fingerprints.get(space);
    if (hit && hit.areaM2 === areaM2) return hit.key;
    const use = pinnedUse(space);
    const key = JSON.stringify([areaM2 === null ? null : Math.round(areaM2 * 1e6), space.occupants ?? null, space.use?.libraryId ?? null, space.use?.useId ?? null, use?.revision ?? null, use?.occupantsPerM2 ?? null, this.overrides[space.id] ?? null, spaceLabel(space)]);
    this.fingerprints.set(space, { areaM2, key });
    return key;
  }

  private evaluate(elements: Elements, space: Space): SpaceCore {
    this.counter.evaluations += 1;
    const basis = spaceBasis(elements, space);
    const pinned = pinnedUse(space);
    const label = spaceLabel(space);
    const inputs: string[] = [basis.areaM2 === null ? "area: not drawn yet" : `area ${fmtFt2(basis.areaM2)} ft² from the ${space.bounds.kind === "rooms" ? "rooms it covers" : "outline"}`];
    const useName = pinned?.name ?? null;
    let row: VentilationUseRow | null = null;
    let why: string | null = null;
    if (!space.use) why = "No use set. Pick what the space is used for in the Spaces panel.";
    else if (space.use.libraryId !== this.uses.libraryId) why = `Its use comes from the library "${space.use.libraryId}", which isn't loaded here (${this.uses.libraryId} is). Set the use again.`;
    else {
      row = this.uses.get(space.use.useId) ?? null;
      if (!row) why = `The use "${useName ?? space.use.useId}" isn't in the space-use library any more. Pick another use.`;
      else if (pinned?.revision !== undefined && pinned.revision !== row.revision) {
        why = `The library's "${row.name}" row changed since this use was set (pinned revision ${pinned.revision}, now ${row.revision}). Set the use again to take the new rates.`;
        row = null;
      }
    }
    if (row) inputs.push(`use ${row.name} (${this.uses.libraryId}, revision ${row.revision})`);
    if (basis.occupants === null) inputs.push("occupants: none typed and no default density");
    else if (basis.occupantsBasis === "typed") inputs.push(`occupants ${basis.occupants} (typed)`);
    else inputs.push(`occupants ${basis.occupants} from the use's default density${row?.occupantsPer1000Ft2 ? ` of ${row.occupantsPer1000Ft2.value} per 1,000 ft² (${row.occupantsPer1000Ft2.cite.code}${row.occupantsPer1000Ft2.cite.edition ? ` ${row.occupantsPer1000Ft2.cite.edition}` : ""} ${row.occupantsPer1000Ft2.cite.clause})` : ""}`);
    const overrides = this.overrides[space.id];
    if (overrides?.ez) inputs.push(`Ez ${overrides.ez.value} (override: ${overrides.ez.reason})`);

    const standards = Object.fromEntries(
      VENTILATION_STANDARD_IDS.map((id): [VentilationStandardId, SpaceStandardVentilation] => {
        if (!row) return [id, missingStandard(id, why ?? "The use can't be read.")];
        return [id, ventilateUnderStandard(id, { useName: row.name, areaM2: basis.areaM2, occupants: basis.occupants, row, ...(overrides ? { overrides } : {}) })];
      }),
    ) as Record<VentilationStandardId, SpaceStandardVentilation>;
    return { spaceId: space.id, label, useName, areaM2: basis.areaM2, occupants: basis.occupants, occupantsBasis: basis.occupantsBasis, standards, inputs };
  }

  private core(elements: Elements, space: Space): SpaceCore {
    const areaM2 = spaceMeasure(elements, space.id)?.areaM2 ?? null;
    const key = this.fingerprint(space, areaM2);
    const hit = this.kept.get(space.id);
    if (hit && hit.key === key) return hit.value;
    const value = this.evaluate(elements, space);
    this.kept.set(space.id, { key, value });
    return value;
  }

  space(elements: Elements, spaceId: ElementId): SpaceVentilation | null {
    const space = elements[spaceId];
    if (space?.kind !== "space") return null;
    return { ...this.core(elements, space), governing: this.governing };
  }

  zone(elements: Elements, zoneId: ElementId): ZoneVentilation | null {
    const zone = elements[zoneId];
    if (zone?.kind !== "zone") return null;
    const spaces = spacesOfZone(elements, zone.id).map((s) => this.core(elements, s));
    const standards = Object.fromEntries(VENTILATION_STANDARD_IDS.map((id) => [id, zoneStandard(id, spaces)])) as Record<VentilationStandardId, ZoneStandardVentilation>;
    const servedBy = this.servingUnit(elements, zone, standards[this.governing.standard]);
    return { zoneId: zone.id, name: zone.name, spaceIds: spaces.map((s) => s.spaceId), standards, governing: this.governing, servedBy, systemNote: systemNote(servedBy, this.governing.standard) };
  }

  private servingUnit(elements: Elements, zone: Zone, governing: ZoneStandardVentilation): ZoneServingUnit | null {
    if (!zone.servedBy) return null;
    const unit = elements[zone.servedBy];
    if (!unit) return null;
    const mark = "mark" in unit && typeof unit.mark === "string" && unit.mark.trim() !== "" ? unit.mark : unit.id;
    let outdoorAir: Quantity<"flow_air"> | null = null;
    for (const p of UNIT_OUTDOOR_AIR_PARAMS) {
      const v = resolveField(elements, unit.id, `param.${p}`).value;
      if (typeof v === "number" && Number.isFinite(v)) {
        outdoorAir = qty("flow_air", v, "cfm");
        break;
      }
    }
    const zones = zonesServedBy(elements, unit.id);
    let need: Quantity<"flow_air"> | null = governing.voz;
    if (zones.length > 1) {
      let total = 0;
      for (const z of zones) {
        const r = z.id === zone.id ? governing : zoneStandard(this.governing.standard, spacesOfZone(elements, z.id).map((s) => this.core(elements, s)));
        if (r.voz === null) {
          need = null;
          break;
        }
        total += r.voz;
      }
      if (need !== null) need = total as Quantity<"flow_air">;
    }
    const comparison = outdoorAir === null || need === null ? "unknown" : to(outdoorAir, "cfm") + 0.5 >= to(need, "cfm") ? "meets" : "short";
    return { id: unit.id, mark, outdoorAir, zoneCount: zones.length, comparison };
  }

  /** Re-check the spaces a command changed; returns the ones whose result was recomputed. */
  advance(elements: Elements, changedIds: Iterable<string>): { readonly recomputed: readonly ElementId[] } {
    const candidates = new Set<ElementId>();
    let rooms: Set<string> | null = null;
    for (const id of changedIds) {
      const el = elements[id];
      if (el?.kind === "space") candidates.add(el.id);
      else if (!el) this.kept.delete(id as ElementId);
      else if (el.kind === "room") (rooms ??= new Set()).add(id);
    }
    if (rooms) for (const s of this.spacesOnRooms(elements, rooms)) candidates.add(s);
    const recomputed: ElementId[] = [];
    for (const id of candidates) {
      const space = elements[id];
      if (space?.kind !== "space") continue;
      const n = this.counter.evaluations;
      this.core(elements, space);
      if (this.counter.evaluations > n) recomputed.push(id);
    }
    return { recomputed: recomputed.sort() };
  }

  private spacesOnRooms(elements: Elements, rooms: ReadonlySet<string>): ElementId[] {
    // A room edit is rare; spaces built on rooms are found from the space kind index.
    return elementsOfKind(elements, "space")
      .filter((s) => s.bounds.kind === "rooms" && s.bounds.roomIds.some((r) => rooms.has(r)))
      .map((s) => s.id);
  }

  table(elements: Elements, scope: VentilationScope): VentilationTable {
    return ventilationTableOf(elements, scope, this);
  }
}

function missingStandard(id: VentilationStandardId, reason: string): SpaceStandardVentilation {
  const s = VENTILATION_STANDARDS[id];
  return { standard: id, label: s.label, status: "missing", reasons: [reason], rp: null, ra: null, ez: { value: qty("ratio", DEFAULT_EZ, "1"), from: "default", cite: standardCite(s, "ez", "ceiling supply of cool air") }, vbz: null, voz: null, exhaust: null, exhaustReason: reason, arithmetic: null, cites: [] };
}

function zoneStandard(id: VentilationStandardId, spaces: readonly SpaceCore[]): ZoneStandardVentilation {
  const missing: Array<{ spaceId: ElementId; label: string; reason: string }> = [];
  let voz = 0;
  let exhaust = 0;
  let anyExhaust = false;
  for (const s of spaces) {
    const r = s.standards[id];
    if (r.status === "missing" || r.voz === null) missing.push({ spaceId: s.spaceId, label: s.label, reason: r.reasons.join(" ") });
    else voz += r.voz;
    if (r.exhaust !== null) {
      exhaust += r.exhaust;
      anyExhaust = true;
    }
  }
  return { standard: id, label: VENTILATION_STANDARDS[id].label, voz: missing.length > 0 || spaces.length === 0 ? null : (voz as Quantity<"flow_air">), exhaust: anyExhaust ? (exhaust as Quantity<"flow_air">) : null, missing };
}

function systemNote(unit: ZoneServingUnit | null, governing: VentilationStandardId): string {
  const s = VENTILATION_STANDARDS[governing];
  if (!unit) return "No serving unit: assign the zone to equipment in the Spaces panel to compare its outdoor air.";
  if (unit.zoneCount <= 1) return `${unit.mark} serves this zone only: single-zone system, Vot = Voz (${s.code} ${s.edition} ${s.clauses.singleZone}).`;
  return `${unit.mark} serves ${unit.zoneCount} zones: multi-zone system efficiency (Ev, ${s.code} ${s.edition} ${s.clauses.multiZone}) not calculated yet, so its outdoor air is compared with the uncorrected sum of the zones' Voz.`;
}

/**
 * The engine as a row of the kernel's `OUTDOOR_AIR_READER_POINT`: a pack (the
 * Mechanical pack, through `@permitzip/bim-first-party`) contributes it, and
 * every space and zone field, the Ventilation panel and the table block of a
 * model whose set holds that pack read through it.
 */
export function ventilationReaderContribution(engine: VentilationEngine): ErasedContribution {
  return contribute(OUTDOOR_AIR_READER_POINT, [engine]);
}
