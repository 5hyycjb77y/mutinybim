import { z } from "zod";
import { CONDUCTOR_MATERIALS, catalogEntryOf, catalogKey, catalogRecords, elementValues, serviceLinkName, type BimElement, type CatalogEntryTypeRow, type CatalogEntryUse, type ConductorSet, type ModelState, type ServiceLink } from "@permitzip/bim-kernel";

/**
 * Feeder types (moved from the kernel's catalog in round 12, stored bytes
 * unchanged): a feeder mark ("F225", "F100T") with its breaker, conductor
 * sets, ground and conduit. Feeders name it (`feederType` on the link); its
 * conductors are the feeder's unless the feeder has its own. Stored type
 * `feeder_type`, ids `etype:feeder:<MARK>`.
 */

type Elements = Readonly<Record<string, BimElement>>;

const text = (max: number) => z.string().trim().max(max);
const key = (max: number) => z.string().trim().min(1).max(max);

const conductorSchema = z.object({
  sets: z.number().int().min(1).max(20),
  phaseSize: key(12),
  neutralSize: key(12).optional(),
  groundSize: key(12).optional(),
  material: z.enum(CONDUCTOR_MATERIALS),
});

const raceway = z.object({
  /** "emt", "pvc40", "pvc80", or what the engineer writes ("RMC"). */
  type: key(12),
  /** Trade size as written: "2-1/2". */
  tradeSize: key(12),
});
export type FeederRaceway = z.infer<typeof raceway>;

export const feederTypeSchema = z.object({
  type: z.literal("feeder_type"),
  /** The mark drawn in the feeder oval and printed in the feeder schedule ("F225"). */
  mark: key(20),
  /** Overcurrent device trip, amps. */
  ratingA: z.number().positive().max(10_000),
  poles: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  conductors: conductorSchema,
  /** Conductor insulation as written ("THHN", "XHHW-2"). */
  insulation: key(12),
  /** Raceway above grade (one per set). */
  conduit: raceway.nullable(),
  /** Raceway below grade, when it differs. */
  conduitBelowGrade: raceway.nullable(),
  description: text(160),
  /** Where the sizes came from: the code calc that proposed them (with its clauses), or the engineer. */
  basis: z
    .object({
      source: z.enum(["calc", "engineer"]),
      text: text(400),
      cite: z.array(text(160)).max(16),
    })
    .optional(),
});
export type FeederTypeEntry = z.infer<typeof feederTypeSchema>;

export function feederTypeOf(elements: Elements, mark: string): FeederTypeEntry | null {
  return catalogEntryOf(elements, "feeder_type", mark);
}

export const feederTypes = (model: Pick<ModelState, "elements">) => catalogRecords(model, "feeder_type");

/** As drawings write sizes: "#4/0", "250 kcmil". */
const wire = (size: string) => (/^\d+$/.test(size) && Number(size) >= 250 ? `${size} kcmil` : `#${size}`);

/** Conductors as a feeder schedule prints them: "(2) sets of 4-#350, 1-#2 EGC Cu THHN". `hots` is how many hot conductors (poles). */
export function conductorText(c: ConductorSet, hots: number, insulation?: string): string {
  const neutral = c.neutralSize ? `, 1-${wire(c.neutralSize)} N` : "";
  const ground = c.groundSize ? `, 1-${wire(c.groundSize)} EGC` : "";
  return `${c.sets > 1 ? `(${c.sets}) sets of ` : ""}${hots}-${wire(c.phaseSize)}${neutral}${ground} ${c.material === "cu" ? "Cu" : "Al"}${insulation ? ` ${insulation}` : ""}`;
}

const CONDUIT_LABELS: Readonly<Record<string, string>> = { emt: "EMT", pvc40: "PVC Sch 40", pvc80: "PVC Sch 80" };

/** "2-1/2 in EMT". */
export function racewayText(r: { readonly type: string; readonly tradeSize: string }): string {
  return `${r.tradeSize} in ${CONDUIT_LABELS[r.type.toLowerCase()] ?? r.type}`;
}

/** A feeder type as one schedule line: "225 A 3P; 4-#4/0, 1-#4 EGC Cu THHN in 2-1/2 in EMT (each); below grade 3 in PVC Sch 40". */
export function feederTypeText(entry: FeederTypeEntry): string {
  const each = entry.conductors.sets > 1 ? " each" : "";
  const above = entry.conduit ? ` in ${racewayText(entry.conduit)}${each}` : "";
  const below = entry.conduitBelowGrade ? `; below grade ${racewayText(entry.conduitBelowGrade)}${each}` : "";
  return `${entry.ratingA} A ${entry.poles}P; ${conductorText(entry.conductors, entry.poles, entry.insulation)}${above}${below}`;
}

/** A feeder type as schedules, tags and the one-line read it (the shape a link-type catalog row returns). */
export interface FeederTypeScheduleRecord {
  readonly mark: string;
  readonly description?: string;
  readonly conductors?: ConductorSet;
  /** "3 in PVC Sch 40". */
  readonly conduitBelowGrade?: string;
  readonly conduitAboveGrade?: string;
  readonly ratingA: number;
  readonly poles: 1 | 2 | 3;
  readonly insulation: string;
  /** `feederTypeText`: the whole line. */
  readonly text: string;
}

const scheduleCache = new WeakMap<object, readonly FeederTypeScheduleRecord[]>();

/** Every feeder type in the catalog, in mark order, as schedules print it. Cached per model state. */
export function feederTypeScheduleRecords(elements: Elements): readonly FeederTypeScheduleRecord[] {
  const known = scheduleCache.get(elements);
  if (known) return known;
  const out = feederTypes({ elements }).map(({ entry: e }) => ({
    mark: e.mark,
    ...(e.description ? { description: e.description } : {}),
    conductors: e.conductors,
    ...(e.conduitBelowGrade ? { conduitBelowGrade: racewayText(e.conduitBelowGrade) } : {}),
    ...(e.conduit ? { conduitAboveGrade: racewayText(e.conduit) } : {}),
    ratingA: e.ratingA,
    poles: e.poles,
    insulation: e.insulation,
    text: feederTypeText(e),
  }));
  scheduleCache.set(elements, out);
  return out;
}

/** What a feeder or circuit is built with: its own conductors, else its feeder type's. */
export interface LinkConstruction {
  readonly conductors: ConductorSet | null;
  /** Where the conductors came from. */
  readonly conductorsFrom: "link" | "feeder_type" | null;
  /** The feeder type the link names, when the catalog has it. */
  readonly feederType: FeederTypeEntry | null;
  /** A mark the link names that the catalog doesn't have. */
  readonly missingFeederType: string | null;
}

export function linkConstruction(elements: Elements, link: ServiceLink): LinkConstruction {
  const e = link.electrical;
  const mark = e?.feederType ?? null;
  const ft = mark ? feederTypeOf(elements, mark) : null;
  const own = e?.conductors ?? null;
  return {
    conductors: own ?? ft?.conductors ?? null,
    conductorsFrom: own ? "link" : ft ? "feeder_type" : null,
    feederType: ft,
    missingFeederType: mark && !ft ? mark : null,
  };
}

/** Feeders name a feeder type by mark on the link. */
function feedersNaming(elements: Elements, key: string): CatalogEntryUse[] {
  const out: CatalogEntryUse[] = [];
  for (const el of elementValues(elements)) {
    if (el.kind === "service_link" && el.electrical?.feederType && catalogKey(el.electrical.feederType) === key) out.push({ id: el.id, name: serviceLinkName(elements, el) });
  }
  return out;
}

export const FEEDER_TYPE_ROW: CatalogEntryTypeRow = {
  type: "feeder_type",
  idPrefix: "feeder",
  label: "Feeder type",
  schema: feederTypeSchema,
  nameOf: (entry) => {
    const mark = (entry as { readonly mark?: unknown }).mark;
    return typeof mark === "string" ? mark : "";
  },
  summary: (entry) => {
    const parsed = feederTypeSchema.safeParse(entry);
    return parsed.success ? feederTypeText(parsed.data) : "";
  },
  trade: () => "electrical",
  references: {
    plural: "feeders",
    find: feedersNaming,
    rename: (el, name) => (el.kind === "service_link" && el.electrical ? { element: { ...el, electrical: { ...el.electrical, feederType: name } } } : null),
  },
};
