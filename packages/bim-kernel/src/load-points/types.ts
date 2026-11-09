import type { QuantityBag } from "../quantities";
import type { AuthoredRevisions, ElementId, Partition } from "../types";
import type { LoadLifecycleFields } from "../requirements/types";

/**
 * A load point: a connection ("nub") on an open pipe end or a duct/pipe tap
 * that says what is connected there without a modelled fixture. It names a
 * connection type (P01 "Water closet, flush tank") and may override its
 * values. A fixture placed later can be attached; it then names the same
 * connection type and its plumbing values are this record (one record, two
 * views).
 *
 * A point placed on a pipe end before Oct 2026 has the id "lp:<run element>:<end
 * or port>". That id is a name, not an address: the load can move and keep it,
 * and new loads get ids from their sender. The run graph finds the load on an
 * end through the load index (requirements/load-index.ts); a host holds at most
 * one (the commands keep that rule). On a pipe it has no position of its own:
 * it is drawn where the host's end or port is, so it follows the pipe when the
 * pipe moves or stretches. When the host is deleted the load point stays and
 * is flagged as having lost its pipe (validate), so its loads and fixture link
 * are not lost silently; it counts nowhere until re-placed or deleted.
 */
export interface LoadPointHost {
  /** A run segment or a run fitting (tap, tee, wye). */
  readonly elementId: ElementId;
  /** A segment's "start" / "end", or a fitting's port id ("branch"). */
  readonly port: string;
}

/**
 * Since Oct 2026 this record is also the one load concept for every trade:
 * an estimate on a space, a concentrated load point, or a device's load
 * (requirements/types.ts). The lifecycle fields are optional, so every
 * existing record reads exactly as before.
 */
export interface LoadPointElement extends LoadLifecycleFields {
  readonly id: ElementId;
  readonly kind: "load_point";
  readonly version: number;
  readonly authoredRev: AuthoredRevisions;
  readonly partition?: Partition;
  readonly groupId?: string;
  readonly phaseCreated?: string;
  readonly phaseDemolished?: string;
  /**
   * The run end it sits on. Every record written before anchors existed has it;
   * a load on a run end is still stored this way (no `anchor`). Absent: the load
   * is wherever `anchor` says (a row, a space, a point, a part). Read the place
   * with `loadAnchorOf` / `runEndOf` (requirements/anchor.ts), never this field.
   */
  readonly host?: LoadPointHost;
  /** The connection type designator ("P01"); "" for a point that only carries its own values. */
  readonly connectionType: string;
  /** Values that differ from the connection type's (a kitchen lump of 30 DFU). */
  readonly values: QuantityBag;
  /**
   * The fixture this point stands for ("P01-1"). A fixture's cold and hot
   * points share a mark, so the pipe that carries both counts the fixture's
   * total water fixture units (not cold + hot). An attached part's id pairs
   * them too.
   */
  readonly mark?: string;
  readonly attachedPartId?: ElementId;
  /**
   * The part connector serving this load directly, end to end with no run
   * (`join_parts`): its requirement is carried through that connector as a
   * run end carries it. Absent: served by its run end, or not connected yet.
   */
  readonly joinedTo?: LoadPointHost;
  /** A schematic lump ("whole kitchen") to be broken out later. */
  readonly schematic?: boolean;
  readonly note?: string;
}
