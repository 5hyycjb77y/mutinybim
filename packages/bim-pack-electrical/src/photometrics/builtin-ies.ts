import { cachedParseIesFile, type IesPhotometricWeb } from "./ies-parser";

/**
 * Built-in representative IES LM-63-2002 photometric profiles (Apache-2.0 clean,
 * analytically derived and lumen-calibrated synthetic distributions for standard
 * architectural and life-safety luminaires).
 */

export type BuiltinIesProfileId =
  | "troffer_2x4_led"
  | "downlight_6_led"
  | "linear_pendant_led"
  | "exit_combo_wall_pack"
  | "exterior_wall_pack_led";

export interface BuiltinIesProfile {
  readonly id: BuiltinIesProfileId;
  readonly label: string;
  readonly description: string;
  readonly ratedLumens: number;
  readonly inputWatts: number;
  readonly iesText: string;
}

/**
 * 2x4 Recessed Volumetric LED Troffer — 4,000 lm, 32 W, Type C Quadrant Symmetry (0°–90°).
 * Smooth near-Lambertian volumetric distribution with gentle crosswise spread (~115° beam).
 * Integrated spherical flux ≈ 4,000 lm.
 */
const TROFFER_2X4_LED_IES = `IESNA:LM-63-2002
[TEST] MUTINYBIM-PHOT-001
[TESTLAB] MutinyBIM Synthetic Photometric Reference
[ISSUEDATE] 2026-01-01
[MANUFAC] MutinyBIM Reference
[LUMCAT] MB-TR24-40L-35K
[LUMINAIRE] 2x4 Recessed Volumetric LED Troffer, 4000lm, 32W
[LAMP] Integral LED Array 3500K 80CRI
TILT=NONE
1 4000 1.0 19 5 1 1 2.0 4.0 0.25
1.0 1.0 32.0
0 5 10 15 20 25 30 35 40 45 50 55 60 65 70 75 80 85 90
0 22.5 45 67.5 90
1380 1372 1350 1312 1260 1196 1120 1032 936 832 720 604 484 364 248 142 62 18 0
1380 1374 1354 1320 1270 1208 1134 1048 952 848 736 618 498 376 258 150 66 20 0
1380 1376 1360 1330 1284 1226 1154 1070 976 872 760 642 520 396 274 162 72 22 0
1380 1378 1364 1338 1296 1240 1172 1090 998 894 782 664 540 414 290 172 78 24 0
1380 1380 1368 1344 1304 1250 1184 1104 1012 910 798 678 554 426 300 180 82 26 0
`;

/**
 * 6" Recessed Architectural LED Downlight — 1,500 lm, 15 W, Type C Axial Symmetry (0°).
 * Smooth ~75° medium-wide commercial distribution with cutoff glare control above 70°.
 * Integrated spherical flux ≈ 1,500 lm.
 */
const DOWNLIGHT_6_LED_IES = `IESNA:LM-63-2002
[TEST] MUTINYBIM-PHOT-002
[TESTLAB] MutinyBIM Synthetic Photometric Reference
[ISSUEDATE] 2026-01-01
[MANUFAC] MutinyBIM Reference
[LUMCAT] MB-DL6-15L-35K
[LUMINAIRE] 6-inch Recessed Architectural LED Downlight, 1500lm, 15W
[LAMP] Integral COB LED 3500K 90CRI
TILT=NONE
1 1500 1.0 19 1 1 1 0.5 0.5 0.0
1.0 1.0 15.0
0 5 10 15 20 25 30 35 40 45 50 55 60 65 70 75 80 85 90
0
960 950 924 880 818 740 648 546 438 332 232 148 82 38 14 4 1 0 0
`;

/**
 * 4 ft Linear Direct/Indirect LED Pendant — 4,200 lm, 36 W, Type C Quadrant Symmetry (0°–90°).
 * 70% direct downward (~2,940 lm) + 30% indirect upward (~1,260 lm) across 0°–180° vertical range.
 */
const LINEAR_PENDANT_LED_IES = `IESNA:LM-63-2002
[TEST] MUTINYBIM-PHOT-003
[TESTLAB] MutinyBIM Synthetic Photometric Reference
[ISSUEDATE] 2026-01-01
[MANUFAC] MutinyBIM Reference
[LUMCAT] MB-LP4-42L-7030-35K
[LUMINAIRE] 4ft Linear Direct/Indirect LED Pendant (70/30), 4200lm, 36W
[LAMP] Integral Linear LED Boards 3500K 80CRI
TILT=NONE
1 4200 1.0 19 5 1 1 0.33 4.0 0.25
1.0 1.0 36.0
0 10 20 30 40 50 60 70 80 90 100 110 120 130 140 150 160 170 180
0 22.5 45 67.5 90
980 958 898 804 684 544 396 248 112 18 76 168 264 348 410 448 468 476 480
980 962 906 816 698 558 410 260 120 22 82 178 278 364 426 462 478 482 480
980 968 920 838 724 584 434 282 134 26 92 196 302 390 448 476 484 484 480
980 974 934 858 748 608 456 302 146 30 102 212 322 410 462 484 486 484 480
980 978 942 868 760 622 468 312 152 32 108 220 332 418 468 488 486 484 480
`;

/**
 * Exit / Emergency Combo Wall Pack with Dual Adjustable LED Heads — 450 lm emergency, 4 W.
 * Type C Bilateral Symmetry (0°–180°): broad forward/downward corridor & doorway throw for NFPA 101 egress.
 */
const EXIT_COMBO_WALL_PACK_IES = `IESNA:LM-63-2002
[TEST] MUTINYBIM-PHOT-004
[TESTLAB] MutinyBIM Synthetic Photometric Reference
[ISSUEDATE] 2026-01-01
[MANUFAC] MutinyBIM Reference
[LUMCAT] MB-EXC-EM450
[LUMINAIRE] Exit/Emergency Combo Unit with Dual LED Egress Heads, 450lm, 4W
[LAMP] Dual 1.8W High-Output LED Emergency Heads 5000K
TILT=NONE
1 450 1.0 13 5 1 1 1.2 0.35 0.75
1.0 1.0 4.0
0 10 20 30 40 50 60 70 75 80 85 90 100
0 45 90 135 180
140 165 198 226 242 238 212 162 124 82 38 8 0
140 158 184 206 218 210 184 138 104 68 30 6 0
140 142 148 152 150 138 116 84 62 38 16 4 0
140 122 108 94 82 68 52 34 24 14 6 2 0
140 112 92 74 60 48 36 22 14 8 4 1 0
`;

/**
 * Exterior Architectural LED Wall Pack / Egress Discharge Sconce — 1,800 lm, 15 W.
 * Type C Bilateral Symmetry (0°–180°): full-cutoff Dark-Sky forward Type III throw, zero uplight above 90°.
 */
const EXTERIOR_WALL_PACK_LED_IES = `IESNA:LM-63-2002
[TEST] MUTINYBIM-PHOT-005
[TESTLAB] MutinyBIM Synthetic Photometric Reference
[ISSUEDATE] 2026-01-01
[MANUFAC] MutinyBIM Reference
[LUMCAT] MB-EWP-18L-40K-EM
[LUMINAIRE] Exterior Architectural Full-Cutoff LED Wall Pack, 1800lm, 15W
[LAMP] Integral Exterior LED Module 4000K 70CRI
TILT=NONE
1 1800 1.0 13 5 1 1 0.85 0.5 0.4
1.0 1.0 15.0
0 10 20 30 40 50 60 65 70 75 80 85 90
0 45 90 135 180
520 620 740 860 940 920 780 640 460 280 120 32 0
520 590 680 770 820 790 660 540 380 230 98 26 0
520 510 500 480 450 400 320 250 175 102 42 12 0
520 420 340 270 210 160 110 80 52 28 12 4 0
520 380 280 210 155 115 78 54 34 18 8 2 0
`;

export const BUILTIN_IES_PROFILES: Readonly<Record<BuiltinIesProfileId, BuiltinIesProfile>> = {
  troffer_2x4_led: {
    id: "troffer_2x4_led",
    label: "2x4 LED Troffer (4,000 lm)",
    description: "Recessed volumetric 2x4 LED troffer, 4,000 lm, 32 W, Type C quadrant distribution.",
    ratedLumens: 4000,
    inputWatts: 32,
    iesText: TROFFER_2X4_LED_IES,
  },
  downlight_6_led: {
    id: "downlight_6_led",
    label: '6" Recessed LED Downlight (1,500 lm)',
    description: "6-inch architectural recessed LED downlight, 1,500 lm, 15 W, Type C axial distribution.",
    ratedLumens: 1500,
    inputWatts: 15,
    iesText: DOWNLIGHT_6_LED_IES,
  },
  linear_pendant_led: {
    id: "linear_pendant_led",
    label: "4' Linear Direct/Indirect Pendant (4,200 lm)",
    description: "4-foot suspended linear LED pendant (70% direct / 30% indirect), 4,200 lm, 36 W, Type C quadrant distribution.",
    ratedLumens: 4200,
    inputWatts: 36,
    iesText: LINEAR_PENDANT_LED_IES,
  },
  exit_combo_wall_pack: {
    id: "exit_combo_wall_pack",
    label: "Exit / Emergency Combo Unit (450 lm)",
    description: "Exit sign with dual LED emergency egress heads, 450 lm emergency output, 4 W, Type C bilateral forward throw.",
    ratedLumens: 450,
    inputWatts: 4,
    iesText: EXIT_COMBO_WALL_PACK_IES,
  },
  exterior_wall_pack_led: {
    id: "exterior_wall_pack_led",
    label: "Exterior LED Wall Pack (1,800 lm)",
    description: "Full-cutoff architectural exterior LED wall pack / exit-discharge sconce, 1,800 lm, 15 W, Type C bilateral forward throw.",
    ratedLumens: 1800,
    inputWatts: 15,
    iesText: EXTERIOR_WALL_PACK_LED_IES,
  },
};

export const BUILTIN_IES_PROFILE_IDS = Object.keys(BUILTIN_IES_PROFILES) as readonly BuiltinIesProfileId[];

export function isBuiltinIesProfileId(id: string): id is BuiltinIesProfileId {
  return Object.prototype.hasOwnProperty.call(BUILTIN_IES_PROFILES, id);
}

export function builtinIesProfile(id: string): BuiltinIesProfile | null {
  return isBuiltinIesProfileId(id) ? BUILTIN_IES_PROFILES[id] : null;
}

export function builtinIesWeb(id: BuiltinIesProfileId): IesPhotometricWeb {
  return cachedParseIesFile(BUILTIN_IES_PROFILES[id].iesText);
}

/** Infer the best representative built-in IES profile from a luminaire's family/type name when none is explicitly set. */
export function inferBuiltinIesId(familyName: string, typeName: string): BuiltinIesProfileId {
  const text = `${familyName} ${typeName}`.toLowerCase();
  if (/\b(exit|combo)\b/.test(text) && !/\bsconce\b/.test(text)) return "exit_combo_wall_pack";
  if (/\b(exterior|wall\s*pack|sconce|bollard|flood|discharge)\b/.test(text)) return "exterior_wall_pack_led";
  if (/\b(pendant|suspended|linear)\b/.test(text) && !/\btroffer\b/.test(text)) return "linear_pendant_led";
  if (/\b(downlight|can|recessed\s*6|6"|cylind|recessed\s*round)\b/.test(text)) return "downlight_6_led";
  return "troffer_2x4_led";
}
