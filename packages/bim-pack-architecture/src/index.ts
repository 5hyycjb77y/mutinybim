/**
 * `@permitzip/bim-pack-architecture`: the Architecture add-on (namespace
 * `architecture`, first-party). Grids, walls, doors, windows, openings,
 * floors, ceilings, roofs, columns and stairs with their types, built only
 * through the add-on contract; the kernel imports nothing from it.
 */
export { ARCHITECTURE_PACK, ARCHITECTURE_CONTRIBUTIONS } from "./pack";
export { ARCHITECTURE_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
export { ARCHITECTURE_CLASSES } from "./classes";
export { ARCHITECTURE_PARAMETER_SET, ROOM_BOUNDING_KEY, SMOKE_BARRIER_KEY } from "./parameters";
export { ARCHITECTURE_PLAN_GRAPHICS, DOOR_PLAN_GRAPHICS, WINDOW_PLAN_GRAPHICS, DOOR_OPERATION_KEY } from "./graphics";
export { ARCHITECTURE_KIND_ROWS, ROOF_KIND, STAIR_KIND, ROOF_KIND_ROW, STAIR_KIND_ROW, MAX_RISER_MM, asRoof, asStair, stairGeometry, roofBlocks, roofPlane, roofFaceAt, ROOF_SURFACE_FACE_ROW, type RoofRecord, type StairRecord, type StairGeometry, type RoofSlope } from "./kinds";
export { ARCHITECTURE_RATINGS, FIRE_RESISTANCE_RATING, SMOKE_BARRIER_RATING, FIRE_RESISTANCE_KEY, DOOR_FIRE_RATING_KEY, ratingHours } from "./ratings";
// Plain data for host screens (tab ids, labels, slots); a host imports `ADDON_UI` under its own name.
export { ARCHITECTURE_FIELD_PROVIDER } from "./fields";
export { ARCHITECTURE_IFC_RELATIONS, OPENING_IFC_RELATIONS, ROOF_IFC_RELATIONS, STAIR_IFC_RELATIONS } from "./ifc";
export { ADDON_UI } from "./ui";
export { ARCHITECTURE_BODIES, DOOR_BODY, WINDOW_BODY, FRAME_DEPTH_KEY } from "./bodies";
export { ARCHITECTURE_SCHEDULE_TEMPLATES, DOOR_SCHEDULE, WINDOW_SCHEDULE, WALL_TYPES_SCHEDULE } from "./schedules";
export { ARCHITECTURE_STARTER_TYPES } from "./starter-types";
