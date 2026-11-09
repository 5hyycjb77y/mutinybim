/**
 * The Architecture first-party add-on: the building itself. Its classes are
 * the ones the kernel used to carry (`arch.wall`…, ids unchanged), its type
 * parameters, its assembly ratings, door and window plan graphics, and its
 * own roof and stair kinds, door and window bodies in 3D, and how roofs and stairs come in from IFC. Ids stay bare (`keepsBareIds`)
 * because the classes it takes over from the kernel keep their stored ids.
 * Joins, voids and room bounding for the kernel's wall and opening are the
 * kernel's own rows, so they work with this add-on off.
 */
import { ARCHITECTURE_MANIFEST, contribute, definePack, type ErasedContribution, type Pack } from "@permitzip/bim-kernel/packs";
import { CLASS_PLAN_GRAPHICS_POINT, CLASS_SOLIDS_POINT, ELEMENT_KIND_POINT, FIELD_PROVIDER_POINT, LIBRARY_ROWS_POINT, LINKED_PLAN_DISPLAY_POINT, STARTER_ELEMENT_TYPE_POINT, SURFACE_FACE_POINT } from "@permitzip/bim-kernel";
import { ARCHITECTURE_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
import { ARCHITECTURE_FIELD_PROVIDER } from "./fields";
import { ARCHITECTURE_IFC_RELATIONS, IFC_RELATION_POINT } from "./ifc";
import { ARCHITECTURE_IMPORT_RULES, IFC_IMPORT_RULE_POINT } from "./import";
import { CLASS_POINT, PARAMETER_SET_POINT, TAG_STYLE_PRESET_POINT } from "@permitzip/bim-pack/runtime";
import { ARCHITECTURE_TAG_PRESETS } from "./tags";
import { RATING_KIND_POINT } from "@permitzip/bim-kernel/rated-routes";
import { ARCHITECTURE_PLAN_GRAPHICS } from "./graphics";
import { ARCHITECTURE_BODIES } from "./bodies";
import { ARCHITECTURE_KIND_ROWS, ROOF_SURFACE_FACE_ROW } from "./kinds";
import { ARCHITECTURE_CLASSES } from "./classes";
import { ARCHITECTURE_PARAMETER_SET } from "./parameters";
import { ARCHITECTURE_RATINGS } from "./ratings";
import { ARCHITECTURE_SCHEDULE_TEMPLATES } from "./schedules";
import { ARCHITECTURE_KEYNOTE_TABLES } from "./keynotes";
import { ARCHITECTURE_STARTER_TYPES } from "./starter-types";

export const ARCHITECTURE_CONTRIBUTIONS: readonly ErasedContribution[] = [contribute(CLASS_POINT, ARCHITECTURE_CLASSES), contribute(PARAMETER_SET_POINT, [ARCHITECTURE_PARAMETER_SET]), contribute(RATING_KIND_POINT, ARCHITECTURE_RATINGS), contribute(CLASS_PLAN_GRAPHICS_POINT, ARCHITECTURE_PLAN_GRAPHICS), contribute(ELEMENT_KIND_POINT, ARCHITECTURE_KIND_ROWS), contribute(FIELD_PROVIDER_POINT, [{ id: "architecture.building", provider: ARCHITECTURE_FIELD_PROVIDER, rank: 10 }]), contribute(IFC_RELATION_POINT, ARCHITECTURE_IFC_RELATIONS), contribute(IFC_IMPORT_RULE_POINT, ARCHITECTURE_IMPORT_RULES), contribute(LIBRARY_ROWS_POINT, [...ARCHITECTURE_SCHEDULE_TEMPLATES, ...ARCHITECTURE_KEYNOTE_TABLES]), contribute(CLASS_SOLIDS_POINT, ARCHITECTURE_BODIES), contribute(LINKED_PLAN_DISPLAY_POINT, ARCHITECTURE_LINKED_PLAN_DISPLAY), contribute(TAG_STYLE_PRESET_POINT, ARCHITECTURE_TAG_PRESETS), contribute(STARTER_ELEMENT_TYPE_POINT, ARCHITECTURE_STARTER_TYPES), contribute(SURFACE_FACE_POINT, [ROOF_SURFACE_FACE_ROW])];

export const ARCHITECTURE_PACK: Pack = definePack(ARCHITECTURE_MANIFEST, ARCHITECTURE_CONTRIBUTIONS);
