import { convert, QUANTITY_BINDINGS } from "@permitzip/bim-units";
import { quantityValueLabel, type ConnectionQuantityCheckDef } from "@permitzip/bim-kernel";
import { APPLIANCE_MAX_INLET_IN_WC } from "./gas-zones";

const keepUnderPsi = () => convert(APPLIANCE_MAX_INLET_IN_WC, "in_wc", QUANTITY_BINDINGS.min_inlet_pressure.unit);

/** A gas minimum inlet pressure above what a gas outlet takes (14 in. w.c.): usually in. w.c. written as psi. */
function gasMinimumWarning(name: string, psi: number | undefined): string | null {
  const limit = keepUnderPsi();
  if (psi === undefined || psi <= limit + 1e-9) return null;
  const inWc = convert(psi, QUANTITY_BINDINGS.min_inlet_pressure.unit, "in_wc");
  const r1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return `${name}: min_inlet_pressure ${psi} is psi (${quantityValueLabel("min_inlet_pressure", psi)} = ${r1(inWc)} in. w.c.), above the ${APPLIANCE_MAX_INLET_IN_WC} in. w.c. (${r1(limit)} psi) a gas outlet takes; its zone check will fail. If you meant in. w.c., write "${psi} in. w.c."`;
}

/** Gas's check on connection quantities (`CONNECTION_QUANTITY_CHECK_POINT`): a minimum inlet pressure no gas outlet takes. */
export const GAS_MINIMUM_INLET_CHECK: ConnectionQuantityCheckDef = {
  id: "gas_minimum_inlet",
  trade: "gas",
  systemKinds: ["natural_gas"],
  warning: (name, bag) => gasMinimumWarning(name, bag.min_inlet_pressure),
};
