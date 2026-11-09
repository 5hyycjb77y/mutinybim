import type { Quantity } from "@permitzip/bim-units";
import type { BimElement, ElementId } from "../types";
import { defineExtensionPoint } from "../packs/contract";
import { activePackSet } from "../packs/scope";

/**
 * The outdoor-air reader contract (`kernel.outdoor_air_reader`, contract
 * 1.3.0): the result shape a ventilation engine returns for a space and a
 * zone, and the point a pack contributes the engine at. Kept in the kernel
 * because the contract names it (every pack, and `@permitzip/bim-pack`'s
 * conformance, reads the same point); the engine, the fields that print it
 * and the table live in the Mechanical add-on.
 */

export const VENTILATION_STANDARD_IDS = ["imc", "ashrae_62_1"] as const;
export type VentilationStandardId = (typeof VENTILATION_STANDARD_IDS)[number];

export interface VentilationCite {
  /** "IMC", "ASHRAE 62.1". */
  readonly code: string;
  readonly edition: string | null;
  /** "403.3.1.1.1, Equation 4-1". */
  readonly clause: string;
  /** False until checked against a code library record. */
  readonly verified: boolean;
  /** One line a person reads: "IMC 2021 403.3.1.1.1, Equation 4-1 (not verified)". */
  readonly text: string;
}

/** A value with where it came from: the library row, a default, or a typed override (with its reason). */
export interface VentilationInput<K extends "airflow_per_person" | "airflow_per_area" | "ratio"> {
  readonly value: Quantity<K>;
  readonly from: "library" | "pinned" | "default" | "override";
  readonly reason?: string;
  readonly cite: VentilationCite;
}

/**
 * One standard's answer for one space. `ok`: every number below is set.
 * `not_required`: the use's row gives no outdoor air rate (toilet rooms: exhaust only).
 * `missing`: an input is missing; `reasons` says which, in words. Never a silent zero.
 */
export interface SpaceStandardVentilation {
  readonly standard: VentilationStandardId;
  /** "IMC 2021", "ASHRAE 62.1-2019". */
  readonly label: string;
  readonly status: "ok" | "not_required" | "missing";
  readonly reasons: readonly string[];
  readonly rp: VentilationInput<"airflow_per_person"> | null;
  readonly ra: VentilationInput<"airflow_per_area"> | null;
  readonly ez: VentilationInput<"ratio">;
  /** Breathing-zone outdoor air, Rp·Pz + Ra·Az. */
  readonly vbz: Quantity<"flow_air"> | null;
  /** Zone outdoor air, Vbz / Ez. */
  readonly voz: Quantity<"flow_air"> | null;
  /** Required exhaust from the use's area rate; null with `exhaustReason` when the row has none. */
  readonly exhaust: Quantity<"flow_air"> | null;
  readonly exhaustReason: string | null;
  /** "Vbz = 7.5 cfm/person × 70 + 0.18 cfm/ft² × 1,000 ft² = 705 cfm". */
  readonly arithmetic: string | null;
  readonly cites: readonly VentilationCite[];
}

export interface GoverningStandard {
  readonly standard: VentilationStandardId;
  readonly from: "asked" | "project" | "state" | "default";
  /** "IMC 2021 governs (Virginia Mechanical Code, the project's Code Study)". */
  readonly text: string;
}

export interface SpaceVentilation {
  readonly spaceId: ElementId;
  /** "101 Dining". */
  readonly label: string;
  readonly useName: string | null;
  readonly areaM2: number | null;
  readonly occupants: number | null;
  readonly occupantsBasis: "typed" | "use_default" | null;
  readonly standards: Readonly<Record<VentilationStandardId, SpaceStandardVentilation>>;
  readonly governing: GoverningStandard;
  /** Every input the result read, in words ("area 1,000 ft² from the outline", "use Restaurant dining rooms rev 1"). */
  readonly inputs: readonly string[];
}

export interface ZoneStandardVentilation {
  readonly standard: VentilationStandardId;
  readonly label: string;
  /** Σ Voz of the zone's spaces; null when any space can't be calculated (never a partial sum printed as the total). */
  readonly voz: Quantity<"flow_air"> | null;
  readonly exhaust: Quantity<"flow_air"> | null;
  readonly missing: readonly { readonly spaceId: ElementId; readonly label: string; readonly reason: string }[];
}

export interface ZoneServingUnit {
  readonly id: ElementId;
  readonly mark: string;
  /** The unit's outdoor air (its `outdoor_cfm` parameter), when typed. */
  readonly outdoorAir: Quantity<"flow_air"> | null;
  /** Zones this unit serves. More than one: a multiple-zone system (see `systemNote`). */
  readonly zoneCount: number;
  readonly comparison: "meets" | "short" | "unknown";
}

export interface ZoneVentilation {
  readonly zoneId: ElementId;
  readonly name: string;
  readonly spaceIds: readonly ElementId[];
  readonly standards: Readonly<Record<VentilationStandardId, ZoneStandardVentilation>>;
  readonly governing: GoverningStandard;
  readonly servedBy: ZoneServingUnit | null;
  /** "Single-zone system: Vot = Voz (IMC 403.3.1.1.2.3.1)" or "multi-zone system efficiency not calculated yet". */
  readonly systemNote: string;
}

type Elements = Readonly<Record<string, BimElement>>;

/** What computes the results. `@permitzip/bim-calc` registers one when it loads its ventilation pack. */
export interface VentilationReader {
  /** "bim-calc ventilation 1.0.0 (IMC 2021, ASHRAE 62.1-2019)". */
  readonly id: string;
  space(elements: Elements, spaceId: ElementId): SpaceVentilation | null;
  zone(elements: Elements, zoneId: ElementId): ZoneVentilation | null;
}

/**
 * Outdoor-air readers (v1): what computes the results for a model, from the
 * pack that owns them (the Mechanical pack contributes bim-calc's engine). No
 * `idOf`: a reader's id is a version string. The last row in set order is
 * in force, so a model's own pack overrides the first-party engine.
 */
export const OUTDOOR_AIR_READER_POINT = defineExtensionPoint<VentilationReader>({ id: "kernel.outdoor_air_reader", version: 1, label: "Outdoor-air readers" });

/** The reader in force for the set in force, or null when no pack in it contributes one. */
export function registeredVentilationReader(): VentilationReader | null {
  return activePackSet().items(OUTDOOR_AIR_READER_POINT).at(-1) ?? null;
}


export const VENTILATION_NOT_LOADED = "The ventilation pack isn't loaded in this process, so outdoor air can't be calculated here.";
