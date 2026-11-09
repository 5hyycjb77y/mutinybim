/**
 * @jest-environment node
 *
 * Round 6 lane E, old vs new: electrical out of the kernel changes no byte.
 * `fixtures/c6e-goldens.json` holds sha256 digests the pre-round-6 tree
 * (7bfda9c7c, electrical in the kernel and bim-calc) computed for the same
 * inputs: two stored `place_service_layout` commands, the model each leaves,
 * the load flow at every board under NEC 2020 and 2023, the panel schedules
 * and the electrical check on the reference building. The 7903 golden
 * (82 kW = 342 A) is `e2-load-study.test.ts`, moved here unchanged.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, commandSchema, executeCommand, type ModelState } from "@permitzip/bim-kernel";
import { ElectricalLoadEngine, electricalCheck, executeServiceLayoutCommand, necElectricalRules, panelSchedule, planServiceLayout, serviceLayoutCommandSchemas, type ServiceLayoutRequest } from "@permitzip/bim-pack-electrical";
import { Building, referenceBuilding } from "../../bim-kernel/__tests__/fixtures/electrical-building";

interface Golden {
  readonly sha256: string;
  readonly length: number;
}

const GOLDENS: Readonly<Record<string, Golden>> = (JSON.parse(readFileSync(path.join(__dirname, "fixtures/c6e-goldens.json"), "utf8")) as { goldens: Record<string, Golden> }).goldens;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function expectGolden(key: string, text: string): void {
  const golden = GOLDENS[key];
  expect(golden).toBeDefined();
  expect({ key, length: text.length, sha256: sha(text) }).toEqual({ key, length: golden?.length, sha256: golden?.sha256 });
}

const REQUESTS: Readonly<Record<string, Omit<ServiceLayoutRequest, "levelId">>> = {
  small: { serviceA: 400, system: "208Y/120", equipment: [{ kind: "panel", name: "L1", fedFrom: "MDP", busA: 225, mains: "MCB" }, { kind: "panel", name: "L2", fedFrom: "MDP", busA: 100 }] },
  planned: { serviceA: 800, system: "480Y/277", planOnly: true, meter: false, equipment: [{ kind: "panel", name: "H1", fedFrom: "MDP", busA: 225 }] },
};

function reports(engine: ElectricalLoadEngine, model: Pick<ModelState, "elements">): string {
  return JSON.stringify(engine.distribution(model).map((id) => engine.report(model, id)));
}

describe("c6e: electrical goldens are identical before and after the move", () => {
  for (const [name, request] of Object.entries(REQUESTS)) {
    it(`${name} service layout: the stored command, the model it leaves and its load flow`, () => {
      const b = new Building();
      const plan = planServiceLayout(b.head, { levelId: "lvl-1", ...request });
      if (!plan.ok) throw new Error(plan.reason);
      const bytes = JSON.stringify(plan.command);
      expectGolden(`${name}.command`, bytes);
      // The kernel's command check (a pack command now) reads it exactly as the command's own schema does, as the static union did.
      const parsed = commandSchema.safeParse(JSON.parse(bytes));
      expect(parsed.success).toBe(true);
      expect(parsed.success ? JSON.stringify(parsed.data) : null).toBe(JSON.stringify(serviceLayoutCommandSchemas[0].parse(JSON.parse(bytes))));
      const done = executeCommand(b.head, plan.command);
      if (!done.ok) throw new Error(done.error.message);
      expect(GOLDENS[`${name}.elements.sha256`]?.sha256).toBe(sha(canonicalJson(done.model.elements)));
      // The kernel dispatches it to the add-on's own executor: same result as calling it directly.
      const direct = executeServiceLayoutCommand(b.head, plan.command);
      if (!direct.ok) throw new Error(direct.error.message);
      expect(canonicalJson(direct.model.elements)).toBe(canonicalJson(done.model.elements));
      expectGolden(`${name}.reports`, reports(new ElectricalLoadEngine(necElectricalRules("2023")), done.model));
    });
  }

  for (const edition of ["2020", "2023"] as const) {
    it(`reference building under NEC ${edition}: every board's load flow and panel schedule`, () => {
      const ref = referenceBuilding().head;
      const engine = new ElectricalLoadEngine(necElectricalRules(edition));
      expectGolden(`reference.nec${edition}.reports`, reports(engine, ref));
      expectGolden(`reference.nec${edition}.schedules`, JSON.stringify(engine.distribution(ref).map((id) => panelSchedule(ref.elements, id))));
    });
  }

  it("reference building: the electrical check", () => {
    const ref = referenceBuilding().head;
    expectGolden("reference.check", JSON.stringify(electricalCheck(new ElectricalLoadEngine(necElectricalRules("2023")), ref)));
  });
});
