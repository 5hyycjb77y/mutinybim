export {
  MATERIAL_ID_KEY,
  MATERIAL_PATTERNS,
  MATERIAL_CUT_HATCHES,
  MATERIAL_SURFACE_HATCHES,
  MATERIAL_POINT,
  materialRowProblems,
  type MaterialDef,
  type MaterialPattern,
  type MaterialCutHatch,
  type MaterialSurfaceHatch,
} from "./contract";
export {
  allMaterials,
  materialOf,
  parseHexColor,
  materialCutGrey,
  resolveElementMaterial,
} from "./registry";
