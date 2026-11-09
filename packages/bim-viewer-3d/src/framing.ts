interface Box {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * Drop far-flung strays (site survey points, a stray family at the project base
 * point) so "fit" frames the building rather than everything ever placed.
 * Keeps boxes whose centre lies inside the central `keep` share of centres on
 * both plan axes, padded by 10%.
 */
export function robustCore<T extends Box>(boxes: readonly T[], keep = 0.98): T[] {
  if (boxes.length < 20) return [...boxes];
  const centers = boxes.map((b) => ({ x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2 }));
  const lo = (1 - keep) / 2;
  const range = (axis: "x" | "z"): readonly [number, number] => {
    const v = centers.map((c) => c[axis]).sort((a, b) => a - b);
    const a = v[Math.floor(lo * (v.length - 1))] ?? 0;
    const b = v[Math.ceil((1 - lo) * (v.length - 1))] ?? 0;
    const pad = (b - a) * 0.1;
    return [a - pad, b + pad];
  };
  const [x0, x1] = range("x");
  const [z0, z1] = range("z");
  return boxes.filter((_, i) => {
    const c = centers[i];
    return c !== undefined && c.x >= x0 && c.x <= x1 && c.z >= z0 && c.z <= z1;
  });
}
