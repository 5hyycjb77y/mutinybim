/**
 * What the Building Model needs when it opens: the add-on, its UI and the few
 * helpers the always-loaded screens call. The rest of the toolbox stays on the
 * package root, so the first download does not carry it.
 */
export { MECHANICAL_PACK } from "./pack";
export { ADDON_UI } from "./ui";
export { sizingCriteriaFor, suggestDuctSize, type DuctSizeOption } from "./routing/duct-sizing";
