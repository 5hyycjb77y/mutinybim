import { ELEMENT_KIND_POINT, GRAPH_ANCHOR_POINT, type GraphAnchorKindRow } from "@permitzip/bim-kernel";
import { contribute, definePack, type Pack } from "@permitzip/bim-pack/runtime";
import { SITE_KIND, SITE_PACK_ID } from "./ids";
import { SITE_KIND_ROWS } from "./kinds";

/**
 * The Site add-on on the add-on contract (round 11, D3): its two intent kinds
 * and the `parcel` requirement anchor, so a rule tied to a parcel (a zoning
 * setback, an environmental condition) produces its requirement on the
 * parcel record before a building exists. It ships no rules: requirements
 * come from a code study or the model's own rules, as for any trade.
 */

export const SITE_PARCEL_ANCHOR_ROW: GraphAnchorKindRow = { anchor: "parcel", label: "Parcel", recordKinds: [SITE_KIND.parcel] };

export const SITE_PACK: Pack = definePack(
  {
    id: SITE_PACK_ID,
    name: "Site",
    version: "0.1.0",
    kernel: "^1.8.0",
    description: "Site constraints and parcels as records before anything is drawn; requirements anchored on a parcel.",
    firstParty: true,
  },
  [contribute(ELEMENT_KIND_POINT, SITE_KIND_ROWS), contribute(GRAPH_ANCHOR_POINT, [SITE_PARCEL_ANCHOR_ROW])],
);
