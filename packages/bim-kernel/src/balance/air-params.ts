/** The part values the pressurization balance reads (balance/pressurization.ts); the mechanical fields read the same names. */
export const EXHAUST_CFM_PARAMS = ["exhaust_cfm"] as const;
export const MAKEUP_AIR_CFM_PARAMS = ["makeup_air_cfm"] as const;
export const OUTDOOR_AIR_CFM_PARAMS = ["outdoor_cfm", "oa_cfm", "outdoor_air_cfm"] as const;
export const AIR_ZONE_PARAMS = ["serves_zone", "serves"] as const;
/** Makeup air tempering: a choice ("untempered" | "partial" | "tempered") and two °F numbers. */
export const MAKEUP_TEMPERING_PARAMS = { state: "makeup_air_tempering", from: "tempering_from_temp", to: "tempering_to_temp" } as const;
