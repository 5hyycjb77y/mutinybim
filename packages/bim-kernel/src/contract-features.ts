/**
 * Peer feature ids of contract 1.13.0 whose shapes live in files their lanes
 * own, declared here first so every peer names them the same way. Each is
 * advertised only once its writer and readers land.
 */

/** A wall's top tied to a level (with an offset) instead of a fixed height; lane A15. A peer without it is sent the height it works out to. */
export const WALLS_TOP_CONSTRAINT_FEATURE = "walls:top_constraint";

/** A wall's top or base bound to a surface (the structure above, a ceiling, a roof, the slab below) and its derived body profile. A peer without it is sent the height and offsets they work out to. */
export const WALLS_SURFACE_BINDING_FEATURE = "walls:surface_binding";

/** Bodies by class (`kernel.class_solids`): the peer draws an add-on's body for elements of its classes; lane A15. */
export const PARTS_CLASS_SOLIDS_FEATURE = "parts:class_solids";
