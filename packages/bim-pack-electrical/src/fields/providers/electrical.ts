import { fieldProviderSupport, type FieldProvider, type ProviderField } from "@permitzip/bim-kernel";

const { command, instanceParam, locked, resolvedNumber, resolvedText } = fieldProviderSupport;

/**
 * Electrical fields over the shared resolver (fields/resolver.ts): the same
 * live values the one-line, panel schedules and tags print, now with a kind,
 * a unit and a writer. Readers never recompute a load; the resolver reads the
 * electrical engine.
 */

const PANEL = ["mep.electrical_equipment"];
/** Anything that can sit on a circuit. Panels inherit these from mep.equipment and read them empty. */
const POWERED = ["mep.equipment", "mep.electrical_device", "mep.lighting_fixture", "mep.plumbing_fixture", "mep.air_terminal"];
const LINK = ["mep.service_link"];

const LIVE_PANEL = "Worked out from the panel's circuits and feeder; change those instead.";
const LIVE_FEEDER = "Read from the feeder that serves it; edit the feeder.";
const LIVE_CIRCUIT = "Read from its circuit; connect it to another circuit to change it.";
const PART_TYPE = "Set on the panel's type and connectors.";

type Spec = readonly [path: string, label: string, extra?: Partial<ProviderField>];

const text = (classes: readonly string[], group: string, writer: ProviderField["writer"]) =>
  ([path, label, extra]: Spec): ProviderField => ({ path, label, classes, valueType: "text", writer, group, read: resolvedText(path), ...extra });

const quantity = (classes: readonly string[], group: string, kind: NonNullable<ProviderField["kind"]>, unit: NonNullable<ProviderField["unit"]>, writer: ProviderField["writer"]) =>
  ([path, label, extra]: Spec): ProviderField => ({ path, label, classes, valueType: "quantity", kind, unit, writer, group, read: resolvedNumber(path), ...extra });

const panelFields: ProviderField[] = [
  ...([["bus_rating", "Bus rating"], ["main_rating", "Main breaker"], ["capacity_a", "True capacity"], ["connected_a", "Connected current"], ["demand_a", "Demand current"], ["amps_a", "Phase A current"], ["amps_b", "Phase B current"], ["amps_c", "Phase C current"]] as const).map(
    quantity(PANEL, "Electrical", "current", "A", locked(LIVE_PANEL)),
  ),
  ...([["connected_kva", "Connected load"], ["demand_kva", "Demand load"], ["kva_a", "Phase A load"], ["kva_b", "Phase B load"], ["kva_c", "Phase C load"], ["kva", "Transformer rating"]] as const).map(
    quantity(PANEL, "Electrical", "power_apparent", "kVA", locked(LIVE_PANEL)),
  ),
  quantity(PANEL, "Electrical", "current", "kA", instanceParam("aic"))(["kaic", "Short-circuit rating"]),
  quantity(PANEL, "Electrical", "voltage", "V", locked(PART_TYPE))(["voltage", "Line-to-line voltage"]),
  quantity(PANEL, "Electrical", "count", "ea", locked(PART_TYPE))(["phases", "Phases"]),
  quantity(PANEL, "Electrical", "count", "ea", locked(PART_TYPE))(["wires", "Wires"]),
  quantity(PANEL, "Electrical", "count", "ea", locked(PART_TYPE))(["spaces", "Circuits / spaces"]),
  { path: "mains", label: "Mains", classes: PANEL, valueType: "choice", choices: ["MLO", "MCB"], writer: locked(PART_TYPE), group: "Electrical", read: resolvedText("mains") },
  ...([["bus", "Bus rating as printed"], ["mains_text", "Mains as printed"], ["voltage_system", "Voltage system"], ["volts", "Voltage"], ["phases_wires", "Phases and wires"], ["primary_system", "Transformer primary"], ["secondary_system", "Transformer secondary"], ["capacity", "What limits capacity"], ["rules", "Code rules"]] as const).map(
    text(PANEL, "Electrical", locked(LIVE_PANEL)),
  ),
  text(PANEL, "Electrical", instanceParam("mounting"))(["mounting", "Mounting"]),
  ...([
    ["supply_from", "Supply from"],
    ["supply.text", "Supply from as the one-line prints it"],
    ["supply.circuit", "Feeder circuit"],
    ["supply.breaker", "Feeding breaker with frame"],
    ["supply.conductors", "Feeder conductors as the one-line prints them"],
    ["feeder.source.name", "Fed from"],
    ["feeder.breaker", "Feeding breaker"],
    ["feeder.type", "Feeder type"],
    ["feeder.type.conductors", "Feeder conductors (feeder type)"],
  ] as const).map(text(PANEL, "Feeder", locked(LIVE_FEEDER))),
  quantity(PANEL, "Feeder", "length", "ft", locked(LIVE_FEEDER))(["supply.length_ft", "Feeder length"]),
];

const poweredFields: ProviderField[] = [
  ...([["circuit", "Circuit"], ["circuit.number", "Circuit number"], ["circuit.breaker", "Breaker"], ["circuit.conductors", "Conductors"], ["panel", "Panel"], ["load_class", "Load class"], ["voltage_phase", "Voltage and phase"]] as const).map(
    text(POWERED, "Electrical", locked(LIVE_CIRCUIT)),
  ),
  quantity(POWERED, "Electrical", "power_apparent", "VA", locked("Read from its connectors and connection type."))(["load", "Load"]),
  quantity(POWERED, "Electrical", "count", "ea", locked("Set on its electrical connector."))(["poles", "Poles"]),
  text(POWERED, "Electrical", instanceParam("service"))(["service", "Service (normal, fire pump, house)"]),
  text(POWERED, "Electrical", instanceParam("enclosure"))(["enclosure", "Enclosure"]),
  text(POWERED, "Identity", locked("A panel's name, else its mark, else its type; change those."))(["name", "Name"]),
];

const linkFields: ProviderField[] = [
  ...([["name", "Circuit or feeder"], ["number", "Circuit number"], ["breaker", "Breaker"], ["frame", "Frame"], ["phases", "Phases"], ["conductors", "Conductors"], ["wire_size", "Wire size"], ["material", "Conductor material"]] as const).map(
    text(LINK, "Circuit", locked("Set by its breaker, positions and conductors.")),
  ),
  text(LINK, "Circuit", command("edit_service_link", "description"))(["description", "Description"]),
  text(LINK, "Circuit", command("edit_service_link", "electrical.feederType"))(["feeder_type", "Feeder type"]),
  text(LINK, "Circuit", command("edit_service_link", "electrical.loadClass"))(["load_class", "Load class"]),
  quantity(LINK, "Circuit", "current", "A", command("edit_service_link", "electrical.ratingA"))(["rating_a", "Breaker rating"]),
  quantity(LINK, "Circuit", "length", "ft", command("edit_service_link", "electrical.lengthFt"))(["length", "Length"]),
  quantity(LINK, "Circuit", "power_apparent", "VA", locked("Added up from what is on the circuit."))(["load_va", "Load"]),
  quantity(LINK, "Circuit", "count", "ea", locked("Set by what is on the circuit."))(["poles", "Poles"]),
  quantity(LINK, "Circuit", "count", "ea", locked("Add or remove what is on the circuit."))(["members", "Connected items"]),
];

export const ELECTRICAL_FIELD_PROVIDER: FieldProvider = {
  id: "mep.electrical",
  fields: [...panelFields, ...poweredFields, ...linkFields],
};
