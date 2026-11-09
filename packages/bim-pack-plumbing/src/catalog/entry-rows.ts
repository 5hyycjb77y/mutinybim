import type { CatalogEntryTypeRow } from "@permitzip/bim-kernel";
import { pipeTypeSchema, type PipeTypeEntry } from "../routing/pipe/pipe-types";
import { plumbingSettingsEntrySchema, type PlumbingSettingsEntry } from "../routing/pipe/plumbing-settings";

declare module "@permitzip/bim-kernel" {
  interface CatalogEntryTypes {
    pipe_type: PipeTypeEntry;
    plumbing_settings: PlumbingSettingsEntry;
  }
}

/**
 * Plumbing and gas's catalog record types (round 12 P12, E12's move
 * handshake for `catalog/**`): pipe types and plumbing settings, contributed
 * to `CATALOG_ENTRY_POINT`. Record types, id prefixes (`etype:pipe:…`,
 * `etype:plumbing:…`) and the trade word saved on each record are frozen;
 * each row reads exactly as round 11's kernel rows did
 * (`p12-catalog-rows-equal-fallback`).
 */

const named = (entry: object): string => {
  const name: unknown = Reflect.get(entry, "name");
  return typeof name === "string" ? name : "";
};

export const PLUMBING_CATALOG_ENTRY_ROWS: readonly CatalogEntryTypeRow[] = [
  { type: "pipe_type", idPrefix: "pipe", label: "Pipe type", schema: pipeTypeSchema, nameOf: named, trade: () => "plumbing" },
  { type: "plumbing_settings", idPrefix: "plumbing", label: "Plumbing settings", schema: plumbingSettingsEntrySchema, nameOf: named, trade: () => "plumbing" },
];
