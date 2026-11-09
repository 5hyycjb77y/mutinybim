/**
 * The load classes demand factors are applied by. The class ids are the ones
 * the code packs take (`@permitzip/bim-calc` `LOAD_CLASSES`; a test there
 * keeps the two lists equal).
 *
 * Transitional (round 13): the connection type's load class is an add-on's
 * field now (`kernel.connection_field`) and the kernel schema no longer reads
 * this list. It stays exported only until its remaining importers take it
 * from the add-on that owns the field.
 */
export const ELECTRICAL_LOAD_CLASSES = ["lighting", "receptacle", "kitchen", "motor", "hvac", "heating", "cooling", "other"] as const;
export type ElectricalLoadClass = (typeof ELECTRICAL_LOAD_CLASSES)[number];
