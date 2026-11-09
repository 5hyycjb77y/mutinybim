import { BASE_DIMENSIONS, type BaseDimension, type Dimension } from "./types";

export const DIMENSIONLESS: Dimension = Object.freeze({ L: 0, M: 0, T: 0, I: 0, Th: 0, N: 0, J: 0, A: 0, C: 0, $: 0 });

/** `dim({ L: 1, T: -1 })` is a velocity. Unspecified exponents are 0. */
export function dim(exponents: Partial<Record<BaseDimension, number>>): Dimension {
  return Object.freeze({ ...DIMENSIONLESS, ...exponents });
}

export function sameDimension(a: Dimension, b: Dimension): boolean {
  for (const d of BASE_DIMENSIONS) if (a[d] !== b[d]) return false;
  return true;
}

export function multiplyDimensions(a: Dimension, b: Dimension): Dimension {
  const out: Record<BaseDimension, number> = { ...DIMENSIONLESS };
  for (const d of BASE_DIMENSIONS) out[d] = a[d] + b[d];
  return Object.freeze(out);
}

export function divideDimensions(a: Dimension, b: Dimension): Dimension {
  const out: Record<BaseDimension, number> = { ...DIMENSIONLESS };
  for (const d of BASE_DIMENSIONS) out[d] = a[d] - b[d];
  return Object.freeze(out);
}

export function powDimension(a: Dimension, exponent: number): Dimension {
  const out: Record<BaseDimension, number> = { ...DIMENSIONLESS };
  for (const d of BASE_DIMENSIONS) out[d] = a[d] * exponent;
  return Object.freeze(out);
}

/** "L·T^-1", "1" when dimensionless. For messages. */
export function describeDimension(a: Dimension): string {
  const parts: string[] = [];
  for (const d of BASE_DIMENSIONS) if (a[d] !== 0) parts.push(a[d] === 1 ? d : `${d}^${a[d]}`);
  return parts.length > 0 ? parts.join("·") : "1";
}
