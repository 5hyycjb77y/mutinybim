/**
 * Pure TypeScript IES LM-63-1995 / LM-63-2002 / ANSI/IES LM-63-19 photometric
 * file parser and angular candela web interpolator.
 *
 * Reference geometry (ANSI/IES LM-63 / LM-75):
 * - Type C (photometricType = 1, standard indoor & roadway luminaires):
 *   - Vertical angle theta in [0°, 180°]: 0° = straight down (nadir, -Z), 90° = horizontal, 180° = straight up (+Z).
 *   - Horizontal angle phi in [0°, 360°): 0° = +X (luminaire length axis), 90° = +Y (width axis).
 * - Type B (photometricType = 2, floodlights):
 *   - Vertical angle in [-90°, 90°], horizontal angle in [-90°, 90°] or [0°, 90°].
 * - Type A (photometricType = 3, automotive / signal):
 *   - Vertical angle in [-90°, 90°], horizontal angle in [-90°, 90°] or [0°, 90°].
 */

export type IesStandard = "LM-63-1995" | "LM-63-2002" | "LM-63-19" | "LM-63-1991" | "UNKNOWN";
export type IesPhotometricType = 1 | 2 | 3;
export type IesSymmetry = "axial" | "quadrant" | "bilateral_0_180" | "bilateral_90_270" | "asymmetric";

export interface IesTiltData {
  /** 1 = vertical base-up/down, 2 = horizontal along 0°, 3 = horizontal along 90°. */
  readonly lampToLuminaireGeometry: number;
  readonly angles: readonly number[];
  readonly factors: readonly number[];
}

export interface IesPhotometricWeb {
  readonly standard: IesStandard;
  readonly header: string;
  readonly keywords: Readonly<Record<string, string>>;
  readonly metadata: {
    readonly test?: string;
    readonly testlab?: string;
    readonly issuedate?: string;
    readonly manufac?: string;
    readonly lumcat?: string;
    readonly luminaire?: string;
    readonly lampcat?: string;
    readonly lamp?: string;
  };
  readonly tiltMode: "NONE" | "INCLUDE" | "FILE";
  readonly tiltFile?: string;
  readonly tilt?: IesTiltData;
  readonly lampCount: number;
  /** Rated lumens per lamp, or -1 for absolute photometry (LED). */
  readonly lumensPerLamp: number;
  readonly multiplier: number;
  readonly numVerticalAngles: number;
  readonly numHorizontalAngles: number;
  readonly photometricType: IesPhotometricType;
  /** 1 = feet, 2 = meters. */
  readonly unitsType: 1 | 2;
  /** Luminous opening dimensions normalized to meters. */
  readonly widthM: number;
  readonly lengthM: number;
  readonly heightM: number;
  readonly ballastFactor: number;
  /** Ballast-lamp photometric factor (LM-63-1995) or future-use / file-generation-type (LM-63-2002/19). */
  readonly futureUse: number;
  readonly inputWatts: number;
  readonly verticalAngles: readonly number[];
  readonly horizontalAngles: readonly number[];
  /** Raw candela matrix indexed as `candela[hIndex][vIndex]` (before multiplier/ballastFactor). */
  readonly candela: readonly (readonly number[])[];
  readonly symmetry: IesSymmetry;
  /** Effective candela scale factor (`multiplier * ballastFactor * lm95Blpf`). */
  readonly candelaScale: number;
  /** Total rated or integrated photometric lumens. */
  readonly totalLumens: number;
  /** Downward (0°–90°) integrated lumens. */
  readonly downwardLumens: number;
  /** Upward (90°–180°) integrated lumens. */
  readonly upwardLumens: number;
  /** Peak effective candela (scaled). */
  readonly maxCandela: number;
}

const FT_TO_M = 0.3048;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function detectStandard(header: string): IesStandard {
  const upper = header.trim().toUpperCase();
  if (/LM-63-1995\b/.test(upper)) return "LM-63-1995";
  if (/IESNA91\b|LM-63-1991\b/.test(upper)) return "LM-63-1991";
  if (/LM-63-2002\b/.test(upper)) return "LM-63-2002";
  if (/LM-63-(?:20)?19\b/.test(upper)) return "LM-63-19";
  return "UNKNOWN";
}

/** Determine standard Type C horizontal symmetry from the horizontal angle grid. */
export function detectSymmetry(horizontalAngles: readonly number[], photometricType: IesPhotometricType = 1): IesSymmetry {
  if (horizontalAngles.length <= 1) return "axial";
  if (photometricType !== 1) return "asymmetric";
  const first = horizontalAngles[0]!;
  const last = horizontalAngles[horizontalAngles.length - 1]!;
  if (Math.abs(first) < 1e-6 && Math.abs(last - 90) < 1e-6) return "quadrant";
  if (Math.abs(first) < 1e-6 && last < 90) return "quadrant";
  if (Math.abs(first) < 1e-6 && Math.abs(last - 180) < 1e-6) return "bilateral_0_180";
  if (Math.abs(first - 90) < 1e-6 && Math.abs(last - 270) < 1e-6) return "bilateral_90_270";
  return "asymmetric";
}

/** Parse numeric tokens from IES data lines (supports whitespace and comma separators per LM-63). */
function tokenizeNumbers(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[\s,]+/);
    for (const part of parts) {
      if (!part) continue;
      const num = Number(part);
      if (!Number.isFinite(num)) {
        throw new Error(`Invalid numeric value "${part}" in IES photometric data`);
      }
      out.push(num);
    }
  }
  return out;
}

/** Find bracket `[i0, i1, t]` in a sorted ascending array `arr` for value `x`. */
function bracket(arr: readonly number[], x: number): readonly [number, number, number] {
  const n = arr.length;
  if (n <= 1) return [0, 0, 0];
  if (x <= arr[0]!) return [0, 0, 0];
  if (x >= arr[n - 1]!) return [n - 1, n - 1, 0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const a = arr[lo]!;
  const b = arr[hi]!;
  const span = b - a;
  const t = span > 1e-12 ? (x - a) / span : 0;
  return [lo, hi, t];
}

/** Fold horizontal angle `phiDeg` according to Type C symmetry, returning `[h0, h1, tH]`. */
function horizontalBracket(
  horizontalAngles: readonly number[],
  symmetry: IesSymmetry,
  phiDeg: number,
  photometricType: IesPhotometricType,
): readonly [number, number, number] {
  const n = horizontalAngles.length;
  if (n <= 1 || symmetry === "axial") return [0, 0, 0];

  if (photometricType !== 1) {
    // Type B / A: clamp symmetric half-plane if grid starts at 0°
    const first = horizontalAngles[0]!;
    const v = first >= 0 ? Math.abs(phiDeg) : phiDeg;
    return bracket(horizontalAngles, v);
  }

  // Normalize phi to [0, 360)
  let phi = ((phiDeg % 360) + 360) % 360;

  if (symmetry === "quadrant") {
    if (phi > 180) phi = 360 - phi;
    if (phi > 90) phi = 180 - phi;
    return bracket(horizontalAngles, phi);
  }

  if (symmetry === "bilateral_0_180") {
    if (phi > 180) phi = 360 - phi;
    return bracket(horizontalAngles, phi);
  }

  if (symmetry === "bilateral_90_270") {
    // Symmetric about the 90°–270° vertical plane: mirror [0, 90) and (270, 360) into [90, 270]
    if (phi < 90) phi = 180 - phi;
    else if (phi > 270) phi = 540 - phi;
    return bracket(horizontalAngles, phi);
  }

  // Asymmetric full 0°..360° (handle wrap-around if last angle < 360°)
  const last = horizontalAngles[n - 1]!;
  if (phi > last && last < 360) {
    const first = horizontalAngles[0]!;
    const wrapSpan = 360 + first - last;
    const t = wrapSpan > 1e-12 ? (phi - last) / wrapSpan : 0;
    return [n - 1, 0, t];
  }
  return bracket(horizontalAngles, phi);
}

/**
 * Sample effective candela `I(thetaDeg, phiDeg)` from a parsed IES photometric web
 * using bilinear angular interpolation over vertical (`thetaDeg`) and horizontal (`phiDeg`) grids.
 *
 * Returns effective candela (scaled by `web.candelaScale`, i.e. `multiplier * ballastFactor`).
 */
export function sampleCandela(web: IesPhotometricWeb, thetaDeg: number, phiDeg: number): number {
  const vAngles = web.verticalAngles;
  const hAngles = web.horizontalAngles;
  if (vAngles.length === 0 || hAngles.length === 0) return 0;

  if (web.photometricType === 1) {
    // Type C: vertical angle theta in [0, 180]. Zero outside measured upper bound (e.g. direct-only 0..90°).
    const vMin = vAngles[0]!;
    const vMax = vAngles[vAngles.length - 1]!;
    if (thetaDeg > vMax + 1e-6) return 0;
    if (thetaDeg < vMin - 1e-6 && vMin > 1e-6) return 0;
    const clampedTheta = Math.max(vMin, Math.min(vMax, thetaDeg));

    const [v0, v1, tV] = bracket(vAngles, clampedTheta);
    const [h0, h1, tH] = horizontalBracket(hAngles, web.symmetry, phiDeg, 1);

    const row0 = web.candela[h0]!;
    const row1 = web.candela[h1]!;
    const c00 = row0[v0]!;
    const c01 = row0[v1]!;
    const c10 = row1[v0]!;
    const c11 = row1[v1]!;

    const c0 = c00 + (c01 - c00) * tV;
    const c1 = c10 + (c11 - c10) * tV;
    const raw = c0 + (c1 - c0) * tH;
    return Math.max(0, raw * web.candelaScale);
  }

  // Type B or Type A: vertical & horizontal angles in [-90, 90]
  const vMin = vAngles[0]!;
  const vMax = vAngles[vAngles.length - 1]!;
  const thetaEff = vMin >= 0 ? Math.abs(thetaDeg) : thetaDeg;
  if (thetaEff < vMin - 1e-6 || thetaEff > vMax + 1e-6) return 0;
  const [v0, v1, tV] = bracket(vAngles, thetaEff);
  const [h0, h1, tH] = horizontalBracket(hAngles, web.symmetry, phiDeg, web.photometricType);

  const row0 = web.candela[h0]!;
  const row1 = web.candela[h1]!;
  const c0 = row0[v0]! + (row0[v1]! - row0[v0]!) * tV;
  const c1 = row1[v0]! + (row1[v1]! - row1[v0]!) * tV;
  return Math.max(0, (c0 + (c1 - c0) * tH) * web.candelaScale);
}

/**
 * Sample effective candela along a luminaire-local direction vector `(dx, dy, dz)`
 * (need not be unit length): `-Z` is nadir, `+X` is C0° (length axis), `+Y` is C90° (width axis).
 */
export function sampleCandelaDirection(web: IesPhotometricWeb, dx: number, dy: number, dz: number): number {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-12) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;

  if (web.photometricType === 1) {
    // Type C: theta = acos(-uz) in [0, 180], phi = atan2(uy, ux) in [0, 360)
    const thetaDeg = Math.acos(Math.max(-1, Math.min(1, -uz))) * RAD;
    const phiDeg = ((Math.atan2(uy, ux) * RAD) % 360 + 360) % 360;
    return sampleCandela(web, thetaDeg, phiDeg);
  }
  if (web.photometricType === 2) {
    // Type B: nadir is -Z; vertical angle in YZ plane, horizontal angle lateral along X
    if (-uz <= 0) return 0;
    const vDeg = Math.atan2(uy, -uz) * RAD;
    const hDeg = Math.atan2(ux, Math.hypot(uy, uz)) * RAD;
    return sampleCandela(web, vDeg, hDeg);
  }
  // Type A: vertical angle in XZ plane, horizontal angle lateral along Y
  if (-uz <= 0) return 0;
  const vDeg = Math.atan2(ux, -uz) * RAD;
  const hDeg = Math.atan2(uy, Math.hypot(ux, uz)) * RAD;
  return sampleCandela(web, vDeg, hDeg);
}

/** Interpolate TILT=INCLUDE multiplying factor for a given luminaire tilt angle in degrees. */
export function sampleTiltFactor(web: IesPhotometricWeb, tiltDeg: number): number {
  if (!web.tilt || web.tilt.angles.length === 0) return 1;
  const [i0, i1, t] = bracket(web.tilt.angles, Math.abs(tiltDeg));
  const f0 = web.tilt.factors[i0] ?? 1;
  const f1 = web.tilt.factors[i1] ?? f0;
  return f0 + (f1 - f0) * t;
}

/** Numerically integrate total, downward (0°–90°) and upward (90°–180°) luminous flux (lm) from a photometric web. */
export function integratePhotometricLumens(web: IesPhotometricWeb): {
  readonly totalLumens: number;
  readonly downwardLumens: number;
  readonly upwardLumens: number;
} {
  // Uniform spherical Riemann quadrature: 180 vertical steps (1°), 72 horizontal steps (5°) -> <0.1% error, <0.2ms
  const vSteps = 180;
  const hSteps = web.symmetry === "axial" ? 1 : 72;
  const dTheta = Math.PI / vSteps;
  const dPhi = (2 * Math.PI) / hSteps;
  let down = 0;
  let up = 0;
  for (let vi = 0; vi < vSteps; vi++) {
    const thetaMidRad = (vi + 0.5) * dTheta;
    const thetaMidDeg = thetaMidRad * RAD;
    const sinT = Math.sin(thetaMidRad);
    const zoneFactor = sinT * dTheta * dPhi;
    let ringSum = 0;
    for (let hi = 0; hi < hSteps; hi++) {
      const phiDeg = ((hi + 0.5) * 360) / hSteps;
      ringSum += sampleCandela(web, thetaMidDeg, phiDeg);
    }
    const zoneLumens = ringSum * zoneFactor;
    if (thetaMidDeg <= 90) down += zoneLumens;
    else up += zoneLumens;
  }
  return { totalLumens: down + up, downwardLumens: down, upwardLumens: up };
}

/**
 * Parse an IES LM-63-1995 / LM-63-2002 / ANSI/IES LM-63-19 text payload into a
 * structured `IesPhotometricWeb`. Throws a descriptive Error if malformed.
 */
export function parseIesFile(rawText: string): IesPhotometricWeb {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new Error("IES file is empty");
  }
  const lines = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // Locate first non-empty line (standard header) and TILT= line
  let firstLineIdx = 0;
  while (firstLineIdx < lines.length && lines[firstLineIdx]!.trim().length === 0) firstLineIdx++;
  if (firstLineIdx >= lines.length) throw new Error("IES file contains no lines");

  let tiltIdx = -1;
  for (let i = firstLineIdx; i < lines.length; i++) {
    if (/^\s*TILT\s*=/i.test(lines[i]!)) {
      tiltIdx = i;
      break;
    }
  }
  if (tiltIdx === -1) {
    throw new Error("Missing required TILT= directive in IES LM-63 file");
  }

  const headerLine = lines[firstLineIdx]!.trim();
  const hasExplicitHeader = !headerLine.startsWith("[") && !/^TILT\s*=/i.test(headerLine);
  const header = hasExplicitHeader ? headerLine : "";
  const standard = detectStandard(header);

  // Parse [KEYWORD] metadata lines between header and TILT=
  const keywords: Record<string, string> = {};
  let lastKeyword: string | null = null;
  const kwStart = hasExplicitHeader ? firstLineIdx + 1 : firstLineIdx;
  for (let i = kwStart; i < tiltIdx; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    const match = /^\[([A-Za-z0-9_.\-/ ]+)\]\s*(.*)$/.exec(trimmed);
    if (match) {
      const key = match[1]!.trim().toUpperCase();
      const val = match[2]!.trim();
      if (key === "MORE" && lastKeyword) {
        keywords[lastKeyword] = keywords[lastKeyword] ? `${keywords[lastKeyword]} ${val}` : val;
      } else {
        keywords[key] = keywords[key] ? `${keywords[key]}\n${val}` : val;
        lastKeyword = key;
      }
    }
  }

  // Parse TILT= directive
  const tiltMatch = /^\s*TILT\s*=\s*(.+)$/i.exec(lines[tiltIdx]!)!;
  const tiltArg = tiltMatch[1]!.trim();
  const tiltArgUpper = tiltArg.toUpperCase();
  let tiltMode: "NONE" | "INCLUDE" | "FILE";
  let tiltFile: string | undefined;
  let dataStartIdx = tiltIdx + 1;

  if (tiltArgUpper === "NONE") {
    tiltMode = "NONE";
  } else if (tiltArgUpper === "INCLUDE") {
    tiltMode = "INCLUDE";
  } else {
    tiltMode = "FILE";
    tiltFile = tiltArg;
  }

  const nums = tokenizeNumbers(lines.slice(dataStartIdx));
  let cursor = 0;
  const take = (label: string): number => {
    if (cursor >= nums.length) throw new Error(`Unexpected end of IES numeric table reading ${label}`);
    return nums[cursor++]!;
  };

  let tilt: IesTiltData | undefined;
  if (tiltMode === "INCLUDE") {
    const lampToLuminaireGeometry = take("TILT lamp-to-luminaire geometry");
    const pairCount = Math.round(take("TILT angle/factor count"));
    if (pairCount < 0 || pairCount > 1000) {
      throw new Error(`Invalid TILT pair count: ${pairCount}`);
    }
    const angles: number[] = [];
    const factors: number[] = [];
    for (let i = 0; i < pairCount; i++) angles.push(take(`TILT angle[${i}]`));
    for (let i = 0; i < pairCount; i++) factors.push(take(`TILT factor[${i}]`));
    tilt = { lampToLuminaireGeometry, angles, factors };
  }

  // Standard 13 photometric header numbers (10 on line 1 + 3 on line 2)
  const lampCount = take("number of lamps");
  const lumensPerLamp = take("lumens per lamp");
  const multiplier = take("candela multiplier");
  const numVerticalAngles = Math.round(take("number of vertical angles"));
  const numHorizontalAngles = Math.round(take("number of horizontal angles"));
  const photometricTypeRaw = Math.round(take("photometric type"));
  const unitsTypeRaw = Math.round(take("units type"));
  const rawWidth = take("luminous opening width");
  const rawLength = take("luminous opening length");
  const rawHeight = take("luminous opening height");
  const ballastFactor = take("ballast factor");
  const futureUse = take("ballast-lamp photometric factor / future use");
  const inputWatts = take("input watts");

  if (numVerticalAngles < 1 || numVerticalAngles > 2000) {
    throw new Error(`Invalid vertical angle count: ${numVerticalAngles}`);
  }
  if (numHorizontalAngles < 1 || numHorizontalAngles > 2000) {
    throw new Error(`Invalid horizontal angle count: ${numHorizontalAngles}`);
  }
  if (photometricTypeRaw !== 1 && photometricTypeRaw !== 2 && photometricTypeRaw !== 3) {
    throw new Error(`Unsupported photometric type ${photometricTypeRaw} (expected 1=Type C, 2=Type B, 3=Type A)`);
  }
  if (unitsTypeRaw !== 1 && unitsTypeRaw !== 2) {
    throw new Error(`Unsupported units type ${unitsTypeRaw} (expected 1=feet, 2=meters)`);
  }
  if (multiplier < 0) throw new Error(`Negative candela multiplier: ${multiplier}`);
  if (inputWatts < 0) throw new Error(`Negative input watts: ${inputWatts}`);

  const verticalAngles: number[] = [];
  for (let i = 0; i < numVerticalAngles; i++) {
    const a = take(`vertical angle[${i}]`);
    if (i > 0 && a < verticalAngles[i - 1]!) {
      throw new Error(`Vertical angles must be non-decreasing (${verticalAngles[i - 1]} followed by ${a})`);
    }
    verticalAngles.push(a);
  }

  const horizontalAngles: number[] = [];
  for (let i = 0; i < numHorizontalAngles; i++) {
    const a = take(`horizontal angle[${i}]`);
    if (i > 0 && a < horizontalAngles[i - 1]!) {
      throw new Error(`Horizontal angles must be non-decreasing (${horizontalAngles[i - 1]} followed by ${a})`);
    }
    horizontalAngles.push(a);
  }

  const candela: number[][] = [];
  let maxRawCandela = 0;
  for (let h = 0; h < numHorizontalAngles; h++) {
    const row: number[] = [];
    for (let v = 0; v < numVerticalAngles; v++) {
      const c = take(`candela[${h}][${v}]`);
      if (c < 0) throw new Error(`Negative candela value ${c} at h=${h}, v=${v}`);
      if (c > maxRawCandela) maxRawCandela = c;
      row.push(c);
    }
    candela.push(row);
  }

  const photometricType = photometricTypeRaw as IesPhotometricType;
  const unitsType = unitsTypeRaw as 1 | 2;
  const unitScale = unitsType === 1 ? FT_TO_M : 1;
  const symmetry = detectSymmetry(horizontalAngles, photometricType);

  // Per ANSI/IES LM-63-19, futureUse is fileGenerationType (e.g. 1.0000 or 2) and is NOT a multiplier.
  // Per IESNA LM-63-1995 / 1991, futureUse is the ballast-lamp photometric factor.
  const blpf = (standard === "LM-63-1995" || standard === "LM-63-1991") && futureUse > 0 ? futureUse : 1;
  const candelaScale = multiplier * ballastFactor * blpf;

  const partial: IesPhotometricWeb = {
    standard,
    header,
    keywords,
    metadata: {
      ...(keywords.TEST ? { test: keywords.TEST } : {}),
      ...(keywords.TESTLAB ? { testlab: keywords.TESTLAB } : {}),
      ...(keywords.ISSUEDATE ? { issuedate: keywords.ISSUEDATE } : {}),
      ...(keywords.MANUFAC ? { manufac: keywords.MANUFAC } : {}),
      ...(keywords.LUMCAT ? { lumcat: keywords.LUMCAT } : {}),
      ...(keywords.LUMINAIRE ? { luminaire: keywords.LUMINAIRE } : {}),
      ...(keywords.LAMPCAT ? { lampcat: keywords.LAMPCAT } : {}),
      ...(keywords.LAMP ? { lamp: keywords.LAMP } : {}),
    },
    tiltMode,
    ...(tiltFile !== undefined ? { tiltFile } : {}),
    ...(tilt !== undefined ? { tilt } : {}),
    lampCount,
    lumensPerLamp,
    multiplier,
    numVerticalAngles,
    numHorizontalAngles,
    photometricType,
    unitsType,
    widthM: Math.abs(rawWidth) * unitScale,
    lengthM: Math.abs(rawLength) * unitScale,
    heightM: Math.abs(rawHeight) * unitScale,
    ballastFactor,
    futureUse,
    inputWatts,
    verticalAngles,
    horizontalAngles,
    candela,
    symmetry,
    candelaScale,
    totalLumens: 0,
    downwardLumens: 0,
    upwardLumens: 0,
    maxCandela: maxRawCandela * candelaScale,
  };

  const integrated = integratePhotometricLumens(partial);
  const ratedLumens = lampCount > 0 && lumensPerLamp > 0 ? lampCount * lumensPerLamp * ballastFactor * blpf : integrated.totalLumens;

  return {
    ...partial,
    totalLumens: ratedLumens,
    downwardLumens: integrated.downwardLumens,
    upwardLumens: integrated.upwardLumens,
  };
}

export function tryParseIesFile(rawText: string): { readonly ok: true; readonly web: IesPhotometricWeb } | { readonly ok: false; readonly error: string } {
  try {
    return { ok: true, web: parseIesFile(rawText) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Fast bounded cache for parsed IES text payloads (avoids re-parsing identical profiles across rooms/renders). */
const PARSE_CACHE = new Map<string, IesPhotometricWeb>();
const MAX_CACHE_ENTRIES = 128;

export function cachedParseIesFile(rawText: string): IesPhotometricWeb {
  const hit = PARSE_CACHE.get(rawText);
  if (hit) return hit;
  const web = parseIesFile(rawText);
  if (PARSE_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldest = PARSE_CACHE.keys().next().value;
    if (oldest !== undefined) PARSE_CACHE.delete(oldest);
  }
  PARSE_CACHE.set(rawText, web);
  return web;
}

/** True when a string looks like an inline IES LM-63 file rather than a short profile id. */
export function looksLikeIesText(value: string): boolean {
  const head = value.slice(0, 600);
  return /(?:^|\n)\s*TILT\s*=/i.test(head) || /^\s*(?:IESNA|ANSI\/IES\s+LM-63)/i.test(head);
}

export { DEG, RAD };
