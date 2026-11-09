/**
 * @jest-environment node
 *
 * Round 12 lane P12 (E12's move handshake for `catalog/**`, closed): the
 * pipe type and plumbing settings record types are the Plumbing and gas
 * add-on's rows, and read exactly as round 11's kernel rows did: the same
 * stored type, id prefix, label, name and trade word, and a writer that
 * accepts and refuses the same records. The kernel's transitional fallback
 * holds no row for them any more. Installs only Plumbing and gas
 * (@mutinybim-bare-kernel).
 *
 * Fails on round 11's code: the add-on contributed no catalog record types
 * (both were a closed kernel list).
 */
import { CATALOG_ENTRY_POINT } from "@permitzip/bim-kernel";
import { activePackSet, installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { BUILTIN_PIPE_TYPES, DEFAULT_PLUMBING_SETTINGS_ENTRY, PLUMBING_CATALOG_ENTRY_ROWS, PLUMBING_GAS_PACK } from "@permitzip/bim-pack-plumbing";

/** Round 11's two kernel rows (git 6eccc2969 `catalog/types.ts`), as data. */
const ROUND_11 = [
  { type: "pipe_type", idPrefix: "pipe", label: "Pipe type", trade: "plumbing" },
  { type: "plumbing_settings", idPrefix: "plumbing", label: "Plumbing settings", trade: "plumbing" },
];

describe("p12-catalog-rows-equal-fallback", () => {
  it("the add-on's rows keep round 11's stored type, id prefix, label and trade word", () => {
    expect(PLUMBING_CATALOG_ENTRY_ROWS.map((r) => ({ type: r.type, idPrefix: r.idPrefix, label: r.label, trade: r.trade?.({}) }))).toEqual(ROUND_11);
    // Round 13's kernel stand-in list held no row (frozen bytes); round 14 deleted the file.
    const frozen = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "k14-round13-stand-ins.json"), "utf8")) as { catalogEntries: readonly string[] };
    expect(frozen.catalogEntries).toEqual([]);
    expect(existsSync(path.join(__dirname, "../src/catalog/entry-fallback.ts"))).toBe(false);
  });

  it("their writers accept every built-in record and name a record by its name", () => {
    const [pipeType, settings] = PLUMBING_CATALOG_ENTRY_ROWS;
    if (!pipeType || !settings) throw new Error("two rows");
    for (const t of BUILTIN_PIPE_TYPES) {
      expect(pipeType.schema.safeParse(t).success).toBe(true);
      expect(pipeType.nameOf(t)).toBe(t.name);
    }
    expect(pipeType.schema.safeParse({ type: "pipe_type", name: "X", material: "copper", minIn: 4, maxIn: 1 }).success).toBe(false);
    expect(settings.schema.safeParse(DEFAULT_PLUMBING_SETTINGS_ENTRY).success).toBe(true);
    expect(settings.nameOf(DEFAULT_PLUMBING_SETTINGS_ENTRY)).toBe("Project");
    expect(settings.nameOf({})).toBe("");
  });

  it("the set in force reads the add-on's rows for both types", () => {
    installFirstPartyPacks([PLUMBING_GAS_PACK]);
    const rows = activePackSet().items(CATALOG_ENTRY_POINT);
    for (const own of PLUMBING_CATALOG_ENTRY_ROWS) expect(rows.find((r) => r.type === own.type)).toBe(own);
  });
});
