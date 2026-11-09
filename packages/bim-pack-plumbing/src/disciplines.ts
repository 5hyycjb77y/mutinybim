import type { DisciplineDef, DisciplineGroup } from "@permitzip/bim-kernel";

const MEP: DisciplineGroup = { id: "mep", label: "MEP" };

/** The Plumbing and gas add-on's discipline row (stored id frozen since round 1). Its default responsible role only suggests whom to name; who is responsible is the model's responsibility record. */
export const PLUMBING_DISCIPLINES: readonly DisciplineDef[] = [{ id: "plumbing", label: "Plumbing", group: MEP, display: { colour: "#2563eb" }, defaultResponsibleRole: "Plumbing engineer of record", ifc: { systemType: "PLUMBING" } }];
