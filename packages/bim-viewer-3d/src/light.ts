/**
 * The light entry (`@permitzip/bim-viewer-3d/light`): everything the Building
 * Model surface needs before the 3D view exists, with no three.js, That Open,
 * camera-controls or web-ifc behind it. The root entry stays the full viewer
 * and keeps exporting all of this; the surface loads it with a dynamic import.
 *
 * Only add modules whose own import graph is three-free. The r5u first-chunk
 * test walks this file and fails if a three.js import appears behind it.
 */
export * from "./coords";
export * from "./native-geometry";
export * from "./live-view";
export * from "./orientation";
export * from "./framing";
export * from "./box-select";
export * from "./projection-kinds";
export * from "./plan-snap";
export * from "./reference-tone-plan";
export * from "./pan-buttons";
export * from "./wheel-zoom";
