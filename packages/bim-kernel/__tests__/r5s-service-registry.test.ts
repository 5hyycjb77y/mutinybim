/**
 * @jest-environment node
 *
 * One service list (NEXT-BATCH 5b-1, KERNEL-FOUNDATION §3.5). The system
 * kinds, load services and connector domains are views of the registry with
 * the same strings in the same order; every per-kind table the kernel keeps
 * (routing rules, pipe service, primary quantity, drain sets, plumbing source
 * roles) is reproduced from the rows for every round-4 kind, so swapping a
 * table for its registry read changes no number. The added rows carry the
 * registry feature, and firm rows layer in as data. Since round 14 every
 * trade's rows are its first-party add-on's, so "the built-in rows" are
 * `firstPartyServiceRegistry()`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CONNECTOR_DOMAINS, SYSTEM_KINDS } from "../src/parts";
import { LOAD_SERVICES } from "../src/load-points/commands";
import { primaryQuantity } from "../src/load-points/model";
import { serviceOf } from "../src/routing/pipe/design";
import { systemRules } from "../src/routing/rules";
import { LEGACY_SYSTEM_KIND_IDS, REGISTRY_SYSTEM_KIND_IDS } from "../src/services/builtin";
import { serviceWriteRefusal } from "../src/services";
import {
  firstPartyServiceRegistry,
  connectorDomainIds,
  createServiceRegistry,
  drainSystemKinds,
  isKnownLoadService,
  isKnownSystemKind,
  loadServiceIds,
  pipeFamilyOf,
  primaryQuantityKeyOf,
  rawServiceLabel,
  routeServiceChoices,
  serviceById,
  serviceForLoad,
  serviceLabel,
  serviceRoutingRules,
  serviceWriteFeature,
  systemKindIds,
  systemKindsServedBy,
  systemKindsWithAdapter,
  withFirmServices,
  withServiceRows,
} from "../src/services/registry";
import { SERVICES_REGISTRY_FEATURE } from "../src/services/types";

/** The three flow lists as they were before the registry (round 4, e88144729). */
const OLD_SYSTEM_KINDS = ["supply_air", "return_air", "exhaust_air", "outside_air", "domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "vent", "storm", "natural_gas", "hydronic_supply", "hydronic_return", "condensate", "refrigerant", "power", "lighting", "data", "fire_alarm", "other"];
const OLD_LOAD_SERVICES = ["power", "cold_water", "hot_water", "sanitary", "grease_waste", "gas", "supply_air", "outside_air", "exhaust_air", "heat_gain"];
const OLD_CONNECTOR_DOMAINS = ["duct", "pipe", "electrical"];
/** `connections/plumbing/adapter.ts` PIPED and the diagram DRAIN sets before the registry. */
const OLD_PIPED = ["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "grease_waste", "natural_gas", "indirect_waste"];
const OLD_DRAIN = ["sanitary", "storm", "condensate", "grease_waste", "indirect_waste"];
const OLD_ROLE_SERVES: Record<string, readonly string[]> = {
  water_heater: ["domestic_hot_water"],
  water_meter: ["domestic_cold_water"],
  gas_meter: ["natural_gas"],
  grease_interceptor: ["sanitary"],
  sewer_connection: ["sanitary"],
  sewage_pump: ["sanitary"],
  backwater_valve: ["sanitary"],
};

describe("the three flow lists are views of one registry", () => {
  it("system kinds: the round-4 strings first, in order, then the registry's rows", () => {
    expect(LEGACY_SYSTEM_KIND_IDS).toEqual(OLD_SYSTEM_KINDS);
    expect(SYSTEM_KINDS.slice(0, OLD_SYSTEM_KINDS.length)).toEqual(OLD_SYSTEM_KINDS);
    expect(SYSTEM_KINDS.slice(OLD_SYSTEM_KINDS.length)).toEqual(["grease_waste", "indirect_waste", "fire_protection_wet", "fire_protection_dry", "chilled_water_supply", "chilled_water_return", "heating_water_supply", "heating_water_return"]);
    expect([...systemKindIds()]).toEqual([...SYSTEM_KINDS]);
  });

  it("load services and connector domains: the same strings in the same order", () => {
    expect([...LOAD_SERVICES]).toEqual(OLD_LOAD_SERVICES);
    expect([...loadServiceIds()]).toEqual(OLD_LOAD_SERVICES);
    expect([...CONNECTOR_DOMAINS]).toEqual(OLD_CONNECTOR_DOMAINS);
    expect([...connectorDomainIds()]).toEqual(OLD_CONNECTOR_DOMAINS);
  });

  it("load-service rows are carried by the system row of today's id", () => {
    expect(serviceForLoad("cold_water")?.id).toBe("domestic_cold_water");
    expect(serviceForLoad("hot_water")?.id).toBe("domestic_hot_water");
    expect(serviceForLoad("gas")?.id).toBe("natural_gas");
    expect(serviceForLoad("sanitary")?.id).toBe("sanitary");
    expect(serviceForLoad("grease_waste")?.id).toBe("grease_waste");
    expect(serviceForLoad("supply_air")?.id).toBe("supply_air");
    expect(serviceForLoad("heat_gain")).toBeNull();
    expect(serviceById("cold_water")?.carriedBy).toBe("domestic_cold_water");
  });

  it("only rows new to a view are gated on the registry feature: grease waste was always a load, it is newly a system", () => {
    for (const id of REGISTRY_SYSTEM_KIND_IDS) expect(serviceById(id)?.feature).toBe(SERVICES_REGISTRY_FEATURE);
    for (const id of OLD_SYSTEM_KINDS) expect(serviceWriteFeature(id, "system")).toBeNull();
    for (const id of OLD_LOAD_SERVICES) expect(serviceWriteFeature(id, "load")).toBeNull();
    expect(serviceWriteFeature("grease_waste", "system")).toBe(SERVICES_REGISTRY_FEATURE);
    expect(serviceById("grease_waste")?.asSystem).toBe(true);
    for (const row of firstPartyServiceRegistry().rows) if (!REGISTRY_SYSTEM_KIND_IDS.some((id) => id === row.id)) expect(row.feature).toBeUndefined();
  });

  it("every system row has an IFC distribution type; grease and indirect waste are USERDEFINED with an object type", () => {
    for (const id of SYSTEM_KINDS) expect(serviceById(id)?.ifc.predefinedType).toMatch(/^[A-Z]+$/);
    expect(serviceById("grease_waste")?.ifc).toEqual({ system: "IfcDistributionSystem", predefinedType: "USERDEFINED", objectType: "GreaseWaste" });
    expect(serviceById("indirect_waste")?.ifc).toEqual({ system: "IfcDistributionSystem", predefinedType: "USERDEFINED", objectType: "IndirectWaste" });
  });
});

/** `routing/rules.ts` SYSTEM_RULES as it was before the registry (round 4, e88144729), from its own helpers. */
type OldRules = { domain: string; discipline: string; label: string; branch: string; flowUnit: string; branchMayEqualTrunk: boolean };
const oAir = (label: string): OldRules => ({ domain: "duct", discipline: "mechanical", label, branch: "tap", flowUnit: "CFM", branchMayEqualTrunk: false });
const oWater = (label: string, discipline = "plumbing"): OldRules => ({ domain: "pipe", discipline, label, branch: "tee", flowUnit: "WFU", branchMayEqualTrunk: true });
const oDrain = (label: string): OldRules => ({ domain: "pipe", discipline: "plumbing", label, branch: "wye", flowUnit: "DFU", branchMayEqualTrunk: true });
const oWire = (label: string): OldRules => ({ domain: "conduit", discipline: "electrical", label, branch: "tee", flowUnit: "VA", branchMayEqualTrunk: true });
const OLD_RULES: Record<string, OldRules> = {
  supply_air: oAir("Supply air"), return_air: oAir("Return air"), exhaust_air: oAir("Exhaust air"), outside_air: oAir("Outside air"),
  domestic_cold_water: oWater("Domestic cold water"), domestic_hot_water: oWater("Domestic hot water"), domestic_hot_water_return: { ...oWater("Domestic hot water return"), flowUnit: "GPM" },
  sanitary: oDrain("Sanitary"), vent: oDrain("Vent"), storm: { ...oDrain("Storm"), flowUnit: "GPM" }, natural_gas: { ...oWater("Natural gas"), flowUnit: "MBH" },
  hydronic_supply: { ...oWater("Hydronic supply", "mechanical"), flowUnit: "GPM" }, hydronic_return: { ...oWater("Hydronic return", "mechanical"), flowUnit: "GPM" },
  condensate: { ...oDrain("Condensate"), discipline: "mechanical", flowUnit: "" }, refrigerant: { ...oWater("Refrigerant", "mechanical"), flowUnit: "" },
  power: oWire("Power"), lighting: oWire("Lighting"), data: { ...oWire("Data"), flowUnit: "" }, fire_alarm: { ...oWire("Fire alarm"), flowUnit: "" },
  other: { domain: "pipe", discipline: "mechanical", label: "Other", branch: "tee", flowUnit: "", branchMayEqualTrunk: true },
};

describe("built-in routing rules are byte-identical to round 4 (discipline narrowed to the six drawn disciplines)", () => {
  it("every round-4 kind, against the round-4 table written out", () => {
    for (const k of OLD_SYSTEM_KINDS) expect([k, JSON.stringify(serviceRoutingRules(k))]).toEqual([k, JSON.stringify(OLD_RULES[k])]);
  });

  it("a row of another class discipline (civil) routes as mechanical; a connector or regime this release doesn't walk is listed, not walked", () => {
    const civil = { id: "civil.storm_main", label: "Storm main", discipline: "civil" as const, medium: "liquid", regime: "gravity", connector: "pipe", adapter: "plumbing", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: { system: "IfcDistributionSystem" as const, predefinedType: "STORMWATER" } };
    const channel = { ...civil, id: "civil.open_channel", label: "Open channel", regime: "open_channel", connector: "channel" };
    const reg = withServiceRows(firstPartyServiceRegistry(), [civil, channel], { source: "pack" });
    expect(serviceRoutingRules("civil.storm_main", reg)).toMatchObject({ discipline: "mechanical", branch: "wye", domain: "pipe" });
    expect(serviceRoutingRules("civil.open_channel", reg)).toEqual({ domain: "pipe", discipline: "mechanical", label: "Open channel", branch: "tee", flowUnit: "", branchMayEqualTrunk: true });
    expect(systemKindsWithAdapter("plumbing", reg)).toContain("civil.storm_main");
    expect(systemKindsWithAdapter("plumbing", reg)).not.toContain("civil.open_channel");
    expect(drainSystemKinds(reg).has("civil.open_channel")).toBe(false);
  });

  it("solver ids are data on the rows that have a method today", () => {
    expect(["domestic_cold_water", "domestic_hot_water", "sanitary", "grease_waste", "natural_gas", "power"].map((k) => serviceById(k)?.solver)).toEqual(["hunter", "hunter", "dfu", "dfu", "gas_longest_length", "nec_demand"]);
  });
});

describe("per-kind tables reproduce from the rows for every round-4 kind (equivalence)", () => {
  it("routing rules: SYSTEM_RULES field for field", () => {
    for (const k of OLD_SYSTEM_KINDS) expect([k, serviceRoutingRules(k)]).toEqual([k, systemRules(k)]);
  });

  it("pipe service: routing/pipe/design.ts serviceOf", () => {
    for (const k of OLD_SYSTEM_KINDS) expect([k, pipeFamilyOf(k)]).toEqual([k, serviceOf(k as (typeof SYSTEM_KINDS)[number])]);
    expect(pipeFamilyOf("grease_waste")).toBe("drainage");
    expect(pipeFamilyOf("indirect_waste")).toBe("drainage");
    expect(pipeFamilyOf("fire_protection_wet")).toBeNull();
  });

  it("primary quantity: load-points/model.ts primaryQuantity", () => {
    for (const k of OLD_SYSTEM_KINDS) expect([k, primaryQuantityKeyOf(k)]).toEqual([k, primaryQuantity(k as (typeof SYSTEM_KINDS)[number])]);
    expect(primaryQuantityKeyOf("grease_waste")).toBe("dfu");
  });

  it("labels: what pickers and schedules print", () => {
    for (const k of OLD_SYSTEM_KINDS) expect(serviceLabel(k)).toBe(systemRules(k).label);
    expect(serviceLabel("grease_waste")).toBe("Grease waste");
    expect(serviceLabel("indirect_waste")).toBe("Indirect waste");
  });

  it("the plumbing adapter's piped set, the drain sets and the source roles", () => {
    expect([...systemKindsWithAdapter("plumbing")].sort()).toEqual([...OLD_PIPED].sort());
    expect([...drainSystemKinds()].sort()).toEqual([...OLD_DRAIN].sort());
    for (const [role, kinds] of Object.entries(OLD_ROLE_SERVES)) {
      const now = systemKindsServedBy(role);
      // The one change: a grease interceptor now also serves grease waste, which is a real system kind.
      expect(role === "grease_interceptor" ? now.filter((k) => k !== "grease_waste") : now).toEqual(kinds);
    }
    expect(systemKindsServedBy("grease_interceptor")).toEqual(["sanitary", "grease_waste"]);
    expect(systemKindsWithAdapter("mechanical")).toEqual(["supply_air", "return_air", "exhaust_air", "outside_air"]);
  });
});

describe("the Route tool's choices come from the registry", () => {
  it("pipe offers grease waste and indirect waste once the peer stores them, and never 'Other'", () => {
    const all = routeServiceChoices("pipe").map((c) => c.label);
    expect(all).toEqual(expect.arrayContaining(["Domestic cold water", "Sanitary", "Vent", "Storm", "Natural gas", "Grease waste", "Indirect waste"]));
    expect(all).not.toContain("Other");
    const oldServer = routeServiceChoices("pipe", (row) => row.feature === undefined).map((c) => c.kind);
    expect(oldServer).not.toContain("grease_waste");
    expect(oldServer).toContain("sanitary");
    expect(routeServiceChoices("duct").map((c) => c.kind)).toEqual(["supply_air", "return_air", "exhaust_air", "outside_air"]);
  });
});

describe("firm rows layer in as data", () => {
  const firm = withFirmServices(firstPartyServiceRegistry(), [
    { id: "firm:kitchen_hood_exhaust", label: "Kitchen hood exhaust", discipline: "mechanical", medium: "air", regime: "pressure", connector: "duct", adapter: "mechanical", quantities: ["load.cfm"], asSystem: true, asLoad: true, ifc: { system: "IfcDistributionSystem", predefinedType: "EXHAUST" } },
  ]);

  it("a firm system appears after the built-in rows, in both views, and the built-in registry is untouched", () => {
    expect(firm.systemKindIds.slice(0, SYSTEM_KINDS.length)).toEqual([...SYSTEM_KINDS]);
    expect(firm.systemKindIds.at(-1)).toBe("firm:kitchen_hood_exhaust");
    expect(firm.loadServiceIds.at(-1)).toBe("firm:kitchen_hood_exhaust");
    expect(isKnownSystemKind("firm:kitchen_hood_exhaust", firm)).toBe(true);
    expect(isKnownSystemKind("firm:kitchen_hood_exhaust")).toBe(false);
    expect(systemKindsWithAdapter("mechanical", firm)).toContain("firm:kitchen_hood_exhaust");
  });

  it("refuses a firm row that would redefine a built-in, a duplicate, a malformed id and a dangling carriedBy", () => {
    const row = firstPartyServiceRegistry().rows[0];
    if (!row) throw new Error("rows exist");
    expect(() => withFirmServices(firstPartyServiceRegistry(), [{ ...row, id: "sanitary" }])).toThrow(/firm: id/);
    expect(() => createServiceRegistry([row, row])).toThrow(/two rows/);
    expect(() => createServiceRegistry([{ ...row, id: "Bad Id" }])).toThrow(/isn't a service id/);
    expect(() => createServiceRegistry([{ ...row, id: "cw", asSystem: false, carriedBy: "nothing" }])).toThrow(/not a system row/);
  });
});

describe("a refused service offers only the services the model has", () => {
  const hood = { id: "hood_exhaust", label: "Hood exhaust", discipline: "mechanical", medium: "air", regime: "pressure", connector: "duct", adapter: "mechanical", quantities: ["load.cfm"], asSystem: true, asLoad: true, ifc: { system: "IfcDistributionSystem", predefinedType: "EXHAUST" } } as const;

  it("names the registered rows, never a trade the model lacks (Nov 4: gas was offered while gas was refused)", () => {
    const one = createServiceRegistry([hood]);
    expect(serviceWriteRefusal("gas", "load", "OV-1", one)).toBe(`OV-1 can't need "Gas": it isn't a load service this version of the model knows. Choose "hood exhaust"`);
    expect(serviceWriteRefusal("gas", "system", "Pipe 1", one)).toMatch(/Choose "hood exhaust"$/);
    expect(serviceWriteRefusal("hood_exhaust", "load", "OV-1", one)).toBeNull();
  });

  it("says no service is on when the model has none", () => {
    expect(serviceWriteRefusal("gas", "load", "OV-1", createServiceRegistry([]))).toMatch(/None are on for this model; turn on the add-on that adds them$/);
  });

  it("with the first-party add-ons, lists every load service they register", () => {
    const registry = firstPartyServiceRegistry();
    const message = serviceWriteRefusal("steam", "load", "OV-1", registry) ?? "";
    for (const id of loadServiceIds(registry)) expect(message).toContain(`"${serviceLabel(id, registry).toLowerCase()}"`);
  });
});

describe("readers tolerate ids they don't know", () => {
  it("an unknown kind reads as its own words and routes as Other pipe", () => {
    expect(serviceById("future_kind")).toBeNull();
    expect(isKnownSystemKind("future_kind")).toBe(false);
    expect(isKnownLoadService("future_kind")).toBe(false);
    expect(serviceLabel("future_kind")).toBe("Future kind");
    expect(rawServiceLabel("firm:steam_condensate")).toBe("Steam condensate");
    expect(serviceRoutingRules("future_kind")).toEqual({ domain: "pipe", discipline: "mechanical", label: "Future kind", branch: "tee", flowUnit: "", branchMayEqualTrunk: true });
    expect(pipeFamilyOf("future_kind")).toBeNull();
    expect(primaryQuantityKeyOf("future_kind")).toBeNull();
  });
});

describe("services/* is pure data at runtime (layer rule)", () => {
  it("imports nothing at runtime from connections/ (but its leaf types.ts), routing/ or load-points/", () => {
    const dir = path.resolve(__dirname, "../src/services");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(path.join(dir, file), "utf8");
      for (const m of src.matchAll(/^\s*import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
        const spec = m[2] ?? "";
        const clause = m[1] ?? "";
        if (/^\{[^}]*\}$/.test(clause.trim()) && clause.replace(/[{}]/g, "").split(",").every((n) => n.trim() === "" || n.trim().startsWith("type "))) continue;
        // connections/types.ts is a leaf (types, constants and pure link helpers): the write gate reads link shapes from it.
        expect([file, spec, /(^|\/)(connections|routing|load-points)\//.test(spec) && !/connections\/types$/.test(spec)]).toEqual([file, spec, false]);
      }
    }
  });
});
