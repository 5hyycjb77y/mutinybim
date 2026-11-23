/**
 * Illuminance, uniformity, lighting power density (LPD), and emergency egress
 * compliance criteria based on ASHRAE 90.1, the IES Lighting Handbook,
 * NFPA 101 §7.9.2.1, and IBC §1008.3.5.
 */

export interface NormalLightingTarget {
  readonly occupancyKey: string;
  readonly label: string;
  /** Minimum target average maintained illuminance at workplane (fc). */
  readonly targetAvgFc: number;
  /** Minimum acceptable point illuminance at workplane (fc). */
  readonly targetMinFc: number;
  /** Maximum acceptable max:min uniformity ratio. */
  readonly maxToMinRatio: number;
  /** ASHRAE 90.1 Space-by-Space maximum Lighting Power Density (W/ft²). */
  readonly maxLpdWPerSqFt: number;
  /** Default workplane height above finished floor (inches). */
  readonly defaultWorkplaneIn: number;
}

export interface EgressLightingThresholds {
  readonly initialAvgFc: number;
  readonly initialMinFc: number;
  readonly end90MinAvgFc: number;
  readonly end90MinMinFc: number;
  readonly maxToMinRatio: number;
}

/** NFPA 101 §7.9.2.1 & IBC §1008.3.5 egress illumination thresholds (floor plane Z = 0" AFF). */
export const NFPA101_IBC_EGRESS_THRESHOLDS: EgressLightingThresholds = {
  initialAvgFc: 1.0,
  initialMinFc: 0.1,
  end90MinAvgFc: 0.6,
  end90MinMinFc: 0.06,
  maxToMinRatio: 40,
};

/** Default interior surface reflectances (IES 80/50/20 commercial baseline). */
export interface RoomReflectances {
  /** Ceiling reflectance in [0, 0.98], default 0.80. */
  readonly ceiling: number;
  /** Wall reflectance in [0, 0.98], default 0.50. */
  readonly wall: number;
  /** Floor reflectance in [0, 0.98], default 0.20. */
  readonly floor: number;
}

export const DEFAULT_ROOM_REFLECTANCES: RoomReflectances = {
  ceiling: 0.8,
  wall: 0.5,
  floor: 0.2,
};

export const NORMAL_LIGHTING_TARGETS: Readonly<Record<string, NormalLightingTarget>> = {
  office_open: {
    occupancyKey: "office_open",
    label: "Open Office / Studio",
    targetAvgFc: 30,
    targetMinFc: 12,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 0.79,
    defaultWorkplaneIn: 30,
  },
  office_enclosed: {
    occupancyKey: "office_enclosed",
    label: "Enclosed Office",
    targetAvgFc: 30,
    targetMinFc: 12,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 0.74,
    defaultWorkplaneIn: 30,
  },
  conference: {
    occupancyKey: "conference",
    label: "Conference / Meeting",
    targetAvgFc: 25,
    targetMinFc: 10,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 0.97,
    defaultWorkplaneIn: 30,
  },
  corridor: {
    occupancyKey: "corridor",
    label: "Corridor / Circulation",
    targetAvgFc: 10,
    targetMinFc: 3,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.41,
    defaultWorkplaneIn: 0,
  },
  lobby: {
    occupancyKey: "lobby",
    label: "Lobby / Reception",
    targetAvgFc: 15,
    targetMinFc: 5,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.84,
    defaultWorkplaneIn: 30,
  },
  restroom: {
    occupancyKey: "restroom",
    label: "Restroom",
    targetAvgFc: 15,
    targetMinFc: 5,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.63,
    defaultWorkplaneIn: 30,
  },
  mechanical: {
    occupancyKey: "mechanical",
    label: "Mechanical / Electrical Room",
    targetAvgFc: 15,
    targetMinFc: 5,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.43,
    defaultWorkplaneIn: 30,
  },
  storage: {
    occupancyKey: "storage",
    label: "Storage / Utility",
    targetAvgFc: 10,
    targetMinFc: 3,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.43,
    defaultWorkplaneIn: 30,
  },
  print_copy: {
    occupancyKey: "print_copy",
    label: "Copy / Print Room",
    targetAvgFc: 20,
    targetMinFc: 8,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 0.5,
    defaultWorkplaneIn: 30,
  },
  stair: {
    occupancyKey: "stair",
    label: "Stairwell",
    targetAvgFc: 10,
    targetMinFc: 3,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.49,
    defaultWorkplaneIn: 0,
  },
  kitchen: {
    occupancyKey: "kitchen",
    label: "Break / Kitchen / Cafe",
    targetAvgFc: 25,
    targetMinFc: 10,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 0.95,
    defaultWorkplaneIn: 30,
  },
  classroom: {
    occupancyKey: "classroom",
    label: "Classroom / Training",
    targetAvgFc: 30,
    targetMinFc: 12,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 0.71,
    defaultWorkplaneIn: 30,
  },
  retail: {
    occupancyKey: "retail",
    label: "Retail / Sales",
    targetAvgFc: 30,
    targetMinFc: 12,
    maxToMinRatio: 8,
    maxLpdWPerSqFt: 1.05,
    defaultWorkplaneIn: 30,
  },
  warehouse: {
    occupancyKey: "warehouse",
    label: "Warehouse",
    targetAvgFc: 15,
    targetMinFc: 5,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.45,
    defaultWorkplaneIn: 30,
  },
  exterior: {
    occupancyKey: "exterior",
    label: "Exterior / Exit Discharge",
    targetAvgFc: 1.0,
    targetMinFc: 0.2,
    maxToMinRatio: 20,
    maxLpdWPerSqFt: 0.2,
    defaultWorkplaneIn: 0,
  },
  default: {
    occupancyKey: "default",
    label: "General Interior Space",
    targetAvgFc: 20,
    targetMinFc: 8,
    maxToMinRatio: 10,
    maxLpdWPerSqFt: 0.8,
    defaultWorkplaneIn: 30,
  },
};

const OCCUPANCY_RULES: readonly (readonly [RegExp, string])[] = [
  [/\b(stair|stairwell|steps)\b/i, "stair"],
  [/\b(corridor|hall|hallway|circulation|passage|egress)\b/i, "corridor"],
  [/\b(lobby|reception|vestibule|entry|foyer)\b/i, "lobby"],
  [/\b(restroom|toilet|bath|bathroom|wc|lavatory)\b/i, "restroom"],
  [/\b(mechanical|electrical|mep|elec|mech|boiler|riser|idf|mdf|server)\b/i, "mechanical"],
  [/\b(print|plotter|copy|repro)\b/i, "print_copy"],
  [/\b(storage|closet|janitor|archive|supply)\b/i, "storage"],
  [/\b(conference|meeting|boardroom|huddle)\b/i, "conference"],
  [/\b(kitchen|break|pantry|cafe|lunch|dining|lounge)\b/i, "kitchen"],
  [/\b(classroom|training|lecture)\b/i, "classroom"],
  [/\b(retail|sales|showroom|store)\b/i, "retail"],
  [/\b(warehouse|loading|dock|bay)\b/i, "warehouse"],
  [/\b(exterior|discharge|patio|balcony|terrace|site|entry\s*plaza)\b/i, "exterior"],
  [/\b(open\s*office|studio|workroom|bullpen|drafting|design)\b/i, "office_open"],
  [/\b(office|private|exec|manager|suite)\b/i, "office_enclosed"],
];

/** Match an occupancy lighting target from a space's explicit occupancy key, use id/name, or room name. */
export function resolveNormalLightingTarget(
  occupancyHint?: string | null,
  spaceName?: string | null,
): NormalLightingTarget {
  if (occupancyHint && Object.prototype.hasOwnProperty.call(NORMAL_LIGHTING_TARGETS, occupancyHint)) {
    return NORMAL_LIGHTING_TARGETS[occupancyHint]!;
  }
  const combined = `${occupancyHint ?? ""} ${spaceName ?? ""}`.trim();
  for (const [pattern, key] of OCCUPANCY_RULES) {
    if (pattern.test(combined)) return NORMAL_LIGHTING_TARGETS[key]!;
  }
  return NORMAL_LIGHTING_TARGETS.default!;
}

/** True when a space/room is part of a building's interior means of egress (corridors, lobbies, stairs, exits). */
export function isEgressSpace(occupancyHint?: string | null, spaceName?: string | null): boolean {
  const combined = `${occupancyHint ?? ""} ${spaceName ?? ""}`.trim();
  return /\b(corridor|hall|hallway|circulation|lobby|reception|vestibule|entry|foyer|stair|stairwell|exit|egress)\b/i.test(combined);
}
