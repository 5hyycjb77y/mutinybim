/**
 * The Fire protection add-on (namespace `fire_protection`, first-party,
 * round 8): the fire protection discipline and its two children, each with
 * its own engineer of record. Stored ids are frozen: `fire_protection` has
 * been stored since round 1; a record keeps it until a person or an add-on
 * assigns one of the children on a later edit.
 *
 * Its design rows (heads, devices, hydraulics) join in a later round; until
 * then it contributes disciplines and the wet and dry sprinkler services
 * (round 14: round 13's kernel rows byte for byte).
 */
import { DISCIPLINE_POINT, LINKED_PLAN_DISPLAY_POINT, SERVICES_REGISTRY_FEATURE, SERVICE_POINT, type DisciplineDef, type DisciplineGroup, type LinkedPlanDisplayRow, type ServiceRow } from "@permitzip/bim-kernel";
import { FIRE_PROTECTION_MANIFEST, contribute, definePack, type Pack } from "@permitzip/bim-kernel/packs";

const MEP: DisciplineGroup = { id: "mep", label: "MEP" };

export const FIRE_PROTECTION_DISCIPLINES: readonly DisciplineDef[] = [
  { id: "fire_protection", label: "Fire protection", group: MEP, display: { colour: "#dc2626" }, defaultResponsibleRole: "Fire protection engineer of record", ifc: { systemType: "FIREPROTECTION" } },
  { id: "fire_alarm", label: "Fire alarm", parent: "fire_protection", group: MEP, display: { colour: "#ea580c" }, defaultResponsibleRole: "Fire alarm engineer of record", ifc: { systemType: "FIREPROTECTION", name: "Fire alarm" } },
  { id: "fire_sprinkler", label: "Fire sprinkler", parent: "fire_protection", group: MEP, display: { colour: "#b91c1c" }, defaultResponsibleRole: "Fire sprinkler engineer of record", ifc: { systemType: "FIREPROTECTION", name: "Fire sprinkler" } },
];

const dist = (predefinedType: string) => ({ system: "IfcDistributionSystem" as const, predefinedType });

/** Stored system kinds since the service registry (written only to a peer that reads `SERVICES_REGISTRY_FEATURE`). */
export const FIRE_PROTECTION_SERVICE_ROWS: readonly ServiceRow[] = [
  { id: "fire_protection_wet", label: "Fire protection, wet", discipline: "fire_protection", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("FIREPROTECTION"), graphics: { colour: "#e53935", pattern: "solid" }, feature: SERVICES_REGISTRY_FEATURE, flowUnit: "GPM" },
  { id: "fire_protection_dry", label: "Fire protection, dry", discipline: "fire_protection", medium: "liquid", regime: "pressure", connector: "pipe", quantities: ["load.gpm_fixed"], asSystem: true, asLoad: false, ifc: dist("FIREPROTECTION"), graphics: { colour: "#ef6c00", pattern: "dashed" }, feature: SERVICES_REGISTRY_FEATURE, flowUnit: "GPM" },
];

/** A linked model's sprinklers and their piping show in plans as MEP does: up to the view's top, and in ceiling plans. */
export const FIRE_PROTECTION_LINKED_PLAN_DISPLAY: readonly LinkedPlanDisplayRow[] = [
  { id: "fire_protection.heads", label: "Sprinklers and fire suppression terminals", ifcEntities: ["IFCFIRESUPPRESSIONTERMINAL"], drawAs: "symbol", cut: true, below: true, above: true, ceilingPlan: true },
];

export const FIRE_PROTECTION_PACK: Pack = definePack(FIRE_PROTECTION_MANIFEST, [contribute(DISCIPLINE_POINT, FIRE_PROTECTION_DISCIPLINES), contribute(SERVICE_POINT, FIRE_PROTECTION_SERVICE_ROWS), contribute(LINKED_PLAN_DISPLAY_POINT, FIRE_PROTECTION_LINKED_PLAN_DISPLAY)]);
