"use client";

import type { ComponentProps } from "react";

/**
 * The grid's own control primitives: in-cell editors and the small buttons a
 * cell carries (expand, go to source) plus the find bar's. They are styled by
 * `grid.css`, not Tailwind, so the grid draws the same in any host. A host
 * that wants its own look restyles the `mutiny-grid-*` classes.
 */

export function GridButton({ type = "button", ...props }: ComponentProps<"button">) {
  return <button type={type} {...props} />;
}

export function CellInput(props: ComponentProps<"input">) {
  return <input {...props} />;
}

export function CellSelect(props: ComponentProps<"select">) {
  return <select {...props} />;
}
