/**
 * Plan symbol or 3D body (KERNEL-FOUNDATION §3.12, "plan symbols separate
 * from bodies"). A part type says how plans draw it (`model.planDisplay`);
 * a category override in a view can say "symbol" or "body" for every part
 * of that category. A plan symbol prints as its symbol lines, never as a
 * cut through the part's 3D body.
 */
export type PlanDisplay = "symbol" | "model" | "both";

export interface PlanDisplayInputs {
  /** The part type's own choice; absent: its symbol. */
  readonly typeDisplay: PlanDisplay | undefined;
  /** The type has symbol lines to draw. */
  readonly hasSymbol: boolean;
  /** The type has a 3D body plans can project. */
  readonly hasBody: boolean;
}

/**
 * How plans draw a part: the view's category answer when the part can draw
 * that way, otherwise the type's. Null (no override) is the type's choice,
 * so views without an override draw exactly as before.
 */
export function planDisplayFor(planSymbol: boolean | null, inputs: PlanDisplayInputs): PlanDisplay {
  const own: PlanDisplay = inputs.typeDisplay ?? "symbol";
  if (planSymbol === true && inputs.hasSymbol) return "symbol";
  if (planSymbol === false && inputs.hasBody) return "model";
  return own;
}
