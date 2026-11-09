/** Plain-words measurements for messages: feet-and-inches like a drawing, inches for small gaps. */

const MM_PER_IN = 25.4;
const MM_PER_FT = 304.8;

export function inches(mm: number): string {
  const v = Math.round((mm / MM_PER_IN) * 4) / 4;
  return `${v} in.`;
}

export function feetInches(mm: number): string {
  const sign = mm < 0 ? "-" : "";
  const totalIn = Math.round(Math.abs(mm) / MM_PER_IN);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn - ft * 12;
  return `${sign}${ft}'-${inch}"`;
}

export function feet(mm: number, digits = 1): number {
  return Math.round((mm / MM_PER_FT) * 10 ** digits) / 10 ** digits;
}

/** Eight-point compass direction from `from` to `to` in plan (plan north is +y). */
export function compass(dx: number, dy: number): string {
  if (Math.hypot(dx, dy) < 1) return "here";
  const names = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"];
  const a = Math.atan2(dy, dx);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return names[i] as string;
}

export function clip(text: string, max = 160): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
