/**
 * @jest-environment node
 *
 * Each system kind's standard look now lives on its service row
 * (ServiceDef.graphics) and routing/system-graphics.ts reads the registry.
 * The round-4 kinds must draw byte-identically on screen and on paper, a kind
 * this reader doesn't know draws as Other instead of crashing, and grease
 * waste draws heavy by default.
 */
import { systemKindLook, systemStyle, type SystemGraphics } from "../src/routing/system-graphics";
import type { SystemKind } from "../src/parts";

/** `SYSTEM_KIND_LOOK` as it was before the registry (round 4, e88144729). */
const OLD_LOOK: Readonly<Record<string, { colour: string; pattern: string }>> = {
  supply_air: { colour: "#2f7fd8", pattern: "solid" },
  return_air: { colour: "#b04fc8", pattern: "solid" },
  exhaust_air: { colour: "#a0682a", pattern: "solid" },
  outside_air: { colour: "#3fa34d", pattern: "solid" },
  domestic_cold_water: { colour: "#1f6fd1", pattern: "dash_dot" },
  domestic_hot_water: { colour: "#d1351f", pattern: "dash_dot_dot" },
  domestic_hot_water_return: { colour: "#e57b2a", pattern: "dash_dot_dot_dot" },
  sanitary: { colour: "#8a5a2b", pattern: "solid" },
  vent: { colour: "#5f8f1f", pattern: "dashed" },
  storm: { colour: "#1f9a91", pattern: "solid" },
  natural_gas: { colour: "#d9a800", pattern: "long_dash" },
  hydronic_supply: { colour: "#c2185b", pattern: "solid" },
  hydronic_return: { colour: "#7b1fa2", pattern: "solid" },
  condensate: { colour: "#26a69a", pattern: "dotted" },
  refrigerant: { colour: "#0097a7", pattern: "solid" },
  power: { colour: "#d9a21b", pattern: "solid" },
  lighting: { colour: "#e0b23a", pattern: "solid" },
  data: { colour: "#607d8b", pattern: "solid" },
  fire_alarm: { colour: "#d8463b", pattern: "solid" },
  other: { colour: "#2ea86b", pattern: "solid" },
};

/** What systemStyle returned before, from the old table, for the same system. */
const DASH: Readonly<Record<string, readonly number[] | undefined>> = { solid: undefined, dashed: [4, 2], dotted: [0.3, 1], dash_dot: [6, 1.5, 1, 1.5], dash_dot_dot: [6, 1.5, 1, 1.5, 1, 1.5], dash_dot_dot_dot: [6, 1.5, 1, 1.5, 1, 1.5, 1, 1.5], long_dash: [10, 2] };
function oldStyle(kind: string, g: SystemGraphics | undefined) {
  const look = OLD_LOOK[kind];
  if (!look) throw new Error(`no old look for ${kind}`);
  const ownColour = g?.colour !== undefined && /^#[0-9a-f]{6}$/.test(g.colour);
  const pattern = g?.pattern ?? look.pattern;
  return { colour: ownColour && g?.colour ? g.colour : look.colour, pattern, dash: DASH[pattern], weight: g?.weight, overridden: { colour: ownColour, pattern: g?.pattern !== undefined, weight: g?.weight !== undefined } };
}

const OVERRIDES: readonly (SystemGraphics | undefined)[] = [undefined, {}, { colour: "#123456" }, { pattern: "dashed" }, { weight: "heavy" }, { colour: "#abcdef", pattern: "long_dash", weight: "thin" }];

describe("system looks from the service registry", () => {
  it("every round-4 kind keeps its colour and pattern exactly", () => {
    for (const [kind, look] of Object.entries(OLD_LOOK)) expect([kind, systemKindLook(kind)]).toEqual([kind, look]);
  });

  it("systemStyle is byte-identical for every round-4 kind, with and without overrides", () => {
    for (const kind of Object.keys(OLD_LOOK)) {
      for (const graphics of OVERRIDES) {
        const now = systemStyle({ systemKind: kind as SystemKind, ...(graphics ? { graphics } : {}) });
        expect(JSON.stringify(now)).toBe(JSON.stringify(oldStyle(kind, graphics)));
      }
    }
  });

  it("a kind this reader doesn't know draws as Other, never crashes", () => {
    const unknown = "future_kind" as SystemKind;
    expect(systemKindLook("future_kind")).toEqual(OLD_LOOK.other);
    expect(systemStyle({ systemKind: unknown })).toMatchObject({ colour: "#2ea86b", pattern: "solid", weight: undefined });
    expect(systemStyle({ systemKind: unknown, graphics: { colour: "#010203" } }).colour).toBe("#010203");
  });

  it("grease waste has its own look and draws heavy unless the system says otherwise", () => {
    expect(systemStyle({ systemKind: "grease_waste" })).toMatchObject({ colour: "#6d4c1f", pattern: "solid", weight: "heavy", overridden: { weight: false } });
    expect(systemStyle({ systemKind: "grease_waste", graphics: { weight: "thin" } }).weight).toBe("thin");
    expect(systemStyle({ systemKind: "indirect_waste" })).toMatchObject({ pattern: "dashed", dash: [4, 2] });
  });
});
