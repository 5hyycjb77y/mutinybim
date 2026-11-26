import {
  building,
  checks,
  documents,
  drafting,
  electrical,
  equipment,
  KIT_ENTRIES,
  parts,
  routes,
  units,
} from "../src/index";

/**
 * Zero-gap scripting discoverability contract:
 * Every callable helper exported on every `@permitzip/bim-script` kit namespace MUST have
 * a matching `KIT_ENTRIES` record (which powers incremental `bim_script_reference` topic
 * search AND auto-generated `docs/reference/script-kit/*.md` on docs.mutinybim.com),
 * and no `KIT_ENTRIES` record may reference a removed/renamed kit function.
 */
const KIT_NAMESPACES: Readonly<Record<string, Record<string, unknown>>> = {
  units: units as unknown as Record<string, unknown>,
  parts: parts as unknown as Record<string, unknown>,
  routes: routes as unknown as Record<string, unknown>,
  building: building as unknown as Record<string, unknown>,
  equipment: equipment as unknown as Record<string, unknown>,
  documents: documents as unknown as Record<string, unknown>,
  drafting: drafting as unknown as Record<string, unknown>,
  checks: checks as unknown as Record<string, unknown>,
  electrical: electrical as unknown as Record<string, unknown>,
};

describe("bim-script reference auto-discovery coverage", () => {
  const exportedFunctions = new Set<string>();
  const exportedMembers = new Set<string>();
  for (const [ns, obj] of Object.entries(KIT_NAMESPACES)) {
    for (const [key, value] of Object.entries(obj)) {
      exportedMembers.add(`${ns}.${key}`);
      if (typeof value === "function") exportedFunctions.add(`${ns}.${key}`);
    }
  }

  const entryByName = new Map(KIT_ENTRIES.map((e) => [e.name, e]));

  it("documents every exported kit function in KIT_ENTRIES (zero drift between code and reference/docs)", () => {
    const missing = [...exportedFunctions].filter((name) => !entryByName.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("has no stale KIT_ENTRIES pointing to removed or renamed kit members", () => {
    const knownNamespaces = new Set(Object.keys(KIT_NAMESPACES));
    const stale = KIT_ENTRIES.map((e) => e.name)
      .filter((name) => {
        const dot = name.indexOf(".");
        if (dot <= 0) return false;
        const ns = name.slice(0, dot);
        if (!knownNamespaces.has(ns)) return false;
        return !exportedMembers.has(name);
      })
      .sort();
    expect(stale).toEqual([]);
  });

  it("requires every KIT_ENTRIES record to have non-empty summary, signature, and search topics for incremental discovery", () => {
    const incomplete = KIT_ENTRIES.filter(
      (e) => !e.summary.trim() || !e.signature.trim() || e.topics.length === 0,
    ).map((e) => e.name);
    expect(incomplete).toEqual([]);
  });
});
