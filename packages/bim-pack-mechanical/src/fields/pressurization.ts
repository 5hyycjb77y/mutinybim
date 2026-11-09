import { to } from "@permitzip/bim-units";
import { makeupLoadOnUnit, pressurizationOf, type PressurizationSubtotals, type ZonePressurization } from "../balance/pressurization";
import { finite, locked, textOrNull, type BimElement, type DependencySignature, type FieldReader, type ProviderField } from "@permitzip/bim-kernel";

/**
 * Pressurization on zones and equipment (balance/pressurization.ts): a zone's
 * exhaust, makeup air, outdoor air and net with its state and target; a unit's
 * role in the balance and the makeup-air load it must carry. Spread into the
 * mechanical provider (no registration of its own). Every value is computed;
 * the writers say which input to change.
 */

type Elements = Readonly<Record<string, BimElement>>;

const ZONE = ["gen.zone"];
const EQUIPMENT = ["mep.equipment"];
const DEPS: DependencySignature = { elementKinds: ["part", "part_type", "zone", "space", "room"] };
const NET_REASON = "Exhaust out, makeup air and outdoor air in, from the parts' airflows. Change those to change this.";

function zoneOf(el: BimElement, elements: Elements): ZonePressurization | null {
  if (el.kind !== "zone") return null;
  try {
    return pressurizationOf(elements).zones.find((z) => z.zoneId === el.id) ?? null;
  } catch (err) {
    console.error("[pressurization] the balance failed on a zone; its fields read empty", { zoneId: el.id, err });
    return null;
  }
}

/** cfm to the hundredth, so canonical-unit float noise never prints as −219.99999. */
const cfm2 = (v: number): number | null => finite(Math.round(v * 100) / 100);

const subtotal = (pick: (s: PressurizationSubtotals) => number): FieldReader => (el, ctx) => {
  const z = zoneOf(el, ctx.elements);
  return z?.subtotals ? cfm2(pick(z.subtotals)) : null;
};

const flow = (path: string, label: string, read: FieldReader): ProviderField => ({
  path,
  label,
  classes: ZONE,
  valueType: "quantity",
  kind: "flow_air",
  unit: "cfm",
  aggregation: "none",
  writer: locked(NET_REASON),
  deps: DEPS,
  group: "Pressurization",
  read,
});

const text = (path: string, label: string, classes: readonly string[], read: FieldReader): ProviderField => ({
  path,
  label,
  classes,
  valueType: "text",
  writer: locked(NET_REASON),
  deps: DEPS,
  group: "Pressurization",
  read,
});

export const PRESSURIZATION_FIELDS: readonly ProviderField[] = [
  flow("pressurization.net_cfm", "Net air (in − out)", (el, ctx) => {
    const z = zoneOf(el, ctx.elements);
    return z?.balance.status === "complete" ? cfm2(to(z.balance.net, "cfm")) : null;
  }),
  flow("pressurization.exhaust_cfm", "Exhaust drawn", subtotal((s) => to(s.exhaust, "cfm"))),
  flow("pressurization.makeup_cfm", "Makeup air", subtotal((s) => to(s.makeupAir, "cfm"))),
  flow("pressurization.outdoor_cfm", "Outdoor air (units)", subtotal((s) => to(s.outdoorAir, "cfm"))),
  text("pressurization.state", "Pressure", ZONE, (el, ctx) => textOrNull(zoneOf(el, ctx.elements)?.state ?? null)),
  text("pressurization.target", "Pressure target", ZONE, (el, ctx) => textOrNull(zoneOf(el, ctx.elements)?.target?.target ?? null)),
  text("pressurization.basis", "Pressurization", ZONE, (el, ctx) => textOrNull(zoneOf(el, ctx.elements)?.text ?? null)),
  text("pressurization.role", "Air in the balance", EQUIPMENT, (el, ctx) => {
    if (el.kind !== "part") return null;
    const c = pressurizationOf(ctx.elements).contributors.find((x) => x.partId === el.id);
    return c ? (c.role === "exhaust" ? "Exhaust" : c.role === "makeup_air" ? "Makeup air" : "Outdoor air") : null;
  }),
  {
    path: "pressurization.makeup_load_btuh",
    label: "Makeup air load carried",
    classes: EQUIPMENT,
    valueType: "quantity",
    kind: "thermal_power",
    unit: "Btu/h",
    aggregation: "sum",
    writer: locked("1.08 × cfm × ΔT of the untempered makeup air entering the zones this unit serves. Change the makeup air unit's airflow or temperatures."),
    deps: DEPS,
    group: "Pressurization",
    read: (el, ctx) => {
      if (el.kind !== "part") return null;
      const load = makeupLoadOnUnit(pressurizationOf(ctx.elements), el.id);
      return load ? finite(Math.round(to(load.load, "Btu/h"))) : null;
    },
  },
];
