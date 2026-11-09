import { QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { CONNECTION_SIZE_KEYS, QUANTITIES, QUANTITY_KEYS, quantityParameterKey, type QuantityKey, segmentLength3, pipeSegmentOf, resolvePipingField, command, finite, locked, resolvedNumber, resolvedText, textOrNull, type ProviderField } from "@permitzip/bim-kernel";
import type { FieldProvider } from "@permitzip/bim-kernel";
import { pipeCarriesQuantity, plumbingQuantity, systemTotalQuantity } from "../plumbing";
import { resolveStackField, STACK_FIELD_PATHS } from "../../plumbing/stack-fields";

/**
 * Plumbing fields: what a load point (or the fixture or equipment attached to
 * one) draws, its connection type, and what a pipe and its system carry.
 * Values are the load point records and the plumbing network engine's
 * totals, unrounded, in each quantity's own unit (`QUANTITY_BINDINGS`).
 */

/** Things with plumbing loads: a load point, and the fixture or equipment attached to one (a water heater is mep.equipment); an in-line pump's flow (round 15, the pump schedule). */
const LOADED = ["mep.load_point", "mep.plumbing_fixture", "mep.equipment", "mep.pipe_accessory"];
const PIPE = ["mep.pipe", "mep.run_fitting"];
const RUN = ["mep.pipe", "mep.duct", "mep.run_fitting"];

const FT = 304.8;
const IN = 25.4;

/** The quantities a pipe can carry: each system's primary quantity (`primaryQuantity`). */
const CARRIED: readonly QuantityKey[] = ["dfu", "wsfu_cold", "wsfu_hot", "mbh", "cfm", "gpm_fixed"];

const loadFields: ProviderField[] = QUANTITY_KEYS.map((q) => {
  const b = QUANTITY_BINDINGS[q];
  return {
    path: `load.${q}`,
    key: quantityParameterKey(q),
    binding: "instance",
    label: QUANTITIES[q].label,
    classes: LOADED,
    valueType: "quantity",
    kind: b.kind,
    unit: b.unit,
    aggregation: b.aggregation,
    writer: command("edit_load_point", `values.${q}`),
    deps: { elementKinds: ["load_point", "service_catalog"] },
    group: "Loads",
    read: (el, ctx) => finite(plumbingQuantity(ctx.elements, el, q)),
  } satisfies ProviderField;
});

const sizeFields: ProviderField[] = CONNECTION_SIZE_KEYS.map((k) => ({
  path: `load.size.${k}`,
  label: `${k.toUpperCase()} connection size`,
  classes: LOADED,
  valueType: "text",
  writer: locked("Set on the connection type.", "connection_type.mark"),
  group: "Connections",
  read: resolvedText(`load.size.${k}`),
}));

const connectionTypeFields: ProviderField[] = [
  { path: "connection_type.mark", label: "Connection type", classes: LOADED, valueType: "text", writer: command("edit_load_point", "connectionType"), group: "Connections", read: resolvedText("connection_type.mark") },
  { path: "connection_type.description", label: "Connection type description", classes: LOADED, valueType: "text", writer: locked("Set on the connection type.", "connection_type.mark"), group: "Connections", read: resolvedText("connection_type.description") },
];

const carriesFields: ProviderField[] = CARRIED.flatMap((q): ProviderField[] => {
  const b = QUANTITY_BINDINGS[q];
  const base = { classes: RUN, valueType: "quantity" as const, kind: b.kind, unit: b.unit, deps: { connections: true, elementKinds: ["load_point" as const, "part" as const] }, group: "Flow" };
  return [
    // A pipe's carried value is already the sum of everything below it: totalling a column of them double counts.
    { ...base, path: `pipe.carries.${q}`, label: `${QUANTITIES[q].label} the pipe carries`, aggregation: "none", writer: locked("Added up from the loads beyond this pipe."), read: (el, ctx) => finite(pipeCarriesQuantity(ctx.elements, el, q)) },
    { ...base, path: `system.total.${q}`, label: `System total (${QUANTITIES[q].label.toLowerCase()})`, aggregation: "none", writer: locked("Added up from every load on the system."), read: (el, ctx) => finite(systemTotalQuantity(ctx.elements, el, q)) },
  ];
});

const DRAWN = "Measured from the drawn pipe; edit the pipe.";

const pipeFields: ProviderField[] = [
  {
    path: "pipe.size",
    label: "Pipe nominal size",
    classes: PIPE,
    valueType: "quantity",
    kind: "length",
    unit: "in",
    aggregation: "none",
    writer: command("resize_run", "profile"),
    group: "Pipe",
    read: (el, ctx) => {
      const seg = pipeSegmentOf(ctx.elements, el.id);
      return seg?.size.shape === "pipe" ? seg.size.nominalMm / IN : null;
    },
  },
  {
    path: "pipe.length_ft",
    label: "Pipe length",
    classes: PIPE,
    valueType: "quantity",
    kind: "length",
    unit: "ft",
    writer: locked(DRAWN),
    group: "Pipe",
    read: (el, ctx) => {
      const seg = pipeSegmentOf(ctx.elements, el.id);
      return seg ? segmentLength3(seg) / FT : null;
    },
  },
  {
    path: "pipe.slope",
    label: "Pipe slope",
    classes: PIPE,
    valueType: "quantity",
    kind: "slope",
    unit: "in/ft",
    aggregation: "none",
    writer: locked(DRAWN),
    group: "Pipe",
    read: (el, ctx) => finite(resolvePipingField(ctx.elements, el.id, "pipe.slope")?.value),
  },
  ...(["invert_start", "invert_end"] as const).map(
    (end): ProviderField => ({
      path: `pipe.${end}`,
      label: end === "invert_start" ? "Invert at the start" : "Invert at the end",
      classes: PIPE,
      valueType: "quantity",
      kind: "length",
      unit: "ft",
      aggregation: "none",
      writer: locked(DRAWN),
      group: "Pipe",
      read: (el, ctx) => finite(resolvePipingField(ctx.elements, el.id, `pipe.${end}`)?.value),
    }),
  ),
  ...([["pipe.size_full", "Pipe size, spec and material"], ["pipe.length_lf", "Pipe length, as tagged"], ["pipe.flow", "What the pipe carries, as tagged"], ["pipe.system", "Pipe system"]] as const).map(
    ([path, label]): ProviderField => ({ path, label, classes: PIPE, valueType: "text", writer: locked(DRAWN), group: "Pipe", read: resolvedText(path) }),
  ),
];

const STACK_WRITER = locked("Name and number stacks in Plumbing › Stacks; size and fixture units come from the drawn pipe.");

/** A stack's fields on each of its pipes and joints (plumbing/stack-fields.ts). */
const stackFields: ProviderField[] = STACK_FIELD_PATHS.map((p): ProviderField => {
  const quantity = p.path === "stack.size" || p.path === "stack.dfu";
  return quantity
    ? { path: p.path, label: p.label, classes: PIPE, valueType: "quantity", kind: p.path === "stack.size" ? "length" : QUANTITY_BINDINGS.dfu.kind, unit: p.path === "stack.size" ? "in" : QUANTITY_BINDINGS.dfu.unit, aggregation: "none", writer: STACK_WRITER, group: "Stack", read: (el, ctx) => finite(resolveStackField(ctx.elements, el.id, p.path)?.value) }
    : { path: p.path, label: p.label, classes: PIPE, valueType: "text", writer: STACK_WRITER, group: "Stack", read: (el, ctx) => textOrNull(resolveStackField(ctx.elements, el.id, p.path)?.text) };
});

/** The water pressure loss numbers on a water pipe (`fields/water.ts`), read from the pressure solve so a schedule cell matches the sheet and the hydraulics panel. */
const SOLVED = "Read from the domestic water pressure solve.";
const waterFields: ProviderField[] = [
  ...([
    ["water.supply_psi", "Street (supply) pressure", "Set on the water system."],
    ["water.fixed_losses_psi", "Losses before the first drawn pipe", "Set on the water system."],
    ["water.elevation_psi", "Static head up to the most remote fixture", SOLVED],
    ["water.friction_psi", "Friction to the most remote fixture", SOLVED],
    ["water.residual_psi", "Pressure left at the most remote fixture", SOLVED],
    ["water.min_fixture_psi", "Pressure the most remote fixture needs", SOLVED],
  ] as const).map(([path, label, why]): ProviderField => ({ path, label, classes: PIPE, valueType: "quantity", kind: "pressure", unit: "psi", aggregation: "none", writer: locked(why), deps: { connections: true }, group: "Water", read: resolvedNumber(path) })),
  { path: "water.max_velocity_fps", label: "Highest velocity in the water system", classes: PIPE, valueType: "quantity", kind: "velocity", unit: "ft/s", aggregation: "none", writer: locked(SOLVED), deps: { connections: true }, group: "Water", read: resolvedNumber("water.max_velocity_fps") },
];

export const PLUMBING_FIELD_PROVIDER: FieldProvider = {
  id: "mep.plumbing",
  fields: [...loadFields, ...sizeFields, ...connectionTypeFields, ...carriesFields, ...pipeFields, ...stackFields, ...waterFields],
};
