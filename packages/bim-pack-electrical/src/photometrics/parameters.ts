import { z } from "zod";
import {
  catalogKey,
  elementsOfKind,
  type BimElement,
  type CatalogEntry,
  type CatalogEntryTypeRow,
  type CatalogEntryUse,
  type ModelState,
  type PackParameterSet,
  type PartInstance,
  type PartTypeDefinition,
} from "@permitzip/bim-kernel";
import { builtinIesProfile, builtinIesWeb, inferBuiltinIesId } from "./builtin-ies";
import { cachedParseIesFile, looksLikeIesText, tryParseIesFile, type IesPhotometricWeb } from "./ies-parser";

/**
 * Typed photometric and emergency-egress parameters for luminaires
 * (`PARAMETER_SET_POINT`) plus the deduplicated `photometric_profile` catalog
 * record (`CATALOG_ENTRY_POINT`) for custom IES LM-63 files.
 */

export const PHOTOMETRIC_PROFILE_CATALOG_TYPE = "photometric_profile" as const;

export const EMERGENCY_MODES = ["none", "battery_pack", "generator_circuit", "inverter"] as const;
export type EmergencyMode = (typeof EMERGENCY_MODES)[number];

export const PHOTOMETRIC_PARAM_KEYS = {
  iesFile: "electrical.ies_file",
  photometricProfile: "electrical.photometric_profile",
  emergencyMode: "electrical.emergency_mode",
  emergencyLumens: "electrical.emergency_lumens",
  emergencyBallastFactor: "electrical.emergency_ballast_factor",
  egressFixture: "electrical.egress_fixture",
  lld: "electrical.lld",
  ldd: "electrical.ldd",
  llf: "electrical.llf",
  tiltDeg: "electrical.tilt_deg",
} as const;

/** Default Light Loss Factor components (IES commercial LED interior baseline). */
export const DEFAULT_LLD = 0.9;
export const DEFAULT_LDD = 0.92;
export const DEFAULT_LLF = DEFAULT_LLD * DEFAULT_LDD; // 0.828
/** Typical integral 10 W emergency LED driver output when `emergency_lumens` / `emergency_ballast_factor` are omitted. */
export const DEFAULT_BATTERY_EMERGENCY_LUMENS = 1400;
/** NFPA 101 §7.9.2.1 end-of-90-minute battery discharge factor (60% of initial). */
export const DEFAULT_BATTERY_90MIN_DERATE = 0.6;

/** Parameter set attached to all `mep.lighting_fixture` parts via `PARAMETER_SET_POINT`. */
export const ELECTRICAL_PHOTOMETRICS_PARAMETER_SET: PackParameterSet = {
  id: "electrical.photometrics",
  label: "Electrical photometrics and emergency egress",
  parameters: [
    {
      key: PHOTOMETRIC_PARAM_KEYS.photometricProfile,
      label: "Photometric profile",
      classes: ["mep.lighting_fixture"],
      valueType: "text",
      group: "Photometrics",
      description: "Built-in IES profile id (e.g. troffer_2x4_led) or model photometric_profile catalog name.",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.iesFile,
      label: "IES LM-63 file",
      classes: ["mep.lighting_fixture"],
      valueType: "text",
      maxLength: 65_536,
      group: "Photometrics",
      description: "Inline IES LM-63-1995/2002/19 photometric text payload or catalog profile reference.",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.emergencyMode,
      label: "Emergency power source",
      classes: ["mep.lighting_fixture"],
      valueType: "choice",
      choices: [...EMERGENCY_MODES],
      group: "Emergency Egress",
      description: "Emergency lighting power source for NFPA 101 / IBC egress compliance.",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.emergencyLumens,
      label: "Emergency lumens",
      classes: ["mep.lighting_fixture"],
      valueType: "quantity",
      kind: "luminous_flux",
      unit: "lm",
      group: "Emergency Egress",
      description: "Rated initial luminous flux in emergency/battery mode (lm).",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.emergencyBallastFactor,
      label: "Emergency ballast factor",
      classes: ["mep.lighting_fixture"],
      valueType: "quantity",
      kind: "ratio",
      unit: "1",
      group: "Emergency Egress",
      description: "Fraction of normal luminous output produced in emergency mode (0 to 1).",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.egressFixture,
      label: "Egress fixture",
      classes: ["mep.lighting_fixture"],
      valueType: "boolean",
      group: "Emergency Egress",
      description: "Marks this luminaire as part of the NFPA 101 / IBC emergency egress lighting system.",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.lld,
      label: "Lamp lumen depreciation (LLD)",
      classes: ["mep.lighting_fixture"],
      valueType: "quantity",
      kind: "ratio",
      unit: "1",
      group: "Photometrics",
      description: "Lamp lumen depreciation factor (default 0.90 for LED).",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.ldd,
      label: "Luminaire dirt depreciation (LDD)",
      classes: ["mep.lighting_fixture"],
      valueType: "quantity",
      kind: "ratio",
      unit: "1",
      group: "Photometrics",
      description: "Luminaire dirt depreciation factor (default 0.92 clean interior).",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.llf,
      label: "Light loss factor (LLF)",
      classes: ["mep.lighting_fixture"],
      valueType: "quantity",
      kind: "ratio",
      unit: "1",
      group: "Photometrics",
      description: "Overall light loss factor override (defaults to LLD * LDD).",
    },
    {
      key: PHOTOMETRIC_PARAM_KEYS.tiltDeg,
      label: "Aim tilt",
      classes: ["mep.lighting_fixture"],
      valueType: "quantity",
      kind: "angle",
      unit: "deg",
      group: "Photometrics",
      description: "Luminaire aiming tilt angle from nadir in degrees.",
    },
  ],
};

/** Catalog record schema for storing custom IES LM-63 photometric profiles once per model. */
export const photometricProfileEntrySchema = z
  .object({
    type: z.literal(PHOTOMETRIC_PROFILE_CATALOG_TYPE),
    name: z.string().trim().min(1).max(80),
    iesText: z.string().min(10).max(65_536).refine((s) => tryParseIesFile(s).ok, {
      message: "iesText must be a valid IES LM-63 photometric file",
    }),
    manufacturer: z.string().trim().max(120).optional(),
    catalogNumber: z.string().trim().max(120).optional(),
    lumens: z.number().finite().positive().optional(),
    watts: z.number().finite().nonnegative().optional(),
  })
  .strict();

export type PhotometricProfileEntry = z.infer<typeof photometricProfileEntrySchema>;

function isPhotometricProfileEntry(entry: CatalogEntry): entry is PhotometricProfileEntry {
  return entry.type === PHOTOMETRIC_PROFILE_CATALOG_TYPE;
}

function findPhotometricProfileUses(elements: Readonly<Record<string, BimElement>>, key: string): readonly CatalogEntryUse[] {
  const uses: CatalogEntryUse[] = [];
  for (const part of elementsOfKind(elements, "part")) {
    const prof = part.values[PHOTOMETRIC_PARAM_KEYS.photometricProfile];
    const ies = part.values[PHOTOMETRIC_PARAM_KEYS.iesFile];
    if (
      (typeof prof === "string" && catalogKey(prof) === key) ||
      (typeof ies === "string" && !looksLikeIesText(ies) && catalogKey(ies) === key)
    ) {
      uses.push({ id: part.id, name: part.mark || part.id });
    }
  }
  return uses;
}

function renamePhotometricProfileUse(el: BimElement, nextName: string): { readonly element: BimElement } | null {
  if (el.kind !== "part") return null;
  const values = { ...el.values };
  let changed = false;
  if (typeof values[PHOTOMETRIC_PARAM_KEYS.photometricProfile] === "string") {
    values[PHOTOMETRIC_PARAM_KEYS.photometricProfile] = nextName;
    changed = true;
  }
  const iesVal = values[PHOTOMETRIC_PARAM_KEYS.iesFile];
  if (typeof iesVal === "string" && !looksLikeIesText(iesVal)) {
    values[PHOTOMETRIC_PARAM_KEYS.iesFile] = nextName;
    changed = true;
  }
  return changed ? { element: { ...el, values } } : null;
}

export const PHOTOMETRIC_PROFILE_CATALOG_ROW: CatalogEntryTypeRow = {
  type: PHOTOMETRIC_PROFILE_CATALOG_TYPE,
  label: "Photometric profile",
  idPrefix: "ies",
  schema: photometricProfileEntrySchema,
  nameOf: (entry) => (isPhotometricProfileEntry(entry as CatalogEntry) ? (entry as PhotometricProfileEntry).name : ""),
  trade: () => "electrical",
  references: {
    plural: "luminaires",
    find: findPhotometricProfileUses,
    rename: renamePhotometricProfileUse,
  },
};

/** Resolved luminaire photometric and emergency parameters ready for point-by-point calculations. */
export interface ResolvedLuminairePhotometrics {
  readonly partId: string;
  readonly profileId: string;
  readonly web: IesPhotometricWeb;
  /** Scale applied to web candela to align with luminaire's declared lumens (1.0 if identical). */
  readonly lumenScale: number;
  /** Normal light loss factor (`llf ?? lld * ldd`). */
  readonly llf: number;
  /** Effective lamp/luminaire input watts (from part parameter, type value, or IES file). */
  readonly watts: number;
  /** Rated normal lumens (from part parameter, type value, or IES file). */
  readonly normalLumens: number;
  /** Aiming tilt from nadir in degrees (0 = straight down). */
  readonly tiltDeg: number;
  /** True when this luminaire operates during an emergency/egress power failure. */
  readonly isEmergency: boolean;
  /** Emergency power source mode. */
  readonly emergencyMode: EmergencyMode;
  /** Emergency output multiplier relative to normal output (in [0, 1]). */
  readonly emergencyScale: number;
  /** 90-minute end-of-discharge derate factor (0.60 for battery_pack, 1.0 for generator/inverter). */
  readonly endOfDischargeFactor: number;
  /** True when the luminaire's illuminating heads operate ONLY during power failure (e.g. exit/emergency combo flood heads, bug-eye battery units). */
  readonly isEmergencyOnly: boolean;
  /** True when the fixture is a pure illuminated exit sign without floor-illuminating emergency heads. */
  readonly isExitSignOnly: boolean;
}

/** Look up all custom `photometric_profile` catalog entries in the model keyed by `catalogKey(name)`. */
export function indexPhotometricCatalog(model: ModelState): ReadonlyMap<string, PhotometricProfileEntry> {
  const map = new Map<string, PhotometricProfileEntry>();
  for (const el of elementsOfKind(model.elements, "service_catalog")) {
    if (isPhotometricProfileEntry(el.entry)) {
      map.set(catalogKey(el.entry.name), el.entry);
    }
  }
  return map;
}

/** Find element IDs of parts connected to an emergency or life-safety electrical circuit/panel. */
export function findEmergencyCircuitParts(model: ModelState): ReadonlySet<string> {
  const emergencyPanels = new Set<string>();
  const emergencyRegex = /\b(em|emerg|emergency|life[- ]?safety|egress|ls)\b/i;

  for (const part of elementsOfKind(model.elements, "part")) {
    const pt = model.elements[part.typeId];
    if (pt?.kind !== "part_type" || pt.definition.category !== "electrical_equipment") continue;
    const label = `${part.mark} ${pt.definition.familyName} ${pt.definition.typeName}`;
    if (emergencyRegex.test(label)) emergencyPanels.add(part.id);
  }

  const emergencyParts = new Set<string>();
  for (const link of elementsOfKind(model.elements, "service_link")) {
    const srcId = link.source.elementId;
    const isEmergencyLink =
      emergencyRegex.test(link.description ?? "") ||
      emergencyPanels.has(srcId);
    if (isEmergencyLink) {
      for (const m of link.members) emergencyParts.add(m.elementId);
    }
  }
  return emergencyParts;
}

function readNum(part: PartInstance, def: PartTypeDefinition, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const iv = part.values[key];
    if (typeof iv === "number" && Number.isFinite(iv)) return iv;
    const tv = def.typeValues[key];
    if (typeof tv === "number" && Number.isFinite(tv)) return tv;
  }
  return undefined;
}

function readStr(part: PartInstance, def: PartTypeDefinition, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const iv = part.values[key];
    if (typeof iv === "string" && iv.trim().length > 0) return iv;
    const tv = def.typeValues[key];
    if (typeof tv === "string" && tv.trim().length > 0) return tv;
  }
  return undefined;
}

function readBool(part: PartInstance, def: PartTypeDefinition, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const iv = part.values[key];
    if (typeof iv === "boolean") return iv;
    const tv = def.typeValues[key];
    if (typeof tv === "boolean") return tv;
  }
  return undefined;
}

function resolveProfileWeb(
  iesField: string | undefined,
  profileField: string | undefined,
  def: PartTypeDefinition,
  catalog: ReadonlyMap<string, PhotometricProfileEntry>,
): { readonly profileId: string; readonly web: IesPhotometricWeb; readonly customText: boolean } {
  // 1. Inline IES LM-63 payload on electrical.ies_file (or bare ies_file)
  if (iesField && looksLikeIesText(iesField)) {
    const parsed = tryParseIesFile(iesField);
    if (parsed.ok) {
      return {
        profileId: parsed.web.metadata.lumcat ?? parsed.web.metadata.test ?? "custom_ies",
        web: parsed.web,
        customText: true,
      };
    }
  }

  // 2. Named profile on electrical.photometric_profile or electrical.ies_file -> catalog first, then built-in
  const candidates = [profileField, iesField].filter((s): s is string => typeof s === "string" && s.trim().length > 0 && !looksLikeIesText(s));
  for (const name of candidates) {
    const cat = catalog.get(catalogKey(name));
    if (cat) {
      return { profileId: cat.name, web: cachedParseIesFile(cat.iesText), customText: true };
    }
    const builtin = builtinIesProfile(name.trim());
    if (builtin) {
      return { profileId: builtin.id, web: builtinIesWeb(builtin.id), customText: false };
    }
  }

  // 3. Infer representative built-in profile from luminaire family/type name
  const inferred = inferBuiltinIesId(def.familyName, def.typeName);
  return { profileId: inferred, web: builtinIesWeb(inferred), customText: false };
}

/** Resolve photometric web, LLF, wattage, and emergency egress behavior for a placed lighting fixture. */
export function resolveLuminairePhotometrics(
  model: ModelState,
  part: PartInstance,
  def: PartTypeDefinition,
  catalog?: ReadonlyMap<string, PhotometricProfileEntry>,
  emergencyCircuitParts?: ReadonlySet<string>,
  battery90MinDerate = DEFAULT_BATTERY_90MIN_DERATE,
): ResolvedLuminairePhotometrics {
  const cat = catalog ?? indexPhotometricCatalog(model);
  const emParts = emergencyCircuitParts ?? findEmergencyCircuitParts(model);

  const iesField = readStr(part, def, PHOTOMETRIC_PARAM_KEYS.iesFile, "ies_file");
  const profileField = readStr(part, def, PHOTOMETRIC_PARAM_KEYS.photometricProfile, "photometric_profile");
  const { profileId, web, customText } = resolveProfileWeb(iesField, profileField, def, cat);

  const declaredLumens = readNum(part, def, "lumens");
  const webLumens = web.totalLumens > 0 ? web.totalLumens : 1000;
  // Preserve exact custom IES candela unless an explicit `lumens` parameter overrides a built-in profile
  const normalLumens = !customText && declaredLumens !== undefined && declaredLumens > 0 ? declaredLumens : webLumens;
  const lumenScale = !customText && declaredLumens !== undefined && declaredLumens > 0 ? declaredLumens / webLumens : 1;

  const declaredWatts = readNum(part, def, "watts", "load_w", "input_watts");
  const watts = declaredWatts !== undefined && declaredWatts >= 0 ? declaredWatts : web.inputWatts;

  const lld = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.lld) ?? DEFAULT_LLD;
  const ldd = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.ldd) ?? DEFAULT_LDD;
  const explicitLlf = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.llf);
  const llf = Math.max(0.05, Math.min(1.5, explicitLlf ?? lld * ldd));

  const tiltDeg = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.tiltDeg) ?? 0;

  // Emergency mode resolution:
  // 1. Explicit electrical.emergency_mode power source ("battery_pack" | "generator_circuit" | "inverter")
  // 2. Any explicit emergency indicator set on the fixture: control-wiring `emergency_mode` ("unswitched" | "switched"),
  //    `emergency: true`, or `electrical.egress_fixture: true` — so toggling emergency in PartInspector or Controls
  //    ALWAYS activates emergency lighting even if `electrical.emergency_mode` still held a prior `"none"` default.
  // 3. Connected to an emergency / life-safety circuit or panel (unless explicitly forced off on the instance).
  const instancePackEm = part.values?.[PHOTOMETRIC_PARAM_KEYS.emergencyMode];
  const packEmModeRaw = readStr(part, def, PHOTOMETRIC_PARAM_KEYS.emergencyMode);
  const ctrlEmModeRaw = readStr(part, def, "emergency_mode");
  const legacyEmFlag = readBool(part, def, "emergency");
  const egressFlag = readBool(part, def, PHOTOMETRIC_PARAM_KEYS.egressFixture);
  const onEmCircuit = emParts.has(part.id);

  let emergencyMode: EmergencyMode = "none";
  if (packEmModeRaw === "battery_pack" || packEmModeRaw === "generator_circuit" || packEmModeRaw === "inverter") {
    emergencyMode = packEmModeRaw;
  } else if (ctrlEmModeRaw === "unswitched" || ctrlEmModeRaw === "switched" || legacyEmFlag === true || egressFlag === true) {
    emergencyMode = onEmCircuit ? "generator_circuit" : "battery_pack";
  } else if (instancePackEm === "none" || packEmModeRaw === "none") {
    emergencyMode = "none";
  } else if (onEmCircuit) {
    emergencyMode = "generator_circuit";
  }

  const isEmergency = emergencyMode !== "none";

  // Emergency luminous output scaling
  let emergencyScale = 0;
  if (isEmergency) {
    const emLumens = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.emergencyLumens);
    const emBallast = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.emergencyBallastFactor);
    if (emLumens !== undefined && emLumens >= 0) {
      emergencyScale = normalLumens > 0 ? emLumens / normalLumens : 0;
    } else if (emBallast !== undefined && emBallast >= 0) {
      emergencyScale = emBallast;
    } else if (emergencyMode === "generator_circuit" || emergencyMode === "inverter") {
      emergencyScale = 1.0;
    } else if (profileId === "exit_combo_wall_pack") {
      // Dedicated exit/emergency combo unit outputs 100% of its rated emergency head lumens on battery
      emergencyScale = 1.0;
    } else {
      // Standard integral 10W LED emergency battery pack (~1,400 lm, capped at 100% of fixture output)
      emergencyScale = Math.min(1.0, DEFAULT_BATTERY_EMERGENCY_LUMENS / Math.max(1, normalLumens));
    }
  }

  const endOfDischargeFactor = emergencyMode === "battery_pack" ? Math.max(0.1, Math.min(1, battery90MinDerate)) : 1.0;

  const fullLabel = `${def.familyName} ${def.typeName}`.toLowerCase();
  const explicitEmLumens = readNum(part, def, PHOTOMETRIC_PARAM_KEYS.emergencyLumens);
  const explicitComboProfile = profileField?.trim() === "exit_combo_wall_pack";
  const looksLikeCombo =
    explicitComboProfile ||
    /\b(combo|bug[- ]?eye|emergency[- ]?only|dual\s*head)\b/i.test(fullLabel);
  const looksLikePureExitSign =
    /\bexit\s*sign\b/i.test(fullLabel) &&
    !looksLikeCombo &&
    !(explicitEmLumens !== undefined && explicitEmLumens > 0);
  const isExitSignOnly = looksLikePureExitSign;
  const isEmergencyOnly = !isExitSignOnly && looksLikeCombo;

  return {
    partId: part.id,
    profileId,
    web,
    lumenScale,
    llf,
    watts,
    normalLumens,
    tiltDeg,
    isEmergency,
    emergencyMode,
    emergencyScale: isExitSignOnly ? 0 : emergencyScale,
    endOfDischargeFactor,
    isEmergencyOnly,
    isExitSignOnly,
  };
}
