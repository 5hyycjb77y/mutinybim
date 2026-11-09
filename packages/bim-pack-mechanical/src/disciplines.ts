import type { DisciplineDef, DisciplineGroup } from "@permitzip/bim-kernel";

const MEP: DisciplineGroup = { id: "mep", label: "MEP" };

/** The Mechanical add-on's discipline row (stored id frozen since round 1). Its default responsible role only suggests whom to name; who is responsible is the model's responsibility record. */
export const MECHANICAL_DISCIPLINES: readonly DisciplineDef[] = [{ id: "mechanical", label: "Mechanical", group: MEP, display: { colour: "#16a34a" }, defaultResponsibleRole: "Mechanical engineer of record", ifc: { systemType: "MECHANICAL" } }];
