/**
 * @jest-environment node
 *
 * Round 12 lane M12: an outside add-on (not first-party) moves its own kind
 * through the network adapter's `translate` face with no kernel edit. A
 * conveying add-on's elevator car carries its counterweight when a person
 * moves the car with Move; the car's new position is what a later edit keeps.
 * Without the add-on the car is refused in words and nothing changes.
 *
 * Fails on round 11's code: `translate` didn't exist on the network adapter
 * row, so Move refused the car ("can't be moved on its own").
 */
import {
  ELEMENT_KIND_POINT,
  KernelError,
  NETWORK_ADAPTER_POINT,
  executeCommand,
  freezeElements,
  recomputeDerived,
  roundVec,
  type BimElement,
  type ModelState,
  type NetworkAdapterItem,
  type TranslateFace,
} from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { PackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";

interface Placed {
  readonly id: string;
  readonly kind: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly counterweightId?: string;
}

function placed(el: BimElement | undefined): Placed | null {
  if (!el || typeof el !== "object") return null;
  const position: unknown = Reflect.get(el, "position");
  if (typeof position !== "object" || position === null) return null;
  const x: unknown = Reflect.get(position, "x");
  const y: unknown = Reflect.get(position, "y");
  if (typeof x !== "number" || typeof y !== "number") return null;
  const cw: unknown = Reflect.get(el, "counterweightId");
  return { id: el.id, kind: el.kind, position: { x, y }, ...(typeof cw === "string" ? { counterweightId: cw } : {}) };
}

const moveCar: TranslateFace = (ctx, id, delta) => {
  const car = ctx.current(id);
  const seen = placed(car);
  const kind: string = car.kind;
  if (kind !== "m12vt.car" || !seen) return false;
  if (!seen.counterweightId) throw new KernelError("unsupported_geometry", `${id} has no counterweight to carry`, [id]);
  const position = roundVec({ x: seen.position.x + delta.x, y: seen.position.y + delta.y });
  ctx.set({ ...car, position } as BimElement);
  const cw = ctx.current(seen.counterweightId as BimElement["id"]);
  const cwAt = placed(cw);
  if (cwAt) ctx.set({ ...cw, position: roundVec({ x: cwAt.position.x + delta.x, y: cwAt.position.y + delta.y }) } as BimElement);
  ctx.author({ elementId: car.id, field: "position", value: position });
  return true;
};

const CONVEYING_NETWORK: NetworkAdapterItem = { id: "m12vt.conveying", translate: moveCar };
const CONVEYING = definePack({ id: "m12vt", name: "M12 conveying", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [
  contribute(ELEMENT_KIND_POINT, [
    { kind: "m12vt.car", label: "Elevator car", nature: "physical" },
    { kind: "m12vt.counterweight", label: "Counterweight", nature: "physical" },
  ]),
  contribute(NETWORK_ADAPTER_POINT, [CONVEYING_NETWORK]),
]);

function withCar(model: ModelState): ModelState {
  const car = { id: "CAR-1", version: 1, authoredRev: {}, kind: "m12vt.car", position: { x: 1000, y: 2000 }, counterweightId: "CW-1" } as unknown as BimElement;
  const cw = { id: "CW-1", version: 1, authoredRev: {}, kind: "m12vt.counterweight", position: { x: 1000, y: 2600 } } as unknown as BimElement;
  return { ...model, elements: freezeElements({ ...model.elements, [car.id]: car, [cw.id]: cw }) };
}

describe("m12 outside add-on moves its kind through translate", () => {
  const model = withCar(recomputeDerived(createDemoModel("m12-car")).model);

  it("the car carries its counterweight, and only the car's position is authored", () => {
    const r = withPackSet(PackSet.create([CONVEYING]), () => executeCommand(model, { type: "move_elements", ids: ["CAR-1"], delta: { x: 0, y: 300 } }));
    if (!r.ok) throw new Error(r.error.message);
    expect(placed(r.model.elements["CAR-1"])?.position).toEqual({ x: 1000, y: 2300 });
    expect(placed(r.model.elements["CW-1"])?.position).toEqual({ x: 1000, y: 2900 });
    expect([...r.changedIds].sort()).toEqual(["CAR-1", "CW-1"]);
  });

  it("a move the add-on can't make is refused in its words", () => {
    const loose = { ...model, elements: freezeElements({ ...model.elements, ["CAR-2"]: { id: "CAR-2", version: 1, authoredRev: {}, kind: "m12vt.car", position: { x: 0, y: 0 } } as unknown as BimElement }) };
    const r = withPackSet(PackSet.create([CONVEYING]), () => executeCommand(loose, { type: "move_elements", ids: ["CAR-2"], delta: { x: 0, y: 300 } }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toBe("CAR-2 has no counterweight to carry");
  });

  it("without the add-on the car is refused in words and nothing changes", () => {
    const r = executeCommand(model, { type: "move_elements", ids: ["CAR-1"], delta: { x: 0, y: 300 } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toBe("m12vt.car CAR-1 belongs to an add-on that isn't loaded here, so it can't be moved");
  });
});
