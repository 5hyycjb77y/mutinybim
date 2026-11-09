import type { DisciplineDef, DisciplineGroup } from "@permitzip/bim-kernel";

const MEP: DisciplineGroup = { id: "mep", label: "MEP" };

/** The Electrical add-on's discipline row (stored id frozen since round 1). Its default responsible role only suggests whom to name; who is responsible is the model's responsibility record. */
export const ELECTRICAL_DISCIPLINES: readonly DisciplineDef[] = [{ id: "electrical", label: "Electrical", group: MEP, display: { colour: "#ca8a04" }, defaultResponsibleRole: "Electrical engineer of record", ifc: { systemType: "ELECTRICAL" } }];
