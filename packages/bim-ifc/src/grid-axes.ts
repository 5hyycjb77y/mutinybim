import { gridAxisFamily, type GridLine } from "@permitzip/bim-kernel";

/**
 * Grid lines sorted into the two axis lists an `IfcGrid` needs. IFC4X3_ADD2
 * declares `UAxes` and `VAxes` as `LIST [1:?]`, so a grid is only a grid
 * when both have a line.
 *
 * The kernel's family (`gridAxisFamily`) splits at 45° to the model's axes,
 * which is right for a grid drawn square to them. A grid turned 45°, or two
 * directions that fall on the same side of 45°, land in one family there.
 * When that happens the lines are split by their own direction instead.
 */

/** Lines within one degree of each other run the same way. */
const SAME_WAY = Math.sin(Math.PI / 180);

interface Dir {
  readonly x: number;
  readonly y: number;
}

function directionOf(gl: GridLine): Dir | null {
  const dx = gl.end.x - gl.start.x;
  const dy = gl.end.y - gl.start.y;
  const length = Math.hypot(dx, dy);
  return Number.isFinite(length) && length > 0 ? { x: dx / length, y: dy / length } : null;
}

const parallel = (a: Dir, b: Dir): boolean => Math.abs(a.x * b.y - a.y * b.x) < SAME_WAY;
const square = (a: Dir, b: Dir): boolean => Math.abs(a.x * b.x + a.y * b.y) < SAME_WAY;

export interface GridAxisLists {
  readonly u: readonly GridLine[];
  readonly v: readonly GridLine[];
  /** Every U line runs one way, every V line another, at a right angle. */
  readonly rectangular: boolean;
  /** Lines with no length: they have no direction and are not written. */
  readonly noLength: readonly GridLine[];
}

/** Sort grid lines into U and V. One of the two is empty only when every line runs the same way (or there is one line). */
export function sortGridAxes(lines: readonly GridLine[]): GridAxisLists {
  const drawn: { readonly line: GridLine; readonly dir: Dir }[] = [];
  const noLength: GridLine[] = [];
  for (const line of lines) {
    const dir = directionOf(line);
    if (dir) drawn.push({ line, dir });
    else noLength.push(line);
  }
  let u = drawn.filter((d) => gridAxisFamily(d.line.start, d.line.end) === "U");
  let v = drawn.filter((d) => gridAxisFamily(d.line.start, d.line.end) === "V");
  if (drawn.length > 0 && (u.length === 0 || v.length === 0)) {
    // All in one family. The line nearest that family's own model axis leads it; lines that run another way are the other family.
    const allU = u.length > 0;
    let lead = drawn[0];
    for (const d of drawn) if (lead && (allU ? Math.abs(d.dir.y) > Math.abs(lead.dir.y) : Math.abs(d.dir.x) > Math.abs(lead.dir.x))) lead = d;
    const along = drawn.filter((d) => lead !== undefined && parallel(d.dir, lead.dir));
    const across = drawn.filter((d) => lead !== undefined && !parallel(d.dir, lead.dir));
    u = allU ? along : across;
    v = allU ? across : along;
  }
  const u0 = u[0];
  const v0 = v[0];
  const rectangular = u0 !== undefined && v0 !== undefined && u.every((d) => parallel(d.dir, u0.dir)) && v.every((d) => parallel(d.dir, v0.dir)) && square(u0.dir, v0.dir);
  return { u: u.map((d) => d.line), v: v.map((d) => d.line), rectangular, noLength };
}
