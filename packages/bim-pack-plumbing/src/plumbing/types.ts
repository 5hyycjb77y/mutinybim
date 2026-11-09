import type { AuthoredRevisions, ElementId, Partition } from "@permitzip/bim-kernel";

/**
 * The few things a person says about a vertical run that the drawn pipe can't:
 * its number, its name, and overrides of the system letter and rooms-served
 * code its tag prints. Everything else (floors, sizes, running DFU, offsets,
 * rooms served) is derived from the pipe every time it is read (stacks.ts), so
 * there is nothing to keep in step when the pipe changes.
 *
 * Kind `vertical_run`, role `stack` today. A duct shaft or an electrical riser
 * is the same record with another role and another filter in chains.ts; that
 * is why the kind isn't called "stack".
 *
 * One more record of the same kind (role `settings`, id
 * `VERTICAL_RUN_SETTINGS_ID`) holds the project's stack checks, like the one
 * `organization` settings record holds the active group and phase.
 */

export const VERTICAL_RUN_ROLES = ["stack"] as const;
export type VerticalRunRole = (typeof VERTICAL_RUN_ROLES)[number];

interface VerticalRunBase {
  readonly id: ElementId;
  readonly kind: "vertical_run";
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly partition?: Partition;
}

export interface NamedVerticalRun extends VerticalRunBase {
  readonly role: VerticalRunRole;
  /** What the drawings call it ("19"). Unique among stacks. */
  readonly number: string;
  /** Optional words ("Kitchen stack"). */
  readonly name?: string;
  /** Any vertical piece of the run; the run is found from it each time it is read. */
  readonly pipeId: ElementId;
  /** Overrides the system letter the tag prints ("S"); absent: from the pipe system. */
  readonly systemCode?: string;
  /** Overrides the rooms-served code the tag prints ("K/L"); absent: from the rooms its branches reach. */
  readonly serves?: string;
}

export interface VerticalRunSettings extends VerticalRunBase {
  readonly role: "settings";
  /**
   * The base-of-stack check (STATUS decision 10): no branch may join within
   * this many pipe diameters of a stack's base bend or an offset bend. Null: off,
   * the default until it is confirmed as code where the firm works.
   */
  readonly baseClearanceDiameters: number | null;
}

export type VerticalRunElement = NamedVerticalRun | VerticalRunSettings;

export const VERTICAL_RUN_SETTINGS_ID = "vertical-run-settings" as ElementId;

/** The firm rule from Plumbing Demo 2 (11:35): 3 pipe diameters from the bend. What "turn it on" sets. */
export const FIRM_STACK_BASE_DIAMETERS = 3;
