import * as THREE from "three";
import { facingRay, SurfacePicker, toSurfaceHit, type SceneSurfaceHit, type SurfaceQuery } from "../src/surface-pick";

const down = (x: number, z: number): SurfaceQuery => ({ ray: new THREE.Ray(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0)), clientX: x, clientY: z });

/** A flat slab at height y under every ray (scene metres). */
const slab = (y: number, tag: Partial<SceneSurfaceHit> = {}) => (ray: THREE.Ray): SceneSurfaceHit | null => {
  const point = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), new THREE.Vector3());
  return point ? { point, normal: new THREE.Vector3(0, 1, 0), distance: point.distanceTo(ray.origin), elementId: null, linked: null, ...tag } : null;
};

function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("SurfacePicker", () => {
  it("answers authored work at once when nothing is linked", () => {
    const picker = new SurfacePicker(slab(0, { elementId: "duct-1" }), null, () => undefined);
    const hit = picker.pick(down(2, 3));
    expect(hit?.elementId).toBe("duct-1");
    expect(hit?.point.y).toBeCloseTo(0);
  });

  it("starts a linked cast, says when it lands, and answers from it on the same ray", async () => {
    const landed = jest.fn();
    const roof = slab(6, { linked: { referenceId: "arch", localId: 42 } });
    const picker = new SurfacePicker(() => null, async (q) => roof(q.ray), landed);
    expect(picker.pick(down(1, 1))).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(landed).toHaveBeenCalledTimes(1);
    const hit = picker.pick(down(1, 1));
    expect(hit?.linked).toEqual({ referenceId: "arch", localId: 42 });
    expect(hit?.point.y).toBeCloseTo(6);
  });

  it("does not answer a moved pointer from an older ray's cast", async () => {
    const roof = slab(6, { linked: { referenceId: "arch", localId: 1 } });
    const picker = new SurfacePicker(() => null, async (q) => roof(q.ray), () => undefined);
    picker.pick(down(1, 1));
    await new Promise((r) => setTimeout(r, 0));
    expect(picker.pick(down(5, 5))).toBeNull();
  });

  it("keeps only the latest pointer while a cast is in flight, then casts it", async () => {
    const gate = deferred<SceneSurfaceHit | null>();
    const calls: number[] = [];
    const picker = new SurfacePicker(
      () => null,
      (q) => {
        calls.push(q.clientX);
        return calls.length === 1 ? gate.promise : Promise.resolve(slab(3)(q.ray));
      },
      () => undefined,
    );
    picker.pick(down(1, 0));
    picker.pick(down(2, 0));
    picker.pick(down(3, 0));
    gate.resolve(null);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([1, 3]);
    expect(picker.pick(down(3, 0))?.point.y).toBeCloseTo(3);
  });

  it("takes the nearer of authored and linked", async () => {
    const duct = slab(8, { elementId: "duct" });
    const roof = slab(6, { linked: { referenceId: "arch", localId: 1 } });
    const picker = new SurfacePicker(duct, async (q) => roof(q.ray), () => undefined);
    expect((await picker.pickAsync(down(0, 0)))?.elementId).toBe("duct");
    const under = new SurfacePicker(slab(2, { elementId: "low" }), async (q) => roof(q.ray), () => undefined);
    expect((await under.pickAsync(down(0, 0)))?.linked?.referenceId).toBe("arch");
  });

  it("pickAsync waits for the linked models on a click that beat its hover cast", async () => {
    const roof = slab(6, { linked: { referenceId: "arch", localId: 7 } });
    const picker = new SurfacePicker(() => null, async (q) => roof(q.ray), () => undefined);
    const hit = await picker.pickAsync(down(4, 4));
    expect(hit?.point.y).toBeCloseTo(6);
  });

  it("logs a failed linked cast and still answers authored work", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const picker = new SurfacePicker(slab(1, { elementId: "pipe" }), () => Promise.reject(new Error("worker gone")), () => undefined);
    expect((await picker.pickAsync(down(0, 0)))?.elementId).toBe("pipe");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("passes the accept filter to authored casts (a live preview's own pieces are looked past)", () => {
    const native = jest.fn(() => null);
    const accept = (id: string) => id !== "preview";
    new SurfacePicker(native, null, () => undefined).pick(down(0, 0), accept);
    expect(native).toHaveBeenCalledWith(expect.any(THREE.Ray), accept);
  });
});

describe("surface hit conversion", () => {
  it("turns scene metres (Y up, Z south) into kernel mm (Z up, Y north)", () => {
    const hit = toSurfaceHit({ point: new THREE.Vector3(1, 4.2, -3), normal: new THREE.Vector3(0, -1, 0), distance: 1, elementId: null, linked: null });
    expect(hit.point.x).toBeCloseTo(1000);
    expect(hit.point.y).toBeCloseTo(3000);
    expect(hit.point.z).toBeCloseTo(4200);
    expect(hit.normal?.z).toBeCloseTo(-1);
  });

  it("turns a far-side normal to face the camera", () => {
    const ray = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
    expect(facingRay(new THREE.Vector3(0, -1, 0), ray).y).toBeCloseTo(1);
    expect(facingRay(new THREE.Vector3(0, 1, 0), ray).y).toBeCloseTo(1);
  });
});

describe("SurfacePicker settled", () => {
  it("is settled at once with nothing linked shown, and answers authored work without casting", () => {
    const linked = jest.fn(async () => null);
    const picker = new SurfacePicker(slab(1, { elementId: "duct" }), linked, () => undefined, () => false);
    expect(picker.settled(down(0, 0))).toBe(true);
    expect(picker.pick(down(0, 0))?.elementId).toBe("duct");
    expect(linked).not.toHaveBeenCalled();
  });

  it("with a linked model shown, is settled only once the cast on that ray has landed", async () => {
    const picker = new SurfacePicker(() => null, async (q) => slab(6)(q.ray), () => undefined, () => true);
    expect(picker.settled(down(2, 2))).toBe(false);
    picker.pick(down(2, 2));
    await new Promise((r) => setTimeout(r, 0));
    expect(picker.settled(down(2, 2))).toBe(true);
    expect(picker.settled(down(3, 3))).toBe(false);
  });
});
