import { activePackSet, defineExtensionPoint } from "@permitzip/bim-kernel/packs";
import { unitAllowed, type Kind, type UnitCode } from "@permitzip/bim-units";
import { z } from "zod";

/**
 * Space uses: what a space is used for, with the rates several codes give it,
 * in one row (KERNEL-REQUIREMENTS-MODEL §3.2). A restaurant dining room has an
 * IMC / ASHRAE 62.1 people rate and area rate and a default occupant density,
 * an NEC 220.12 lighting load, an IBC occupant load factor and an IPC
 * occupancy for fixture counts. The kernel never reads this file: setting a
 * space's use pins the row's density and rates into the model (bim-calc
 * `pinSpaceUse` converts them into canonical units).
 *
 * Firms extend the list: a firm row with the same `id` replaces the built-in
 * one; a new id adds a row. Every rate names its clause. `verified: false`
 * means the value is from the published table as commonly adopted but has not
 * been checked against a code library record in this repo; the Spaces panel
 * says so beside the number, and the adopted edition governs.
 */

export const SPACE_USE_LIBRARY_ID = "builtin:space-uses";

export const SPACE_USE_RATE_KEYS = ["outdoor_air_people", "outdoor_air_area", "lighting", "receptacles", "exhaust_area"] as const;
export type KnownSpaceUseRateKey = (typeof SPACE_USE_RATE_KEYS)[number];
/** A rate key: a built-in one, or a pack's `<pack>.<name>` (`struct.live_load`). */
export type SpaceUseRateKey = KnownSpaceUseRateKey | (string & {});

/** What a rate loads onto and how: per area or per person, of one unit kind. */
export interface SpaceUseRateTarget {
  /** The rate key rows name it by. */
  readonly key: string;
  /** Where the rate lands: a parameter key (built-ins: the kernel's quantity bag keys `cfm`, `va`). */
  readonly quantity: string;
  readonly per: "area" | "occupant";
  readonly kind: Kind;
  readonly label: string;
  /** The unit a pack rate's total is in, on its parameter (`lbf` for a live load in psf); built-in keys take the quantity bag's units. */
  readonly unit?: UnitCode;
}

/** What each built-in rate key loads onto (the kernel's quantity bag key) and whether it is per area or per person. */
export const SPACE_USE_RATE_TARGETS: Readonly<Record<KnownSpaceUseRateKey, { readonly quantity: "cfm" | "va"; readonly per: "area" | "occupant"; readonly kind: Kind; readonly label: string }>> = {
  outdoor_air_people: { quantity: "cfm", per: "occupant", kind: "airflow_per_person", label: "Outdoor air per person (Rp)" },
  outdoor_air_area: { quantity: "cfm", per: "area", kind: "airflow_per_area", label: "Outdoor air per area (Ra)" },
  lighting: { quantity: "va", per: "area", kind: "power_per_area", label: "General lighting load" },
  receptacles: { quantity: "va", per: "area", kind: "power_per_area", label: "Receptacle load" },
  exhaust_area: { quantity: "cfm", per: "area", kind: "airflow_per_area", label: "Exhaust per area" },
};

/** Space-use rate keys (v1). A pack's keys are `<pack>.<name>` and load onto its own parameter keys. */
export const SPACE_USE_RATE_POINT = defineExtensionPoint<SpaceUseRateTarget>({
  id: "library.space_use_rate",
  version: 1,
  label: "Space-use rates",
  idOf: (t) => t.key,
  builtins: () => SPACE_USE_RATE_KEYS.map((key) => ({ key, ...SPACE_USE_RATE_TARGETS[key] })),
});

/** Every rate key of the pack set in force, built-ins first, by key. */
export function spaceUseRateTargets(): Readonly<Record<string, SpaceUseRateTarget>> {
  const set = activePackSet();
  return set.memo("library.space_use_rate.table", () => Object.fromEntries(set.items(SPACE_USE_RATE_POINT).map((t) => [t.key, t])));
}

/** A rate key's target in the pack set in force, or null for a key nobody registered. */
export function spaceUseRateTarget(key: string): SpaceUseRateTarget | null {
  return spaceUseRateTargets()[key] ?? null;
}

const RATE_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9][a-z0-9_]*)?$/;

const citation = z
  .object({
    /** "IMC", "ASHRAE 62.1", "NEC", "IBC", "IPC". */
    code: z.string().trim().min(1).max(40),
    edition: z.string().trim().max(20).nullable(),
    /** "Table 403.3.1.1", "Table 220.12". */
    clause: z.string().trim().min(1).max(80),
    /** False until checked against a code library record. */
    verified: z.boolean(),
  })
  .strict();

const rate = z
  .object({
    key: z.string().max(64).regex(RATE_KEY_PATTERN),
    value: z.number().finite().min(0).max(100_000),
    /** In the code's own unit: "cfm/occ", "cfm/ft2", "VA/ft2". */
    unit: z.string().trim().min(1).max(20),
    cite: citation,
    /** Other codes that print the same value (ASHRAE 62.1 for an IMC ventilation rate). */
    alsoCites: z.array(citation).max(5).optional(),
  })
  .strict();

export const spaceUseRowSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,79}$/),
    revision: z.number().int().min(1).max(1_000_000),
    name: z.string().trim().min(1).max(120),
    /** For grouping the picker: "Food and beverage", "Offices". */
    category: z.string().trim().min(1).max(60),
    /** Default occupant density, people per 1,000 ft² (IMC / ASHRAE 62.1 tables print it this way). */
    occupantsPer1000Ft2: z.object({ value: z.number().finite().min(0).max(1000), cite: citation }).strict().optional(),
    rates: z.array(rate).max(20),
    /** IBC Table 1004.5 occupant load factor, ft² per occupant, gross or net (egress; not ventilation). */
    occupantLoadFactor: z.object({ ft2PerOccupant: z.number().finite().positive().max(10_000), area: z.enum(["gross", "net"]), cite: citation }).strict().optional(),
    /** IBC / IPC occupancy group the row usually falls in ("A-2", "B"), for fixture counts. */
    occupancy: z.object({ group: z.string().trim().min(1).max(10), cite: citation }).strict().optional(),
    note: z.string().trim().max(400).optional(),
    /** Design pressure relative to its neighbours (the pressurization balance's target). Not a rate: pinning ignores it, so adding it changes no revision. */
    pressure: z.object({ target: z.enum(["negative", "positive", "neutral"]), why: z.string().trim().min(1).max(200), cite: citation }).strict().optional(),
  })
  .strict()
  .superRefine((row, ctx) => {
    row.rates.forEach((r, i) => {
      const target = spaceUseRateTarget(r.key);
      if (!target) {
        ctx.addIssue({ code: "custom", path: ["rates", i, "key"], message: `no rate "${r.key}" is defined (built-in: ${SPACE_USE_RATE_KEYS.join(", ")}; or an add-on's)` });
        return;
      }
      if (!unitAllowed(target.kind, r.unit)) ctx.addIssue({ code: "custom", path: ["rates", i, "unit"], message: `${r.unit} isn't a unit for ${target.label.toLowerCase()}` });
    });
  });

export type SpaceUseRow = z.infer<typeof spaceUseRowSchema>;
export type SpaceUseCitation = z.infer<typeof citation>;

/** A pack's rate on a use it doesn't own (a live load on the built-in office row): the row gains it inside the pack's scope. */
export interface SpaceUseRateValue {
  readonly useId: string;
  /** The pack's rate key (`SPACE_USE_RATE_POINT`). */
  readonly key: string;
  readonly value: number;
  /** In the code's own unit ("psf"). */
  readonly unit: string;
  readonly cite: SpaceUseCitation;
}

/** Rates on existing uses (v1). Id `<key>.<useId>` (`struct.live_load.office_space`): one value per rate key per use. */
export const SPACE_USE_RATE_VALUE_POINT = defineExtensionPoint<SpaceUseRateValue>({
  id: "library.space_use_rate_value",
  version: 1,
  label: "Space-use rate values",
  idOf: (v) => `${v.key}.${v.useId}`,
  builtins: () => [],
});

const imc = (clause = "Table 403.3.1.1"): SpaceUseCitation => ({ code: "IMC", edition: "2021", clause, verified: false });
const ashrae = (): SpaceUseCitation => ({ code: "ASHRAE 62.1", edition: "2019", clause: "Table 6-1", verified: false });
const nec = (clause = "Table 220.12"): SpaceUseCitation => ({ code: "NEC", edition: "2020", clause, verified: false });
const ibc = (): SpaceUseCitation => ({ code: "IBC", edition: "2021", clause: "Table 1004.5", verified: false });
const ipc = (): SpaceUseCitation => ({ code: "IPC", edition: "2021", clause: "Table 403.1", verified: false });
const kitchenVentilation = (): SpaceUseCitation => ({ code: "ASHRAE Handbook—HVAC Applications", edition: "2019", clause: "Ch. 34, Kitchen Ventilation", verified: false });
const firmPractice = (): SpaceUseCitation => ({ code: "PermitZIP design criteria", edition: null, clause: "pressurization", verified: false });

const oa = (rp: number, ra: number) => [
  { key: "outdoor_air_people" as const, value: rp, unit: "cfm/occ", cite: imc(), alsoCites: [ashrae()] },
  { key: "outdoor_air_area" as const, value: ra, unit: "cfm/ft2", cite: imc(), alsoCites: [ashrae()] },
];
const light = (va: number) => ({ key: "lighting" as const, value: va, unit: "VA/ft2", cite: nec() });

/**
 * The built-in rows. Rates are the published 2021 IMC Table 403.3.1.1 values
 * (which match ASHRAE 62.1-2019 Table 6-1 for these rows), NEC 2020 Table
 * 220.12 unit lighting loads, IBC 2021 Table 1004.5 factors. None is marked
 * verified: no code library record for these tables exists in the repo yet.
 */
export const BUILTIN_SPACE_USES: readonly SpaceUseRow[] = [
  {
    id: "restaurant_dining",
    revision: 1,
    name: "Restaurant dining rooms",
    category: "Food and beverage",
    occupantsPer1000Ft2: { value: 70, cite: imc() },
    rates: [...oa(7.5, 0.18), light(1.5)],
    occupantLoadFactor: { ft2PerOccupant: 15, area: "net", cite: ibc() },
    occupancy: { group: "A-2", cite: ipc() },
    pressure: { target: "positive", why: "dining rooms are kept slightly positive so air moves toward the kitchen, not into the dining room.", cite: kitchenVentilation() },
  },
  {
    id: "kitchen_cooking",
    revision: 1,
    name: "Kitchens (cooking)",
    category: "Food and beverage",
    occupantsPer1000Ft2: { value: 20, cite: imc() },
    rates: [...oa(7.5, 0.12), light(1.5)],
    occupantLoadFactor: { ft2PerOccupant: 200, area: "gross", cite: ibc() },
    occupancy: { group: "A-2", cite: ipc() },
    note: "Kitchen hood exhaust is sized from the appliances (IMC 507), not from this row.",
    pressure: { target: "negative", why: "kitchens are kept negative to the dining room so cooking odours and grease-laden air stay in the kitchen.", cite: kitchenVentilation() },
  },
  {
    id: "bar_cocktail",
    revision: 1,
    name: "Bars, cocktail lounges",
    category: "Food and beverage",
    occupantsPer1000Ft2: { value: 100, cite: imc() },
    rates: [...oa(7.5, 0.18), light(1.5)],
    occupancy: { group: "A-2", cite: ipc() },
    pressure: { target: "positive", why: "bars and lounges are kept slightly positive, like dining rooms.", cite: firmPractice() },
  },
  {
    id: "office_space",
    revision: 1,
    name: "Office space",
    category: "Offices",
    occupantsPer1000Ft2: { value: 5, cite: imc() },
    rates: [...oa(5, 0.06), light(1.3), { key: "receptacles", value: 1, unit: "VA/ft2", cite: nec("220.14(K)") }],
    occupantLoadFactor: { ft2PerOccupant: 150, area: "gross", cite: ibc() },
    occupancy: { group: "B", cite: ipc() },
  },
  {
    id: "conference_meeting",
    revision: 1,
    name: "Conference and meeting rooms",
    category: "Offices",
    occupantsPer1000Ft2: { value: 50, cite: imc() },
    rates: [...oa(5, 0.06), light(1.3)],
    occupantLoadFactor: { ft2PerOccupant: 15, area: "net", cite: ibc() },
    occupancy: { group: "B", cite: ipc() },
  },
  {
    id: "retail_sales",
    revision: 1,
    name: "Retail sales floor",
    category: "Retail",
    occupantsPer1000Ft2: { value: 15, cite: imc() },
    rates: [...oa(7.5, 0.12), light(1.9)],
    occupantLoadFactor: { ft2PerOccupant: 60, area: "gross", cite: ibc() },
    occupancy: { group: "M", cite: ipc() },
  },
  {
    id: "classroom_9_plus",
    revision: 1,
    name: "Classrooms (age 9 and over)",
    category: "Education",
    occupantsPer1000Ft2: { value: 35, cite: imc() },
    rates: [...oa(10, 0.12), light(1.5)],
    occupantLoadFactor: { ft2PerOccupant: 20, area: "net", cite: ibc() },
    occupancy: { group: "E", cite: ipc() },
  },
  {
    id: "corridor",
    revision: 1,
    name: "Corridors",
    category: "Support",
    rates: [{ key: "outdoor_air_area", value: 0.06, unit: "cfm/ft2", cite: imc() }],
  },
  {
    id: "storage",
    revision: 1,
    name: "Storage rooms",
    category: "Support",
    rates: [{ key: "outdoor_air_area", value: 0.12, unit: "cfm/ft2", cite: imc() }, light(0.25)],
    occupantLoadFactor: { ft2PerOccupant: 300, area: "gross", cite: ibc() },
    occupancy: { group: "S-1", cite: ipc() },
  },
  {
    id: "toilet_public",
    revision: 1,
    name: "Toilet rooms (public)",
    category: "Support",
    rates: [],
    note: "Exhaust is per water closet and urinal (IMC Table 403.3.1.1: 50 / 70 cfm per fixture), not per area; add it as a count load on the fixtures.",
    pressure: { target: "negative", why: "toilet rooms are exhausted and kept negative so odours don't leave them.", cite: imc() },
  },
];

for (const row of BUILTIN_SPACE_USES) spaceUseRowSchema.parse(row);

/** Space uses (v1). A pack's row ids are `<pack>.<name>`; built-in ids are bare. */
export const SPACE_USE_POINT = defineExtensionPoint<SpaceUseRow>({
  id: "library.space_use",
  version: 1,
  label: "Space uses",
  idOf: (row) => row.id,
  builtins: () => BUILTIN_SPACE_USES,
});

export interface SpaceUseCatalog {
  readonly libraryId: string;
  readonly rows: readonly SpaceUseRow[];
  get(id: string): SpaceUseRow | undefined;
}

export interface SpaceUseLayerIssue {
  /** The firm row's index; -1 for an add-on's rate value. */
  readonly index: number;
  readonly message: string;
}

/**
 * The built-in rows (and the pack set in force's) with a firm's layered on: same id replaces, a new id adds.
 * Firm rows that don't validate are left out and reported, never half-applied.
 */
export function spaceUseCatalog(firmRows: readonly unknown[] = [], libraryId = SPACE_USE_LIBRARY_ID): { readonly catalog: SpaceUseCatalog; readonly issues: readonly SpaceUseLayerIssue[] } {
  const byId = new Map<string, SpaceUseRow>(activePackSet().items(SPACE_USE_POINT).map((r) => [r.id, r]));
  const issues: SpaceUseLayerIssue[] = [];
  firmRows.forEach((raw, index) => {
    const parsed = spaceUseRowSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      issues.push({ index, message: `Row ${index + 1}: ${first ? `${first.path.join(".")} ${first.message}` : "isn't a space use"}` });
      return;
    }
    byId.set(parsed.data.id, parsed.data);
  });
  for (const v of activePackSet().packItems(SPACE_USE_RATE_VALUE_POINT)) {
    const row = byId.get(v.useId);
    if (!row) {
      issues.push({ index: -1, message: `An add-on gives ${v.key} for the space use "${v.useId}", which this library doesn't have` });
      continue;
    }
    if (row.rates.some((r) => r.key === v.key)) continue;
    const target = spaceUseRateTarget(v.key);
    if (!target || !unitAllowed(target.kind, v.unit)) {
      issues.push({ index: -1, message: `An add-on's ${v.key} for ${row.name} is in "${v.unit}", which isn't a unit for ${target ? target.label.toLowerCase() : "a rate this library knows"}` });
      continue;
    }
    byId.set(row.id, { ...row, rates: [...row.rates, { key: v.key, value: v.value, unit: v.unit, cite: v.cite }] });
  }
  const rows = [...byId.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { catalog: { libraryId, rows, get: (id) => byId.get(id) }, issues };
}

export interface SpaceUsePressureTarget {
  readonly target: "negative" | "positive" | "neutral";
  /** "kitchens are kept negative … (ASHRAE Handbook—HVAC Applications 2019 Ch. 34, Kitchen Ventilation, not verified)". */
  readonly why: string;
}

/** A use's design pressure by row id, as the pressurization balance takes it; null when the row has none. */
export function spaceUsePressureTarget(catalog: SpaceUseCatalog, useId: string): SpaceUsePressureTarget | null {
  const p = catalog.get(useId)?.pressure;
  if (!p) return null;
  const cite = `${p.cite.code}${p.cite.edition ? ` ${p.cite.edition}` : ""} ${p.cite.clause}${p.cite.verified ? "" : ", not verified"}`;
  return { target: p.target, why: `${p.why} (${cite})` };
}
