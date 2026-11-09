/**
 * Contract 1.11.0: peers that accept the `create_element` command family
 * (draw any line-, area- or point-placed kind whose row allows creation).
 * Declared in wave 0; advertised once lane A13a's commands land.
 */
export const ELEMENTS_CREATE_FEATURE = "elements:create";

/**
 * Contract 1.11.0: peers that read pipe specs by any add-on's id, not only
 * the names the core listed. Declared in wave 0; advertised once lane P13
 * opens the list.
 */
export const PIPES_OPEN_SPECS_FEATURE = "pipes:open_specs";
