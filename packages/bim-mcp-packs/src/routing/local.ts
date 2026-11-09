import { memoryRouteDefaults } from "../models/local";
import type { BimRoutingToolOptions } from "./routing";

/** The routing tools on a local server: route defaults held in memory for as long as the server runs. */
export function localRoutingTools(): BimRoutingToolOptions {
  return { routeDefaults: memoryRouteDefaults().store };
}
