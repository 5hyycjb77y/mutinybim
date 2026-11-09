/**
 * The device types the Propose panel offers for each kind of location, from
 * the starter library, with the words the panel shows (round 10: the host's
 * screen reads them from here instead of naming the trade's types itself).
 * The person picks; nothing is chosen for them.
 */
export interface ProposeDeviceChoice {
  /** The request's device slot. */
  readonly location: "wall" | "countertop" | "bathroom";
  readonly label: string;
  /** Part type ids, first is the default. */
  readonly types: readonly string[];
  /** Offered only for dwelling units (counters and baths). */
  readonly dwellingOnly: boolean;
}

export const PROPOSE_DEVICE_CHOICES: readonly ProposeDeviceChoice[] = [
  { location: "wall", label: "Wall receptacle", types: ["builtin:duplex-receptacle@1", "builtin:quad-receptacle@1", "builtin:gfci-receptacle@1"], dwellingOnly: false },
  { location: "countertop", label: "Countertop receptacle", types: ["builtin:countertop-receptacle@1", "builtin:gfci-receptacle@1"], dwellingOnly: true },
  { location: "bathroom", label: "Bathroom receptacle", types: ["builtin:gfci-receptacle@1", "builtin:countertop-receptacle@1"], dwellingOnly: true },
];
