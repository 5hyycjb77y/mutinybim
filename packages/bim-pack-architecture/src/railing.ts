import {
  type BimElement,
  type ClassSolidPart,
  type ElementKindItem,
  type KindSolidContext,
  type KindSolidShape,
  type PlanGraphic,
  type SectionGraphic,
  type Vec2,
} from "@permitzip/bim-kernel";
import { valueOf } from "./values";

/**
 * First-class architectural railings & guardrails (`architecture.railing` → `IfcRailing`).
 *
 * Follows the Revit / ArchiCAD path-based railing paradigm on top of MutinyBIM's
 * pack bedrock (`ELEMENT_KIND_POINT` + `CLASS_SOLIDS_POINT`):
 * - Supports straight line runs (`start` → `end`) and continuous multi-segment
 *   polylines (`points`) around balconies, mezzanines, and stairwell openings.
 * - Five architectural infill styles: `glass` (tempered Low-E panels in a metal
 *   shoe & top cap), `picket` (vertical balusters obeying the IBC 4" sphere rule),
 *   `cable` (tensioned horizontal stainless cables), `horizontal_bar`, and `solid`.
 * - Optional ADA secondary graspable handrail at 36" (914 mm).
 * - Multi-material 3D output via `railingClassParts` (posts/rails as frame +
 *   translucent `glazing` panels for glass guards), crisp 2D plan & section
 *   graphics, and IBC 1015.3 / 1015.4 code compliance helpers.
 */

export const RAILING_KIND = "architecture.railing";

export type RailingStyle = "glass" | "picket" | "cable" | "horizontal_bar" | "solid";

export const RAILING_STYLE_KEY = "architecture.railing_style";
export const RAILING_HEIGHT_KEY = "architecture.railing_height_mm";
export const RAILING_POST_SPACING_KEY = "architecture.post_spacing_mm";
export const RAILING_BALUSTER_SPACING_KEY = "architecture.baluster_spacing_mm";
export const RAILING_HANDRAIL_KEY = "architecture.rail_handrail";

/** IBC 1015.3 commercial guardrail minimum height: 42" (1067 mm). */
export const IBC_COMMERCIAL_GUARD_MM = 1067;
/** IBC 1015.3 residential / IRC & ADA stair handrail nominal height: 36" (914 mm). */
export const IBC_RESIDENTIAL_GUARD_MM = 914;
/** IBC 1015.4 maximum opening (4" sphere rule): 102 mm. */
export const IBC_MAX_OPENING_MM = 102;
/** Default structural post maximum spacing: 5'-0" (1524 mm). */
export const DEFAULT_POST_SPACING_MM = 1524;
/** Default baluster / cable on-center spacing: 100 mm (~3.94", passes 4" sphere rule). */
export const DEFAULT_BALUSTER_SPACING_MM = 100;

const RAILING_STYLE_SET = new Set<string>(["glass", "picket", "cable", "horizontal_bar", "solid"]);

export interface RailingRecord {
  readonly id: string;
  readonly kind: typeof RAILING_KIND;
  readonly levelId: string;
  readonly start: Vec2;
  readonly end: Vec2;
  /** Optional multi-segment polyline path; when omitted, `[start, end]` is used. */
  readonly points?: readonly Vec2[];
  readonly heightMm: number;
  readonly style?: RailingStyle;
  readonly baseOffsetMm?: number;
  readonly postSpacingMm?: number;
  readonly balusterSpacingMm?: number;
  readonly handrail?: boolean;
  readonly typeId?: string;
  readonly values?: Readonly<Record<string, unknown>>;
}

export interface RailingSpec {
  readonly path: readonly Vec2[];
  readonly lengthMm: number;
  readonly heightMm: number;
  readonly baseOffsetMm: number;
  readonly style: RailingStyle;
  readonly postSpacingMm: number;
  readonly balusterSpacingMm: number;
  readonly handrail: boolean;
  readonly postCount: number;
}

export interface RailingCompliance {
  readonly commercialGuardOk: boolean;
  readonly sphereRuleOk: boolean;
  readonly compliant: boolean;
  readonly issues: readonly string[];
}

type Elements = Readonly<Record<string, BimElement>>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function isPoint(v: unknown): v is Vec2 {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.x === "number" && Number.isFinite(o.x) && typeof o.y === "number" && Number.isFinite(o.y);
}

function parseStyle(v: unknown): RailingStyle | null {
  if (typeof v !== "string") return null;
  const norm = v.trim().toLowerCase();
  return RAILING_STYLE_SET.has(norm) ? (norm as RailingStyle) : null;
}

export function asRailing(el: BimElement): RailingRecord | null {
  if (String(el.kind) !== RAILING_KIND) return null;
  const r = el as unknown as Record<string, unknown>;
  if (typeof r.levelId !== "string" || !isPoint(r.start) || !isPoint(r.end)) return null;
  return r as unknown as RailingRecord;
}

/** Encode a polyline path as a compact `"x,y;x,y;..."` string for `ParamValue`-safe command values. */
export function encodeRailingPath(points: readonly Vec2[]): string {
  return points.map((p) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`).join(";");
}

/** Decode a `"x,y;x,y;..."` (or JSON Vec2[]) string into plan points. */
export function parseRailingPath(raw: unknown): readonly Vec2[] | null {
  if (Array.isArray(raw)) {
    const valid = raw.filter(isPoint);
    return valid.length >= 2 ? valid : null;
  }
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isPoint);
        return valid.length >= 2 ? valid : null;
      }
    } catch {
      return null;
    }
  }
  const pts: Vec2[] = [];
  for (const part of trimmed.split(";")) {
    const [xs, ys] = part.split(",");
    const x = Number(xs);
    const y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({ x, y });
  }
  return pts.length >= 2 ? pts : null;
}

/** Ordered polyline vertices for a railing (falls back to `[start, end]`). */
export function railingPath(r: RailingRecord): readonly Vec2[] {
  if (Array.isArray(r.points) && r.points.length >= 2) {
    const valid = r.points.filter(isPoint);
    if (valid.length >= 2) return valid;
  }
  const fromPath = parseRailingPath(r.values?.["architecture.railing_path"]);
  if (fromPath) return fromPath;
  return [r.start, r.end];
}

function segmentLength(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Resolve live railing parameters (instance values → element type values → record fields → IBC defaults). */
export function railingSpec(r: RailingRecord, elements: Elements): RailingSpec {
  const el = r as unknown as BimElement;
  const path = railingPath(r);
  const styleVal = parseStyle(valueOf(el, elements, RAILING_STYLE_KEY));
  const style: RailingStyle = styleVal ?? parseStyle(r.style) ?? "picket";

  const heightVal = num(valueOf(el, elements, RAILING_HEIGHT_KEY));
  const heightMm = Math.max(300, heightVal && heightVal > 0 ? heightVal : num(r.heightMm) ?? IBC_COMMERCIAL_GUARD_MM);

  const postVal = num(valueOf(el, elements, RAILING_POST_SPACING_KEY));
  const postSpacingMm = Math.max(400, postVal && postVal > 0 ? postVal : num(r.postSpacingMm) ?? DEFAULT_POST_SPACING_MM);

  const balVal = num(valueOf(el, elements, RAILING_BALUSTER_SPACING_KEY));
  const balusterSpacingMm = Math.max(40, balVal && balVal > 0 ? balVal : num(r.balusterSpacingMm) ?? DEFAULT_BALUSTER_SPACING_MM);

  const hrVal = valueOf(el, elements, RAILING_HANDRAIL_KEY);
  const handrail = typeof hrVal === "boolean" ? hrVal : r.handrail === true;

  const baseOffsetMm = num(r.baseOffsetMm) ?? 0;

  let lengthMm = 0;
  let postCount = path.length; // start, every corner vertex, and end
  for (let i = 0; i < path.length - 1; i++) {
    const segLen = segmentLength(path[i]!, path[i + 1]!);
    lengthMm += segLen;
    if (segLen > postSpacingMm + 1) {
      const spans = Math.ceil(segLen / postSpacingMm);
      postCount += Math.max(0, spans - 1);
    }
  }
  return { path, lengthMm, heightMm, baseOffsetMm, style, postSpacingMm, balusterSpacingMm, handrail, postCount };
}

/** IBC 1015.3 (42" commercial guard height) + IBC 1015.4 (4" sphere opening rule) check. */
export function railingCompliance(r: RailingRecord, elements: Elements): RailingCompliance {
  const spec = railingSpec(r, elements);
  const issues: string[] = [];
  const commercialGuardOk = spec.heightMm >= IBC_COMMERCIAL_GUARD_MM - 2;
  if (!commercialGuardOk) {
    issues.push(`Guard height ${Math.round(spec.heightMm)} mm is below IBC 1015.3 commercial minimum (${IBC_COMMERCIAL_GUARD_MM} mm / 42")`);
  }
  // Glass & solid guards are continuous panels; picket, cable, and horizontal_bar must obey the 4" sphere opening rule.
  const barThicknessMm = spec.style === "cable" ? 5 : spec.style === "horizontal_bar" ? 16 : 18;
  const clearOpeningMm = spec.balusterSpacingMm - barThicknessMm;
  const sphereRuleOk = spec.style === "glass" || spec.style === "solid" || clearOpeningMm <= IBC_MAX_OPENING_MM;
  if (!sphereRuleOk) {
    issues.push(`Clear opening ${Math.round(clearOpeningMm)} mm exceeds IBC 1015.4 4" sphere limit (${IBC_MAX_OPENING_MM} mm)`);
  }
  return { commercialGuardOk, sphereRuleOk, compliant: commercialGuardOk && sphereRuleOk, issues };
}

/** Rectangle polygon oriented along unit vector `u` with left normal `n`. */
function orientedRect(a: Vec2, u: Vec2, n: Vec2, s0: number, s1: number, d0: number, d1: number): readonly Vec2[] {
  const at = (s: number, d: number): Vec2 => ({
    x: a.x + u.x * s + n.x * d,
    y: a.y + u.y * s + n.y * d,
  });
  return [at(s0, d0), at(s1, d0), at(s1, d1), at(s0, d1)];
}

/** Square post footprint centered at `p`. */
function squareAt(p: Vec2, halfMm: number): readonly Vec2[] {
  return [
    { x: p.x - halfMm, y: p.y - halfMm },
    { x: p.x + halfMm, y: p.y - halfMm },
    { x: p.x + halfMm, y: p.y + halfMm },
    { x: p.x - halfMm, y: p.y + halfMm },
  ];
}

function addPart(out: ClassSolidPart[], outline: readonly Vec2[], z0: number, z1: number, look?: ClassSolidPart["look"]): void {
  if (z1 <= z0) return;
  out.push({
    shape: { form: "prism", outline, z0, z1, category: "structure", role: "architecture" },
    ...(look ? { look } : {}),
  });
}

/**
 * Full multi-material 3D railing body for `CLASS_SOLIDS_POINT`:
 * - Frame, posts, top rail cap, bottom rail/shoe, pickets/cables/bars, and optional
 *   ADA secondary handrail render with architectural metal/wood (`filler`).
 * - Tempered glass infill panels (`style === "glass"`) render with translucent
 *   `glazing` so balconies and stairwells have crisp see-through architectural glass.
 */
export function railingClassParts(el: BimElement, ctx: KindSolidContext): readonly ClassSolidPart[] | null {
  const r = asRailing(el);
  if (!r) return null;
  const spec = railingSpec(r, ctx.elements);
  if (spec.lengthMm < 10) return null;

  const out: ClassSolidPart[] = [];
  const zFloor = ctx.floorMm + spec.baseOffsetMm;
  const zTop = zFloor + spec.heightMm;

  const postHalf = spec.style === "solid" ? 45 : 22; // 44 mm square steel/aluminum posts
  const topRailThick = 42;
  const topRailHalfW = spec.style === "solid" ? 55 : 28; // 56 mm architectural cap rail
  const zTopRailBot = Math.max(zFloor + 80, zTop - topRailThick);

  // Corner & endpoint posts (placed once per vertex so joined segments never double-post).
  for (let i = 0; i < spec.path.length; i++) {
    const p = spec.path[i]!;
    addPart(out, squareAt(p, postHalf), zFloor, zTopRailBot);
  }

  for (let segIdx = 0; segIdx < spec.path.length - 1; segIdx++) {
    const a = spec.path[segIdx]!;
    const b = spec.path[segIdx + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 10) continue;
    const u: Vec2 = { x: dx / segLen, y: dy / segLen };
    const n: Vec2 = { x: -u.y, y: u.x };

    // Continuous top cap rail spanning slightly past endpoints to cover post tops cleanly.
    addPart(out, orientedRect(a, u, n, -postHalf, segLen + postHalf, -topRailHalfW, topRailHalfW), zTopRailBot, zTop);

    // Intermediate structural posts along this segment.
    const spans = Math.max(1, Math.ceil(segLen / spec.postSpacingMm));
    const spanLen = segLen / spans;
    for (let k = 1; k < spans; k++) {
      const s = k * spanLen;
      const p: Vec2 = { x: a.x + u.x * s, y: a.y + u.y * s };
      addPart(out, squareAt(p, postHalf), zFloor, zTopRailBot);
    }

    // Infill by architectural style.
    if (spec.style === "glass") {
      // Base shoe channel (85 mm tall × 48 mm wide) + 12 mm tempered Low-E glass panels between posts.
      const shoeTop = zFloor + 85;
      addPart(out, orientedRect(a, u, n, postHalf, segLen - postHalf, -24, 24), zFloor, shoeTop);
      const glassBot = shoeTop;
      const glassTop = Math.max(glassBot + 40, zTopRailBot - 10);
      for (let k = 0; k < spans; k++) {
        const s0 = k * spanLen + postHalf + 8;
        const s1 = (k + 1) * spanLen - postHalf - 8;
        if (s1 - s0 > 20) {
          addPart(out, orientedRect(a, u, n, s0, s1, -6, 6), glassBot, glassTop, "glazing");
        }
      }
    } else if (spec.style === "picket") {
      // Bottom rail at 75 mm clear above floor (< 4" sphere) + vertical 18 mm pickets every <= balusterSpacingMm.
      const botRailZ0 = zFloor + 75;
      const botRailZ1 = botRailZ0 + 30;
      addPart(out, orientedRect(a, u, n, postHalf, segLen - postHalf, -18, 18), botRailZ0, botRailZ1);
      const balHalf = 9;
      for (let k = 0; k < spans; k++) {
        const bayStart = k * spanLen + postHalf;
        const bayEnd = (k + 1) * spanLen - postHalf;
        const bayLen = bayEnd - bayStart;
        if (bayLen <= spec.balusterSpacingMm * 0.5) continue;
        const count = Math.max(1, Math.ceil(bayLen / spec.balusterSpacingMm) - 1);
        const step = bayLen / (count + 1);
        for (let j = 1; j <= count; j++) {
          const s = bayStart + j * step;
          addPart(out, orientedRect(a, u, n, s - balHalf, s + balHalf, -balHalf, balHalf), botRailZ1, zTopRailBot);
        }
      }
    } else if (spec.style === "cable") {
      // Tensioned horizontal stainless steel cables spaced <= balusterSpacingMm (~3.75").
      const cableStep = Math.min(spec.balusterSpacingMm, 95);
      const startZ = zFloor + 85;
      const endZ = zTopRailBot - 65;
      const count = Math.max(2, Math.floor((endZ - startZ) / cableStep) + 1);
      const actualStep = count > 1 ? (endZ - startZ) / (count - 1) : 0;
      for (let j = 0; j < count; j++) {
        const cz = startZ + j * actualStep;
        addPart(out, orientedRect(a, u, n, postHalf, segLen - postHalf, -3, 3), cz - 3, cz + 3);
      }
    } else if (spec.style === "horizontal_bar") {
      // Flat architectural horizontal mid-rails (22 mm × 16 mm) spaced <= balusterSpacingMm.
      const barStep = Math.max(85, Math.min(spec.balusterSpacingMm, 110));
      const startZ = zFloor + 85;
      const endZ = zTopRailBot - 75;
      const count = Math.max(3, Math.floor((endZ - startZ) / barStep) + 1);
      const actualStep = count > 1 ? (endZ - startZ) / (count - 1) : 0;
      for (let j = 0; j < count; j++) {
        const bz = startZ + j * actualStep;
        addPart(out, orientedRect(a, u, n, postHalf, segLen - postHalf, -11, 11), bz - 8, bz + 8);
      }
    } else {
      // Solid architectural knee-wall guard (90 mm thick) under the cap rail.
      addPart(out, orientedRect(a, u, n, 0, segLen, -45, 45), zFloor, zTopRailBot);
    }

    // Optional ADA secondary graspable handrail at 36" (914 mm), offset 65 mm inside (+n).
    if (spec.handrail) {
      const hrZ = Math.min(zTopRailBot - 40, zFloor + IBC_RESIDENTIAL_GUARD_MM);
      addPart(out, orientedRect(a, u, n, 20, segLen - 20, 48, 84), hrZ - 18, hrZ + 18);
      for (let k = 0; k <= spans; k++) {
        const s = Math.max(40, Math.min(segLen - 40, k * spanLen));
        addPart(out, orientedRect(a, u, n, s - 10, s + 10, postHalf, 54), hrZ - 10, hrZ + 10);
      }
    }
  }

  return out;
}

export const RAILING_KIND_ROW: ElementKindItem = {
  kind: RAILING_KIND,
  label: "Railing",
  nature: "physical",
  newForOlderPeers: true,
  shape: {
    fields: [
      { name: "levelId", form: "id" },
      { name: "start", form: "point" },
      { name: "end", form: "point" },
      { name: "heightMm", form: "number" },
      { name: "style", form: "string", optional: true },
      { name: "baseOffsetMm", form: "number", optional: true },
      { name: "postSpacingMm", form: "number", optional: true },
      { name: "balusterSpacingMm", form: "number", optional: true },
      { name: "handrail", form: "boolean", optional: true },
    ],
    points: (el) => {
      const r = asRailing(el);
      return r ? railingPath(r) : [];
    },
  },
  create: {
    placements: ["line"],
    make(input, elements) {
      if (input.placement.kind !== "line") return { refused: "A railing is drawn along a line: click its start, then its end" };
      const { start, end } = input.placement;
      if (segmentLength(start, end) < 100) {
        return { refused: "A railing run must be at least 100 mm long" };
      }
      const heightMm = num(input.values?.[RAILING_HEIGHT_KEY]) ?? input.size?.heightMm ?? IBC_COMMERCIAL_GUARD_MM;
      const style = parseStyle(input.values?.[RAILING_STYLE_KEY]) ?? "picket";
      const postSpacingMm = num(input.values?.[RAILING_POST_SPACING_KEY]) ?? DEFAULT_POST_SPACING_MM;
      const balusterSpacingMm = num(input.values?.[RAILING_BALUSTER_SPACING_KEY]) ?? DEFAULT_BALUSTER_SPACING_MM;
      const handrail = input.values?.[RAILING_HANDRAIL_KEY] === true;
      const points = parseRailingPath(input.values?.["architecture.railing_path"]) ?? undefined;
      const baseOffsetMm = num(input.values?.["architecture.base_offset_mm"]) ?? 0;

      const lvl = elements[input.levelId];
      const levelName = lvl?.kind === "level" ? lvl.name : input.levelId;
      const rec: RailingRecord = {
        id: input.id,
        kind: RAILING_KIND,
        levelId: input.levelId,
        start: points && points.length >= 2 ? points[0]! : start,
        end: points && points.length >= 2 ? points[points.length - 1]! : end,
        ...(points && points.length >= 2 ? { points } : {}),
        heightMm: Math.max(300, Math.round(heightMm)),
        style,
        ...(baseOffsetMm !== 0 ? { baseOffsetMm } : {}),
        postSpacingMm: Math.max(400, Math.round(postSpacingMm)),
        balusterSpacingMm: Math.max(40, Math.round(balusterSpacingMm)),
        ...(handrail ? { handrail: true } : {}),
        ...(input.typeId ? { typeId: input.typeId } : {}),
        ...(input.values ? { values: input.values } : {}),
      };
      return {
        ...rec,
        partition: { level: levelName, zone: "*", discipline: "architecture" },
        version: 0,
        authoredRev: {},
      } as unknown as BimElement;
    },
  },
  planGraphics(el, ctx) {
    // Railings are floor-level architectural guards; omit from Reflected Ceiling Plans.
    if (ctx.lookingUp) return [];
    const r = asRailing(el);
    if (!r) return [];
    const spec = railingSpec(r, ctx.elements);
    if (spec.lengthMm < 10) return [];
    const out: PlanGraphic[] = [];
    const railHalf = spec.style === "solid" ? 45 : 26;
    const postHalf = 34;

    for (let segIdx = 0; segIdx < spec.path.length - 1; segIdx++) {
      const a = spec.path[segIdx]!;
      const b = spec.path[segIdx + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 10) continue;
      const u: Vec2 = { x: dx / segLen, y: dy / segLen };
      const n: Vec2 = { x: -u.y, y: u.x };
      // Double-line top rail body with crisp opaque mask.
      out.push({
        form: "polyline",
        points: orientedRect(a, u, n, 0, segLen, -railHalf, railHalf),
        closed: true,
        pen: "medium",
        fill: "#ffffff",
      });
      // Centerline hairline for glass/cable indication in plan.
      if (spec.style === "glass" || spec.style === "cable") {
        out.push({ form: "line", a, b, pen: "thin" });
      }
      // Intermediate post ticks.
      const spans = Math.max(1, Math.ceil(segLen / spec.postSpacingMm));
      for (let k = 1; k < spans; k++) {
        const s = (k * segLen) / spans;
        const p: Vec2 = { x: a.x + u.x * s, y: a.y + u.y * s };
        out.push({ form: "polyline", points: squareAt(p, postHalf), closed: true, pen: "thin", fill: "#ffffff" });
      }
    }
    // Corner & end post markers.
    for (const p of spec.path) {
      out.push({ form: "polyline", points: squareAt(p, postHalf), closed: true, pen: "medium", fill: "#ffffff" });
    }
    return out;
  },
  solid(el, ctx): KindSolidShape | null {
    const parts = railingClassParts(el, ctx);
    if (!parts || parts.length === 0) return null;
    const blocks = parts.flatMap((p) => (p.shape.form === "prism" ? [{ outline: p.shape.outline, z0: p.shape.z0, z1: p.shape.z1 }] : p.shape.form === "prisms" ? [...p.shape.blocks] : []));
    if (blocks.length === 0) return null;
    return { form: "prisms", blocks, category: "structure", role: "architecture" };
  },
  sectionGraphics(el, ctx): readonly SectionGraphic[] {
    const r = asRailing(el);
    if (!r) return [];
    const spec = railingSpec(r, ctx.elements);
    if (spec.lengthMm < 10) return [];
    const lvl = ctx.elements[r.levelId];
    const floorMm = lvl?.kind === "level" ? lvl.elevationMm : ctx.floorMm;
    const z0 = floorMm + spec.baseOffsetMm;
    const z1 = z0 + spec.heightMm;
    const projU = (p: Vec2): number => (p.x - ctx.cutStart.x) * ctx.axis.x + (p.y - ctx.cutStart.y) * ctx.axis.y;
    const projDepth = (p: Vec2): number => (p.x - ctx.cutStart.x) * ctx.look.x + (p.y - ctx.cutStart.y) * ctx.look.y;

    const out: SectionGraphic[] = [];
    for (let segIdx = 0; segIdx < spec.path.length - 1; segIdx++) {
      const a = spec.path[segIdx]!;
      const b = spec.path[segIdx + 1]!;
      const dA = projDepth(a);
      const dB = projDepth(b);
      if (Math.max(dA, dB) < -50 || Math.min(dA, dB) > ctx.depthMm + 50) continue;
      const depthMm = (dA + dB) / 2;
      const uA = projU(a);
      const uB = projU(b);
      const u0 = Math.min(uA, uB);
      const u1 = Math.max(uA, uB);
      const segLen = segmentLength(a, b);
      // Top cap rail + bottom shoe/rail + end posts.
      out.push(
        { depthMm, graphic: { form: "line", a: { x: u0, y: z1 }, b: { x: u1, y: z1 }, pen: "medium" } },
        { depthMm, graphic: { form: "line", a: { x: u0, y: z1 - 42 }, b: { x: u1, y: z1 - 42 }, pen: "thin" } },
        { depthMm, graphic: { form: "line", a: { x: u0, y: z0 + 85 }, b: { x: u1, y: z0 + 85 }, pen: "thin" } },
        { depthMm, graphic: { form: "line", a: { x: u0, y: z0 }, b: { x: u0, y: z1 }, pen: "medium" } },
        { depthMm, graphic: { form: "line", a: { x: u1, y: z0 }, b: { x: u1, y: z1 }, pen: "medium" } },
      );
      if (u1 - u0 > 80) {
        const spans = Math.max(1, Math.ceil(segLen / spec.postSpacingMm));
        for (let k = 1; k < spans; k++) {
          const uPost = u0 + ((u1 - u0) * k) / spans;
          out.push({ depthMm, graphic: { form: "line", a: { x: uPost, y: z0 }, b: { x: uPost, y: z1 - 42 }, pen: "thin" } });
        }
      }
    }
    return out;
  },
};
