import type { ResolvedConnector, ResolvedPrimitive, ResolvedSymbol } from "../parts";

/**
 * What covers a duct opening to outdoors: a weather hood (a box out from the
 * opening with its mouth turned down), a louver (blades in a shallow frame) or
 * a bird / insect screen. It belongs to the connector it covers, so it is
 * drawn wherever the part is drawn: live 3D, printed views and the plan.
 */
export const INTAKE_KINDS = ["hood", "louver", "screen"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

export const INTAKE_LABELS: Readonly<Record<IntakeKind, string>> = { hood: "Weather hood", louver: "Louver", screen: "Screen" };

/** A placed part's choice per connector: a kind, or "none" to take the type's hood off. */
export type IntakeChoice = IntakeKind | "none";

const FRAME_MM = 50;
const LOUVER_DEPTH_MM = 100;
const SCREEN_DEPTH_MM = 25;
/** A hood stands out from the opening about three quarters of its height, and at least this far. */
const HOOD_MIN_DEPTH_MM = 300;

/** The connectors a hood, louver or screen goes on: duct openings that take or give outdoor air. */
export function takesIntake(c: Pick<ResolvedConnector, "domain" | "systemKind">): boolean {
  return c.domain === "duct" && (c.systemKind === "outside_air" || c.systemKind === "exhaust_air");
}

/** The hood, louver or screen on each connector: the part's own choice, else the type's. */
export function intakeOf(c: ResolvedConnector, choices: Readonly<Record<string, IntakeChoice>> | undefined): IntakeKind | null {
  const choice = choices?.[c.id];
  if (choice === "none") return null;
  return choice ?? c.intake ?? null;
}

interface Opening {
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
  /** Across the opening: the two other axes' extents, in axis order. */
  readonly across: readonly [number, number];
}

/** The opening's size and which local axis it faces along; null when it faces off-axis (no box fits it). */
function openingOf(c: ResolvedConnector): Opening | null {
  const [dx, dy, dz] = c.direction;
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  const d = [dx / len, dy / len, dz / len];
  const axis = d.findIndex((v) => Math.abs(v) > 0.999);
  if (axis !== 0 && axis !== 1 && axis !== 2) return null;
  const w = c.shape === "round" ? (c.diameter ?? 0) : (c.width ?? 0);
  const h = c.shape === "round" ? (c.diameter ?? 0) : (c.height ?? 0);
  if (w <= 0 || h <= 0) return null;
  // Width across the first of the other two axes, height across the second (z when the opening faces sideways).
  return { axis, sign: (d[axis] ?? 0) > 0 ? 1 : -1, across: [w, h] };
}

function depthOf(kind: IntakeKind, o: Opening): number {
  if (kind === "louver") return LOUVER_DEPTH_MM;
  if (kind === "screen") return SCREEN_DEPTH_MM;
  return Math.max(HOOD_MIN_DEPTH_MM, Math.round(0.75 * Math.max(o.across[0], o.across[1])));
}

function boxAlong(c: ResolvedConnector, o: Opening, depth: number, grow: number): ResolvedPrimitive {
  const center: [number, number, number] = [c.position[0], c.position[1], c.position[2]];
  center[o.axis] = (center[o.axis] ?? 0) + (o.sign * depth) / 2;
  const others = ([0, 1, 2] as const).filter((k) => k !== o.axis);
  const size: [number, number, number] = [0, 0, 0];
  size[o.axis] = depth;
  others.forEach((k, i) => {
    size[k] = (o.across[i] ?? 0) + 2 * grow;
  });
  return { kind: "box", center, size };
}

/** The solid each hood, louver or screen adds, in the part's own frame. */
export function intakePrimitives(connectors: readonly ResolvedConnector[], choices: Readonly<Record<string, IntakeChoice>> | undefined): ResolvedPrimitive[] {
  const out: ResolvedPrimitive[] = [];
  for (const c of connectors) {
    const kind = intakeOf(c, choices);
    if (!kind) continue;
    const o = openingOf(c);
    if (!o) continue;
    out.push(boxAlong(c, o, depthOf(kind, o), kind === "screen" ? 0 : FRAME_MM));
  }
  return out;
}

/**
 * Plan linework: the outline of each hood, louver or screen seen from above,
 * a hood's mouth as a V back to the opening, a louver's blades as lines across it.
 */
export function intakeSymbols(connectors: readonly ResolvedConnector[], choices: Readonly<Record<string, IntakeChoice>> | undefined): ResolvedSymbol[] {
  const out: ResolvedSymbol[] = [];
  for (const c of connectors) {
    const kind = intakeOf(c, choices);
    if (!kind) continue;
    const o = openingOf(c);
    if (!o) continue;
    const box = boxAlong(c, o, depthOf(kind, o), kind === "screen" ? 0 : FRAME_MM);
    if (box.kind !== "box") continue;
    const [cx, cy] = box.center;
    const [sx, sy] = box.size;
    out.push({ kind: "rect", center: { x: cx, y: cy }, size: { x: sx, y: sy } });
    // Seen from above, an opening facing up or down shows only its outline.
    if (o.axis === 2) continue;
    const along = o.axis === 0 ? { x: o.sign, y: 0 } : { x: 0, y: o.sign };
    const side = o.axis === 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const halfAcross = (o.axis === 0 ? sy : sx) / 2;
    const depth = o.axis === 0 ? sx : sy;
    const face = { x: c.position[0], y: c.position[1] };
    const mouth = { x: face.x + along.x * depth, y: face.y + along.y * depth };
    if (kind === "hood") {
      out.push({ kind: "line", from: { x: mouth.x + side.x * halfAcross, y: mouth.y + side.y * halfAcross }, to: face });
      out.push({ kind: "line", from: { x: mouth.x - side.x * halfAcross, y: mouth.y - side.y * halfAcross }, to: face });
    } else if (kind === "louver") {
      for (const t of [-0.5, 0, 0.5]) {
        const at = { x: face.x + side.x * halfAcross * t, y: face.y + side.y * halfAcross * t };
        out.push({ kind: "line", from: at, to: { x: at.x + along.x * depth, y: at.y + along.y * depth } });
      }
    }
  }
  return out;
}
