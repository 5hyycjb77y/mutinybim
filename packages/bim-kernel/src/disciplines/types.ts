/**
 * Disciplines as a registry (contract 1.5.0, round 8 lane D).
 *
 * A discipline is a registered row, not a closed list: the kernel ships the
 * shared rows (architecture, structure, civil, general contracting,
 * documentation, general), each first-party add-on registers its own
 * trade rows (fire protection with fire alarm under it, and so on), a
 * pack registers `<ns>.<name>` (`vt.elevators`) and a firm `firm:<slug>`
 * through its library. Stored ids are frozen: a record keeps whatever id it
 * was written with, and a reader labels an id it doesn't know from its words.
 *
 * Who is responsible for a discipline is not a property of the row. The
 * optional `defaultResponsibleRole` only suggests whom to name and which
 * role approves what no one's scope covers; the many-to-many, scoped
 * responsibility record (NEXT-BATCH-8 §8.2) says who is responsible.
 *
 * Imports only the contract, so every layer may read it.
 */
import { defineExtensionPoint } from "../packs/contract";

/** Peers that read and store any registered discipline id beyond the ten class disciplines. Implies `partition:class_disciplines`. */
export const DISCIPLINES_REGISTRY_FEATURE = "disciplines:registry";

/** A display group several disciplines share for views and staffing ("MEP"); never an approval scope by itself. */
export interface DisciplineGroup {
  /** Registry id shape, lower case (`mep`). */
  readonly id: string;
  readonly label: string;
}

export interface DisciplineDisplay {
  /** `#rrggbb`: the colour pickers, filters and linked-model tints use for it. */
  readonly colour: string;
  /** An icon name the host's icon set knows; absent: the host's default. */
  readonly icon?: string;
}

/** The IFC hint for exports: the IfcDistributionSystem / discipline name the row maps to. */
export interface DisciplineIfcHint {
  readonly systemType?: string;
  readonly name?: string;
}

export interface DisciplineDef {
  /** The stored id. Bare for built-in and first-party rows, `<ns>.<name>` for a pack, `firm:<slug>` for a firm. Frozen once stored. */
  readonly id: string;
  /** What people read ("Fire alarm"). Screens never show the raw id when a row exists. */
  readonly label: string;
  /**
   * The discipline it is a part of (`fire_alarm` under `fire_protection`).
   * A filter or responsibility on the parent covers its children unless the
   * child has its own.
   */
  readonly parent?: string;
  readonly group?: DisciplineGroup;
  readonly display: DisciplineDisplay;
  /** A role name a firm's setup suggests for this discipline ("Fire alarm engineer of record"). Only a default: never the discipline's owner. */
  readonly defaultResponsibleRole?: string;
  readonly ifc?: DisciplineIfcHint;
  /**
   * The building every discipline draws on (the kernel's shared rows): a plan
   * drawn for another discipline shows it halftone behind its own work. A
   * plan for one discipline leaves out the runs of any registered discipline
   * that is neither covered by it nor an underlay. Absent: not an underlay.
   */
  readonly underlay?: true;
}

/** The kernel's shared rows. Trade rows come from the add-ons that own them. */
const SHARED_DISCIPLINES: readonly DisciplineDef[] = Object.freeze([
  { id: "architecture", underlay: true, label: "Architecture", display: { colour: "#6b7280" }, defaultResponsibleRole: "Architect of record" },
  { id: "structure", underlay: true, label: "Structure", display: { colour: "#b45309" }, defaultResponsibleRole: "Structural engineer of record" },
  { id: "civil", underlay: true, label: "Civil", display: { colour: "#4d7c0f" }, defaultResponsibleRole: "Civil engineer of record" },
  { id: "general_contracting", underlay: true, label: "General contracting", display: { colour: "#334155" }, defaultResponsibleRole: "General contractor" },
  { id: "documentation", underlay: true, label: "Documentation", display: { colour: "#475569" } },
  { id: "general", underlay: true, label: "General", display: { colour: "#64748b" } },
]);

/**
 * Disciplines (v1), by stored id. Built-ins are the kernel's shared rows; the
 * first-party add-ons, packs and firm libraries add the rest.
 */
export const DISCIPLINE_POINT = defineExtensionPoint<DisciplineDef>({
  id: "kernel.discipline",
  version: 1,
  label: "Disciplines",
  idOf: (d) => d.id,
  builtins: () => SHARED_DISCIPLINES,
});
