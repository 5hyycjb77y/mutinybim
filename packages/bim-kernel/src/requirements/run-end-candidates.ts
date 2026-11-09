import { primaryQuantity } from "../load-points/model";
import type { LoadPointElement } from "../load-points/types";
import { elementsOfKind } from "../store";
import type { SystemKind } from "../parts";
import type { BimElement } from "../types";
import { devicePartOf, loadAnchorOf } from "./anchor";
import { loadValueOf } from "./allocation";
import { NO_SPACES } from "./locator";

type Elements = Readonly<Record<string, BimElement>>;

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The loads a person can put on an open end of a run of `systemKind` with
 * `move_load` (the row keeps its id, so totals don't change): typed rows and
 * points, never a load already on a run end, a device, or an estimate spread
 * over a space. Only loads that add that system's quantity: cold water fixture
 * units on cold water, drainage fixture units on sanitary, gas input on gas.
 * In mark order. Indexed by kind; no model scan.
 */
export function loadsForRunEnd(elements: Elements, systemKind: SystemKind | null): LoadPointElement[] {
  const q = primaryQuantity(systemKind);
  if (!q) return [];
  const out: LoadPointElement[] = [];
  for (const lp of elementsOfKind(elements, "load_point")) {
    const a = loadAnchorOf(lp);
    if ((a.kind !== "none" && a.kind !== "point") || devicePartOf(lp)) continue;
    if (loadValueOf(elements, lp, NO_SPACES)[q] <= 0) continue;
    out.push(lp);
  }
  return out.sort((x, y) => COLLATOR.compare(x.mark ?? x.id, y.mark ?? y.id));
}
