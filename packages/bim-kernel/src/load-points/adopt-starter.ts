import { canonicalJson } from "../canonical";
import { catalogElementId, connectionTypeOf } from "../catalog/model";
import { connectionTypeTrade, type ServiceCatalogElement } from "../catalog/types";
import type { AuthoredWrite } from "../command-core";
import type { TrackedReader } from "../model";
import { GLOBAL_PARTITION } from "../partition";
import type { BimElement, ElementId } from "../types";
import { starterConnectionType } from "./starter-types";

/**
 * A placed part names a connection type (its own `connection_type`, else its
 * type's starter `default_connection_type`): when the project's catalog
 * doesn't have it yet and an add-on in force has it as a starter, the same
 * edit adds it, as a load point naming it does. So the part's loads (and the
 * schedules that read them) fill in the moment it is placed, and one Undo
 * takes both away. Returns what it added, in words, or null.
 */
export function adoptPartStarterConnectionType(
  reader: TrackedReader,
  working: Record<string, BimElement>,
  touched: ElementId[],
  authored: AuthoredWrite[],
  typeValues: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
): string | null {
  const own = values.connection_type;
  const named = typeof own === "string" && own.trim() !== "" ? own : typeValues.default_connection_type;
  if (typeof named !== "string" || named.trim() === "") return null;
  const ctId = catalogElementId("connection_type", named);
  reader.find(ctId);
  if (connectionTypeOf(working, named)) return null;
  const starter = starterConnectionType(named);
  if (!starter) return null;
  const record: ServiceCatalogElement = { id: catalogElementId("connection_type", starter.designator), version: 0, authoredRev: {}, partition: GLOBAL_PARTITION, kind: "service_catalog", trade: connectionTypeTrade(starter), entry: starter };
  working[record.id] = record;
  touched.push(record.id);
  authored.push({ elementId: record.id, field: "catalog", value: canonicalJson(starter) });
  return `Added connection type ${starter.designator} (${starter.description}) from the starter list`;
}
