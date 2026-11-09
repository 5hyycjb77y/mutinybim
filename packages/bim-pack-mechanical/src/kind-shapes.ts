import { add as kernelAdd, scale as kernelScale, sub as kernelSub, unit as kernelUnit, type BimElement, type ConnectorEnd, type ConnectorEndsFace, type ElementKindItem, type ElementKindShapeFace, type Vec2 } from "@permitzip/bim-kernel";

// Bound once: re-exported functions can compile to getters, too slow for every connection end a full check places.
const add = kernelAdd;
const scale = kernelScale;
const sub = kernelSub;
const unit = kernelUnit;

/**
 * The stored shape, connector ends and placement of the five kinds this
 * add-on owns (contract 1.8.0 faces on `ELEMENT_KIND_POINT`), which the
 * kernel's network index, topology and `anchorOf` read. Stored records keep
 * the shape every peer has written since round 1.
 *
 * A unit starts a tree at its out port; a duct runs start → end; a tap hangs
 * on its host duct (`hostId`) and leads out its branch; an elbow runs
 * in → out; a terminal ends a branch at its in.
 */

const midpoint = (a: Vec2, b: Vec2): Vec2 => scale(add(a, b), 0.5);

const UNIT_SHAPE: ElementKindShapeFace = {
  fields: [
    { name: "mark", form: "text" },
    { name: "typeName", form: "text" },
    { name: "position", form: "point" },
    { name: "size", form: "size" },
    { name: "portOffset", form: "point" },
  ],
  points: (el) => (el.kind === "equipment" ? [el.position] : []),
};

const UNIT_ENDS: ConnectorEndsFace = {
  root: true,
  ends: [{ end: "out", role: "downstream" }],
  point: (el) => (el.kind === "equipment" ? add(el.position, el.portOffset) : null),
};

const SEGMENT_SHAPE: ElementKindShapeFace = {
  fields: [
    { name: "start", form: "point" },
    { name: "end", form: "point" },
    { name: "profile", form: "size" },
  ],
  points: (el) => (el.kind === "duct_segment" ? [el.start, el.end] : []),
};

const SEGMENT_ENDS: ConnectorEndsFace = {
  ends: [
    { end: "start", role: "upstream" },
    { end: "end", role: "downstream" },
  ],
  point: (el, end: ConnectorEnd) => (el.kind === "duct_segment" ? (end === "start" ? el.start : el.end) : null),
};

const TAP_SHAPE: ElementKindShapeFace = {
  fields: [
    { name: "hostId", form: "id" },
    { name: "s", form: "number" },
    { name: "side", form: "number" },
    { name: "profile", form: "size" },
    { name: "position", form: "point" },
  ],
  points: (el) => (el.kind === "tap" ? [el.position] : []),
};

const TAP_ENDS: ConnectorEndsFace = {
  // Placed along its host by `s` and `side`; the derived connector position is kept in `position`.
  hostedBy: { field: "hostId", placement: { along: "s", side: "side", at: "position" } },
  ends: [
    { end: "host", role: "upstream" },
    { end: "branch", role: "downstream" },
  ],
  point: (el, end, elements) => {
    if (el.kind !== "tap") return null;
    if (end === "branch") return el.position;
    const host = elements[el.hostId];
    if (!host || host.kind !== "duct_segment") return el.position;
    return add(host.start, scale(unit(sub(host.end, host.start)), el.s));
  },
};

const ELBOW_SHAPE: ElementKindShapeFace = {
  fields: [
    { name: "position", form: "point" },
    { name: "profile", form: "size" },
  ],
  points: (el) => (el.kind === "elbow" ? [el.position] : []),
};

const ELBOW_ENDS: ConnectorEndsFace = {
  ends: [
    { end: "in", role: "upstream" },
    { end: "out", role: "downstream" },
  ],
  point: (el) => (el.kind === "elbow" ? el.position : null),
};

const TERMINAL_SHAPE: ElementKindShapeFace = {
  fields: [
    { name: "mark", form: "text" },
    { name: "typeName", form: "text" },
    { name: "position", form: "point" },
    { name: "anchored", form: "flag" },
  ],
  points: (el) => (el.kind === "terminal" ? [el.position] : []),
};

const TERMINAL_ENDS: ConnectorEndsFace = {
  ends: [{ end: "in", role: "upstream" }],
  point: (el) => (el.kind === "terminal" ? el.position : null),
};

/** Where one sits: a point kind at its position, a duct at its midpoint. */
function anchorOfOwned(el: BimElement): Vec2 | null {
  switch (el.kind) {
    case "equipment":
    case "tap":
    case "elbow":
    case "terminal":
      return el.position;
    case "duct_segment":
      return midpoint(el.start, el.end);
    default:
      return null;
  }
}

type Faces = Pick<ElementKindItem, "nature" | "shape" | "connectorEnds" | "anchor">;

/** The faces of each owned kind, by stored kind. */
export const MECHANICAL_KIND_FACES: Readonly<Record<"equipment" | "duct_segment" | "tap" | "elbow" | "terminal", Faces>> = {
  equipment: { nature: "physical", shape: UNIT_SHAPE, connectorEnds: UNIT_ENDS, anchor: anchorOfOwned },
  duct_segment: { nature: "physical", shape: SEGMENT_SHAPE, connectorEnds: SEGMENT_ENDS, anchor: anchorOfOwned },
  tap: { nature: "physical", shape: TAP_SHAPE, connectorEnds: TAP_ENDS, anchor: anchorOfOwned },
  elbow: { nature: "physical", shape: ELBOW_SHAPE, connectorEnds: ELBOW_ENDS, anchor: anchorOfOwned },
  terminal: { nature: "physical", shape: TERMINAL_SHAPE, connectorEnds: TERMINAL_ENDS, anchor: anchorOfOwned },
};
